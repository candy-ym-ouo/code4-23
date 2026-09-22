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
  getBatch,
  resetBusinessData
} from "./helpers.js";

describe("E2E 撤销恢复", () => {
  let client: ApiClient;

  beforeEach(async () => {
    await resetBusinessData();
    client = await createAuthenticatedClient();
  });

  afterEach(async () => {
    await assertInventoryInvariants("撤销恢复");
  });

  it("撤销消耗新增 REVERSAL 流水恢复余额，历史扣减流水保留不删除", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const consumed = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "450",
      wasteQuantity: "50",
      unit: "g"
    });
    expect(consumed.status).toBe(201);

    const mid = await getBatch(client, batch.id);
    expect(mid.remainingQuantity).toBe("500.000000");

    const reversal = await client.request("POST", `/consumptions/${consumed.data.id}/reverse`, {
      body: { reason: "染坏了，回收未用染料" }
    });
    expect(reversal.status).toBe(200);
    expect(reversal.data.status).toBe("REVERSED");
    expect(reversal.data.reversalReason).toBe("染坏了，回收未用染料");
    expect(reversal.data.reversedAt).toBeTruthy();

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
    expect(detail.status).toBe("ACTIVE");
    const types = detail.movements.map((m: any) => m.type);
    expect(types).toContain("REVERSAL");
    expect(types).toContain("CONSUMPTION");
    const reversalMove = detail.movements.find((m: any) => m.type === "REVERSAL");
    expect(reversalMove.signedQuantity).toBe("500.000000");
    expect(reversalMove.beforeQuantity).toBe("500.000000");
    expect(reversalMove.afterQuantity).toBe("1000.000000");
  });

  it("同一消耗的并发重复撤销只有一次成功（消耗行锁保护）", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const consumed = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "300",
      unit: "g"
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.request("POST", `/consumptions/${consumed.data.id}/reverse`, {
          body: { reason: "并发撤销竞争" }
        })
      )
    );

    const succeeded = responses.filter((r) => r.status === 200);
    const blocked = responses.filter((r) => r.status === 409 && r.body.error.code === "ALREADY_REVERSED");
    expect(succeeded).toHaveLength(1);
    expect(blocked).toHaveLength(4);

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
    expect(detail.movements.filter((m: any) => m.type === "REVERSAL")).toHaveLength(1);
  });

  it("撤销后批次可以再次消耗，且新消耗同样可撤销", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "500", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const first = await createConsumption(client, {
      projectId: project.id, batchId: batch.id, usedQuantity: "200", unit: "g"
    });
    await client.send("POST", `/consumptions/${first.data.id}/reverse`, { body: { reason: "第一次撤销" } });

    const second = await createConsumption(client, {
      projectId: project.id, batchId: batch.id, usedQuantity: "150", unit: "g"
    });
    expect(second.status).toBe(201);
    const between = await getBatch(client, batch.id);
    expect(between.remainingQuantity).toBe("350.000000");

    await client.send("POST", `/consumptions/${second.data.id}/reverse`, { body: { reason: "第二次撤销" } });
    const restored = await getBatch(client, batch.id);
    expect(restored.remainingQuantity).toBe("500.000000");
    expect(restored.movements.filter((m: any) => m.type === "REVERSAL")).toHaveLength(2);

    const rows = await pool.query(
      "SELECT id, status FROM consumptions WHERE batch_id = $1 ORDER BY created_at",
      [batch.id]
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["REVERSED", "REVERSED"]);
  });

  it("撤销不存在的消耗返回 404，不产生任何流水", async () => {
    const response = await client.request("POST", "/consumptions/00000000-0000-0000-0000-000000000009/reverse", {
      body: { reason: "不存在的撤销尝试" }
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");

    const result = await pool.query("SELECT count(*)::int AS count FROM stock_movements WHERE type = 'REVERSAL'");
    expect(Number(result.rows[0]?.count)).toBe(0);
  });

  it("项目维度的实际用量统计只计算 ACTIVE 消耗，撤销后需求实际量归零", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const requirement = await client.send("POST", `/projects/${project.id}/requirements`, {
      body: { materialId: material.id, requiredQuantity: "800", unit: "g", purpose: "主料" }
    });
    const consumed = await createConsumption(client, {
      projectId: project.id,
      projectRequirementId: requirement.data.id,
      batchId: batch.id,
      usedQuantity: "700",
      wasteQuantity: "100",
      unit: "g"
    });

    let projectDetail = await client.send("GET", `/projects/${project.id}`);
    expect(projectDetail.data.requirements[0].actualQuantity).toBe("800.000000");

    await client.send("POST", `/consumptions/${consumed.data.id}/reverse`, { body: { reason: "统计口径验证" } });
    projectDetail = await client.send("GET", `/projects/${project.id}`);
    expect(Number(projectDetail.data.requirements[0].actualQuantity)).toBe(0);
    expect(Number(projectDetail.data.requirements[0].usedQuantity)).toBe(0);
    expect(projectDetail.data.consumptions[0].status).toBe("REVERSED");
  });
});
