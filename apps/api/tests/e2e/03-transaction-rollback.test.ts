import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/lib/db.js";
import {
  ApiClient,
  assertInventoryInvariants,
  createAuthenticatedClient,
  createBatch,
  createConsumption,
  createMaterial,
  createProject,
  createSource,
  getBatch,
  resetBusinessData
} from "./helpers.js";

/**
 * 事务回滚场景：在事务“后半段”人为制造失败，断言该事务里已执行的写入全部回滚。
 * 每个用例后再跑一遍全量库存不变量核对，任何残留写入都会暴露成具体的不变量破坏。
 */
async function counts() {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM stock_movements) AS movements,
      (SELECT count(*)::int FROM consumptions) AS consumptions,
      (SELECT count(*)::int FROM batches) AS batches,
      (SELECT count(*)::int FROM audit_logs WHERE action IN ('CONSUME', 'ADJUST', 'CREATE')) AS writes
  `);
  return result.rows[0] as { movements: number; consumptions: number; batches: number; writes: number };
}

describe("E2E 事务回滚", () => {
  let client: ApiClient;

  beforeEach(async () => {
    await resetBusinessData();
    client = await createAuthenticatedClient();
  });

  afterEach(async () => {
    await assertInventoryInvariants("事务回滚");
  });

  it("余额不足时消耗事务整体回滚：无消耗记录、无流水、余额与版本不变", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "100", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const before = await counts();

    const response = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "120",
      wasteQuantity: "0",
      unit: "g"
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("100.000000");
    expect(detail.version).toBe(batch.version);
    expect(detail.movements).toHaveLength(1); // 仅 OPENING

    const after = await counts();
    expect(after.consumptions).toBe(before.consumptions);
    expect(after.movements).toBe(before.movements);
    expect(after.writes).toBe(before.writes);

    const projectDetail = await client.send("GET", `/projects/${project.id}`);
    expect(projectDetail.data.consumptions).toHaveLength(0);
  });

  it("消耗事务内需求归属校验失败时，已写入的自动开工动作一并回滚", async () => {
    const materialA = await createMaterial(client);
    const materialB = await createMaterial(client);
    const batch = await createBatch(client, materialA.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "PLANNED" });
    // 需求挂在材料 B 上，却消耗材料 A 的批次。
    const requirement = await client.send("POST", `/projects/${project.id}/requirements`, {
      body: { materialId: materialB.id, requiredQuantity: "100", unit: "g" }
    });

    const response = await createConsumption(client, {
      projectId: project.id,
      projectRequirementId: requirement.data.id,
      batchId: batch.id,
      usedQuantity: "10",
      unit: "g"
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("INVALID_REQUIREMENT");

    const projectDetail = await client.send("GET", `/projects/${project.id}`);
    expect(projectDetail.data.status).toBe("PLANNED");
    expect(projectDetail.data.startDate).toBeNull();
    expect(projectDetail.data.consumptions).toHaveLength(0);

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
  });

  it("乐观锁版本冲突时调整事务回滚：余额、流水、版本都不变", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });

    // 先用正确版本做一次调整，使旧版本号失效。
    const first = await client.request("POST", `/batches/${batch.id}/adjustments`, {
      body: { direction: "IN", quantity: "100", unit: "g", reason: "首笔有效调整", version: batch.version }
    });
    expect(first.status).toBe(201);

    const stale = await client.request("POST", `/batches/${batch.id}/adjustments`, {
      body: { direction: "OUT", quantity: "50", unit: "g", reason: "过期版本的调整", version: batch.version }
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1100.000000");
    expect(detail.version).toBe(batch.version + 1);
    expect(detail.movements).toHaveLength(2); // OPENING + ADJUSTMENT_IN
  });

  it("批次创建引用已归档来源时回滚：批次和 OPENING 流水都不得留下", async () => {
    const material = await createMaterial(client);
    const source = await createSource(client);
    await client.send("POST", `/sources/${source.id}/archive`);
    const before = await counts();

    const response = await client.request("POST", "/batches", {
      body: {
        materialId: material.id,
        sourceId: source.id,
        receivedAt: "2026-09-01",
        initialQuantity: "500",
        entryUnit: "g"
      }
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("INVALID_SOURCE");

    const after = await counts();
    expect(after.batches).toBe(before.batches);
    expect(after.movements).toBe(before.movements);

    const list = await client.send("GET", `/materials/${material.id}/batches`);
    expect(list.data).toHaveLength(0);
  });

  it("零数量消耗在入参校验阶段被拒绝，不开启任何写事务（无消耗、无流水）", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const before = await counts();

    const response = await client.request("POST", "/consumptions", {
      body: {
        projectId: project.id,
        batchId: batch.id,
        usedQuantity: "0",
        wasteQuantity: "0",
        unit: "g"
      }
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
    const after = await counts();
    expect(after.consumptions).toBe(before.consumptions);
    expect(after.movements).toBe(before.movements);
  });
});
