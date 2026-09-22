import { describe, expect, it } from "vitest";
import { registerE2EHarness } from "./support/harness.js";
import { consume, createBatch, createMaterial, createProject, errorBody, getBatch } from "./support/fixtures.js";
/**
 * 端到端：撤销恢复
 *
 * 关键不变量：
 *  - 撤销不删除历史，而是新增一条 REVERSAL 流水（README 业务一致性）；
 *  - REVERSAL 的 after = before + total_quantity，回补数量必须等于原扣减（I7）；
 *  - 撤销后批次回到 ACTIVE（即使原来已 DEPLETED），消耗状态为 REVERSED；
 *  - 撤销本身不可重复：第二次撤销返回 409 ALREADY_REVERSED，库存不二次回补；
 *  - 撤销后可以对同一批次发起新的消耗；
 *  - 审计日志记录 REVERSE，历史 CONSUMPTION 审计仍在。
 */
describe("E2E · 撤销恢复", () => {
  const ctx = registerE2EHarness();

  it("撤销一次耗尽消耗：批次恢复 ACTIVE，余额回到初始值，流水为追加式", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "300" });
    const project = await createProject(ctx);

    const consumeResponse = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "250",
      wasteQuantity: "50",
      unit: "g"
    });
    expect(consumeResponse.statusCode, consumeResponse.body).toBe(201);
    const consumptionId = (consumeResponse.json() as { data: { id: string } }).data.id;
    const depleted = await getBatch(ctx, batch.id);
    expect(depleted.remainingQuantity).toBe("0.000000");
    expect(depleted.status).toBe("DEPLETED");

    const reverse = await ctx.request("POST", `/api/v1/consumptions/${consumptionId}/reverse`, {
      body: { reason: "E2E 用量记录有误，撤销恢复" }
    });
    expect(reverse.statusCode, reverse.body).toBe(200);
    const reversedData = reverse.json() as { data: { status: string; reversedAt: string; reversalReason: string } };
    expect(reversedData.data.status).toBe("REVERSED");
    expect(reversedData.data.reversalReason).toContain("撤销");

    const recovered = await getBatch(ctx, batch.id);
    expect(recovered.remainingQuantity).toBe("300.000000");
    expect(recovered.status).toBe("ACTIVE");

    // 历史不删除：原消耗仍可查询，但状态为 REVERSED。
    const detail = await ctx.request("GET", `/api/v1/consumptions/${consumptionId}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { data: { status: string } }).data.status).toBe("REVERSED");

    // 流水顺序：OPENING、CONSUMPTION、REVERSAL（追加而非修改）。
    const movements = await ctx.pool.query<{ type: string; after: string; signed: string }>(
      `SELECT type, after_quantity::text AS after, signed_quantity::text AS signed
         FROM stock_movements WHERE batch_id = $1 ORDER BY created_at, id`,
      [batch.id]
    );
    expect(movements.rows.map((row) => row.type)).toEqual(["OPENING", "CONSUMPTION", "REVERSAL"]);
    expect(movements.rows[2]?.signed).toBe("300.000000");
    expect(movements.rows[2]?.after).toBe("300.000000");
    await ctx.assertInvariants("耗尽后撤销恢复");
  });

  it("重复撤销被拒绝，库存不会第二次回补", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "100" });
    const project = await createProject(ctx);

    const consumeResponse = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "40",
      wasteQuantity: "0",
      unit: "g"
    });
    const consumptionId = (consumeResponse.json() as { data: { id: string } }).data.id;

    const firstReverse = await ctx.request("POST", `/api/v1/consumptions/${consumptionId}/reverse`, {
      body: { reason: "E2E 第一次撤销" }
    });
    expect(firstReverse.statusCode).toBe(200);

    const secondReverse = await ctx.request("POST", `/api/v1/consumptions/${consumptionId}/reverse`, {
      body: { reason: "E2E 第二次撤销" }
    });
    expect(secondReverse.statusCode).toBe(409);
    expect(errorBody(secondReverse).code).toBe("ALREADY_REVERSED");

    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("100.000000");
    const reversalCount = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM stock_movements WHERE type = 'REVERSAL' AND batch_id = $1",
      [batch.id]
    );
    expect(Number(reversalCount.rows[0]?.count)).toBe(1);
    await ctx.assertInvariants("重复撤销被拒绝");
  });

  it("撤销恢复后允许对同一批次发起新的消耗，重新走完整账本", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "200" });
    const project = await createProject(ctx);

    const first = await consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "200", wasteQuantity: "0", unit: "g" });
    const consumptionId = (first.json() as { data: { id: string } }).data.id;
    await ctx.request("POST", `/api/v1/consumptions/${consumptionId}/reverse`, { body: { reason: "E2E 撤销以便重新领料" } });
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("200.000000");

    const second = await consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "120", wasteQuantity: "30", unit: "g" });
    expect(second.statusCode, second.body).toBe(201);

    const finalBatch = await getBatch(ctx, batch.id);
    expect(finalBatch.remainingQuantity).toBe("50.000000");
    expect(finalBatch.status).toBe("ACTIVE");

    // 原消耗 REVERSED、新消耗 ACTIVE 同时存在。
    const statuses = await ctx.pool.query<{ status: string }>(
      "SELECT status FROM consumptions WHERE batch_id = $1 ORDER BY created_at",
      [batch.id]
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["REVERSED", "ACTIVE"]);
    await ctx.assertInvariants("撤销后重新消耗");
  });

  it("撤销原因过短被校验拒绝，消耗保持 ACTIVE 且库存不变", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "100" });
    const project = await createProject(ctx);

    const consumeResponse = await consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "10", wasteQuantity: "0", unit: "g" });
    const consumptionId = (consumeResponse.json() as { data: { id: string } }).data.id;

    const reverse = await ctx.request("POST", `/api/v1/consumptions/${consumptionId}/reverse`, { body: { reason: "错" } });
    expect(reverse.statusCode).toBe(422);
    expect(errorBody(reverse).code).toBe("VALIDATION_ERROR");
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("90.000000");

    const status = await ctx.pool.query<{ status: string }>("SELECT status FROM consumptions WHERE id = $1", [consumptionId]);
    expect(status.rows[0]?.status).toBe("ACTIVE");
    await ctx.assertInvariants("撤销校验失败");
  });
});
