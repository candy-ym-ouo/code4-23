import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/lib/db.js";
import {
  ApiClient,
  assertInventoryInvariants,
  createAnonymousClient,
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
 * 数据隔离（单租户模型下）：
 * - 未认证请求必须被挡在所有业务接口之外；
 * - 实体之间不得跨边界串接（A 项目不能用挂在 B 项目下的需求，材料同理）；
 * - 已归档实体不得再参与业务；
 * - 过滤/搜索不得泄露不属于筛选范围的数据。
 */
describe("E2E 数据隔离", () => {
  let client: ApiClient;

  beforeEach(async () => {
    await resetBusinessData();
    client = await createAuthenticatedClient();
  });

  afterEach(async () => {
    await assertInventoryInvariants("数据隔离");
  });

  it("未认证请求无法读写任何业务数据，且不产生副作用", async () => {
    const anonymous = await createAnonymousClient();

    const probes = [
      anonymous.request("GET", "/batches"),
      anonymous.request("GET", "/materials"),
      anonymous.request("GET", "/projects"),
      anonymous.request("GET", "/consumptions"),
      anonymous.request("POST", "/materials", { body: { name: "越权材料", craftTypes: ["GENERAL"], stockUnit: "g" } }),
      anonymous.request("POST", "/batches", {
        body: { materialId: "00000000-0000-0000-0000-000000000001", receivedAt: "2026-09-01", initialQuantity: "1", entryUnit: "g" }
      })
    ];
    const responses = await Promise.all(probes);
    for (const response of responses) {
      expect(response.status).toBe(401);
    }

    const result = await pool.query(
      `SELECT (SELECT count(*)::int FROM materials) AS materials,
              (SELECT count(*)::int FROM batches) AS batches,
              (SELECT count(*)::int FROM stock_movements) AS movements`
    );
    expect(result.rows[0]).toEqual({ materials: 0, batches: 0, movements: 0 });
  });

  it("消耗不能引用属于其他项目的需求（项目边界）", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const projectA = await createProject(client, { name: "项目A", status: "IN_PROGRESS", startDate: "2026-09-01" });
    const projectB = await createProject(client, { name: "项目B", status: "IN_PROGRESS", startDate: "2026-09-01" });
    const requirementInB = await client.send("POST", `/projects/${projectB.id}/requirements`, {
      body: { materialId: material.id, requiredQuantity: "500", unit: "g" }
    });

    const response = await createConsumption(client, {
      projectId: projectA.id,
      projectRequirementId: requirementInB.data.id,
      batchId: batch.id,
      usedQuantity: "100",
      unit: "g"
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("INVALID_REQUIREMENT");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
    const detailA = await client.send("GET", `/projects/${projectA.id}`);
    expect(detailA.data.consumptions).toHaveLength(0);
  });

  it("需求材料与批次材料不一致时拒绝（材料边界）", async () => {
    const materialA = await createMaterial(client);
    const materialB = await createMaterial(client);
    const batchOfA = await createBatch(client, materialA.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const requirementForB = await client.send("POST", `/projects/${project.id}/requirements`, {
      body: { materialId: materialB.id, requiredQuantity: "300", unit: "g" }
    });

    const response = await createConsumption(client, {
      projectId: project.id,
      projectRequirementId: requirementForB.data.id,
      batchId: batchOfA.id,
      usedQuantity: "300",
      unit: "g"
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("INVALID_REQUIREMENT");
    expect((await getBatch(client, batchOfA.id)).remainingQuantity).toBe("1000.000000");
  });

  it("已归档材料的批次既不能继续消耗也不能撤销恢复", async () => {
    // 准备一个已撤销过的批次，材料耗尽后归档，验证历史数据与新操作的双重隔离。
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "300", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const consumed = await createConsumption(client, {
      projectId: project.id, batchId: batch.id, usedQuantity: "300", unit: "g"
    });
    expect(consumed.status).toBe(201);

    // 批次余额为 0 才能归档材料；先撤销会让材料重新有库存而无法归档，因此先归档再尝试撤销。
    const archiveMaterial = await client.request("POST", `/materials/${material.id}/archive`);
    expect(archiveMaterial.status).toBe(200);

    const newConsumption = await createConsumption(client, {
      projectId: project.id, batchId: batch.id, usedQuantity: "1", unit: "g"
    });
    expect(newConsumption.status).toBe(409);
    expect(newConsumption.body.error.code).toBe("MATERIAL_ARCHIVED");

    const reverse = await client.request("POST", `/consumptions/${consumed.data.id}/reverse`, {
      body: { reason: "归档后尝试撤销" }
    });
    expect(reverse.status).toBe(409);
    expect(reverse.body.error.code).toBe("MATERIAL_ARCHIVED");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("0.000000");

    // 归档材料默认列表不展示，显式归档筛选才可查。
    const visible = await client.send("GET", "/materials?pageSize=100");
    expect(visible.data.find((m: any) => m.id === material.id)).toBeUndefined();
    const archived = await client.send("GET", "/materials?archived=true");
    expect(archived.data.some((m: any) => m.id === material.id)).toBe(true);
  });

  it("归档来源不能用于新批次，但既存批次仍可正常追踪", async () => {
    const source = await createSource(client);
    const material = await createMaterial(client);
    const existing = await createBatch(client, material.id, { sourceId: source.id, initialQuantity: "400", entryUnit: "g" });
    await client.send("POST", `/sources/${source.id}/archive`);

    const blocked = await client.request("POST", "/batches", {
      body: {
        materialId: material.id,
        sourceId: source.id,
        receivedAt: "2026-09-02",
        initialQuantity: "100",
        entryUnit: "g"
      }
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("INVALID_SOURCE");

    // 历史批次的来源追溯不被归档动作切断。
    const detail = await getBatch(client, existing.id);
    expect(detail.sourceId).toBe(source.id);
    expect(detail.sourceName).toBe(source.name);
  });

  it("列表过滤严格按实体边界返回：项目 A 的消耗不出现在项目 B 视图", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "2000", entryUnit: "g" });
    const projectA = await createProject(client, { name: "隔离项目A", status: "IN_PROGRESS", startDate: "2026-09-01" });
    const projectB = await createProject(client, { name: "隔离项目B", status: "IN_PROGRESS", startDate: "2026-09-01" });

    const [inA, inB] = await Promise.all([
      createConsumption(client, { projectId: projectA.id, batchId: batch.id, usedQuantity: "100", unit: "g" }),
      createConsumption(client, { projectId: projectB.id, batchId: batch.id, usedQuantity: "200", unit: "g" })
    ]);
    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);

    const listA = await client.send("GET", `/consumptions?projectId=${projectA.id}`);
    const listB = await client.send("GET", `/consumptions?projectId=${projectB.id}`);
    expect(listA.meta.total).toBe(1);
    expect(listB.meta.total).toBe(1);
    expect(listA.data[0].projectId).toBe(projectA.id);
    expect(listB.data[0].projectId).toBe(projectB.id);

    const detailA = await client.send("GET", `/projects/${projectA.id}`);
    const detailB = await client.send("GET", `/projects/${projectB.id}`);
    const totalsA = detailA.data.consumptions.map((c: any) => c.totalQuantity);
    const totalsB = detailB.data.consumptions.map((c: any) => c.totalQuantity);
    expect(totalsA).toEqual(["100.000000"]);
    expect(totalsB).toEqual(["200.000000"]);
  });

  it("不存在的实体主键一律 404，不泄露其他记录的存在性与内容", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "100", entryUnit: "g" });
    const project = await createProject(client);
    const unknownId = "00000000-0000-0000-0000-000000000abc";

    for (const path of [`/batches/${unknownId}`, `/projects/${unknownId}`, `/consumptions/${unknownId}`, `/sources/${unknownId}`]) {
      const response = await client.request("GET", path);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }

    // 给不存在的批次挂调整，同样不能影响任何真实批次。
    const adjust = await client.request("POST", `/batches/${unknownId}/adjustments`, {
      body: { direction: "IN", quantity: "50", unit: "g", reason: "幽灵批次调整", version: 1 }
    });
    expect(adjust.status).toBe(404);
    expect((await getBatch(client, batch.id)).remainingQuantity).toBe("100.000000");
    expect(project.id).toBeTruthy();
  });
});
