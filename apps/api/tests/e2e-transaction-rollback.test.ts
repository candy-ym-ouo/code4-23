import { describe, expect, it } from "vitest";
import { registerE2EHarness } from "./support/harness.js";
import { consume, createBatch, createMaterial, createProject, errorBody, getBatch } from "./support/fixtures.js";

/**
 * 端到端：事务回滚
 *
 * 消耗事务依次写入：projects（可能自动启动）→ consumptions → stock_movements
 * → 更新 batches 余额 → audit_logs。任何一步失败，前面的写入必须全部回滚。
 *
 * 关键不变量：
 *  - 失败请求不得留下半截消耗/流水（I1/I3/I7 兜底）；
 *  - 失败事务不得推进 batches.version；
 *  - 失败事务不得写入 audit_logs（审计只追加成功的业务动作）；
 *  - PLANNED 项目自动启动若与消耗同事务失败，项目状态必须保持 PLANNED。
 */
describe("E2E · 事务回滚", () => {
  const ctx = registerE2EHarness();

  it("库存不足时整个消耗事务回滚：无消耗、无流水、无审计、版本不变", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "100" });
    const project = await createProject(ctx);

    const before = await ctx.invariantSnapshot();
    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "80",
      wasteQuantity: "30", // 合计 110 > 100
      unit: "g"
    });
    expect(response.statusCode).toBe(409);
    expect(errorBody(response).code).toBe("INSUFFICIENT_STOCK");

    const refreshed = await getBatch(ctx, batch.id);
    expect(refreshed.remainingQuantity).toBe("100.000000");
    expect(refreshed.version).toBe(batch.version);

    const consumptionCount = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM consumptions WHERE batch_id = $1",
      [batch.id]
    );
    expect(Number(consumptionCount.rows[0]?.count)).toBe(0);
    const movementCount = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM stock_movements WHERE batch_id = $1 AND type <> 'OPENING'",
      [batch.id]
    );
    expect(Number(movementCount.rows[0]?.count)).toBe(0);

    const after = await ctx.invariantSnapshot();
    expect(after.auditCount, "失败事务不得写入审计日志").toBe(before.auditCount);
    // 余额扣减发生在事务内部（version+1），回滚后版本必须恢复。
    expect(refreshed.status).toBe("ACTIVE");
    await ctx.assertInvariants("库存不足回滚");
  });

  it("PLANNED 项目自动开始后若扣减失败，项目状态一并回滚为 PLANNED", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "10" });
    const project = await createProject(ctx, { status: "PLANNED" });

    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "100",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(response.statusCode).toBe(409);
    expect(errorBody(response).code).toBe("INSUFFICIENT_STOCK");

    const projectRow = await ctx.pool.query<{ status: string; version: number }>(
      "SELECT status, version FROM projects WHERE id = $1",
      [project.id]
    );
    expect(projectRow.rows[0]?.status).toBe("PLANNED");
    expect(projectRow.rows[0]?.version).toBe(1);

    const autoStartAudit = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_logs WHERE action = 'AUTO_START'"
    );
    expect(Number(autoStartAudit.rows[0]?.count)).toBe(0);
    await ctx.assertInvariants("自动启动随扣减一起回滚");
  });

  it("消耗引用不属于该项目/材料的需求时，事务回滚", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const project = await createProject(ctx);
    // 另一个项目的需求 UUID（不存在），触发 INVALID_REQUIREMENT 之前已经锁过项目/批次。
    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      projectRequirementId: "11111111-1111-4111-8111-111111111111",
      usedQuantity: "10",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(response.statusCode).toBe(422);
    expect(errorBody(response).code).toBe("INVALID_REQUIREMENT");
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("1000.000000");
    const rows = await ctx.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM consumptions");
    expect(Number(rows.rows[0]?.count)).toBe(0);
    await ctx.assertInvariants("无效需求回滚");
  });

  it("对已归档批次的消耗在写消耗前被拒绝，批次保持 ARCHIVED", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "100" });
    // 先通过调整把库存调到 0（真实 API 路径），再归档。
    const adjust = await ctx.request("POST", `/api/v1/batches/${batch.id}/adjustments`, {
      body: { direction: "OUT", quantity: "100", unit: "g", reason: "E2E 归档前清零", version: batch.version }
    });
    expect(adjust.statusCode, adjust.body).toBe(201);
    const archive = await ctx.request("POST", `/api/v1/batches/${batch.id}/archive`, { body: {} });
    expect(archive.statusCode, archive.body).toBe(200);

    const project = await createProject(ctx);
    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "1",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(response.statusCode).toBe(409);
    expect(errorBody(response).code).toBe("BATCH_ARCHIVED");

    const row = await ctx.pool.query<{ status: string; remaining: string }>(
      "SELECT status, remaining_quantity::text AS remaining FROM batches WHERE id = $1",
      [batch.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "ARCHIVED", remaining: "0.000000" });
    await ctx.assertInvariants("归档批次拒绝消耗");
  });
});
