import { describe, expect, it } from "vitest";
import { consume, createBatch, createMaterial, createProject, errorBody, getBatch } from "./support/fixtures.js";
import { registerE2EHarness } from "./support/harness.js";

/**
 * 端到端：并发扣减
 *
 * 关键不变量：
 *  - 批次行使用 SELECT ... FOR UPDATE 串行化，余额绝不允许小于 0（I4）；
 *  - 超卖时只有库存能覆盖的请求成功（I3：流水重放必须等于余额）；
 *  - 恰好扣完时状态转为 DEPLETED 且 remaining = 0（I5）。
 */
describe("E2E · 并发扣减", () => {
  const ctx = registerE2EHarness();

  it("并发扣减总额恰好等于库存：全部成功且批次恰好耗尽", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const project = await createProject(ctx);

    // 10 个并发请求各扣 100 g，合计 1000 g。
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "100", wasteQuantity: "0", unit: "g" })
      )
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);

    const refreshed = await getBatch(ctx, batch.id);
    expect(refreshed.remainingQuantity).toBe("0.000000");
    expect(refreshed.status).toBe("DEPLETED");

    const movements = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM stock_movements WHERE batch_id = $1 AND type = 'CONSUMPTION'",
      [batch.id]
    );
    expect(Number(movements.rows[0]?.count)).toBe(10);
    await ctx.assertInvariants("并发恰好扣尽");
  });

  it("并发超额扣减：成功请求数受库存约束，失败请求不扣减、余额不为负", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "250" });
    const project = await createProject(ctx);

    // 5 个并发各请求 60 g：库存只够 4 个（240 g），第 5 个必须收到 409。
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "60", wasteQuantity: "0", unit: "g" })
      )
    );
    const succeeded = responses.filter((response) => response.statusCode === 201);
    const failed = responses.filter((response) => response.statusCode === 409);
    expect(succeeded).toHaveLength(4);
    expect(failed).toHaveLength(1);
    expect(errorBody(failed[0]!)).toMatchObject({ code: "INSUFFICIENT_STOCK" });

    const refreshed = await getBatch(ctx, batch.id);
    expect(refreshed.remainingQuantity).toBe("10.000000");
    expect(refreshed.status).toBe("ACTIVE");

    // 失败请求不得产生消耗记录。
    const consumptionRows = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM consumptions WHERE batch_id = $1",
      [batch.id]
    );
    expect(Number(consumptionRows.rows[0]?.count)).toBe(4);
    await ctx.assertInvariants("并发超额扣减");
  });

  it("并发扣减与反向撤销交错后，余额仍等于流水重放结果", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "500" });
    const project = await createProject(ctx);

    const first = await consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "200", wasteQuantity: "0", unit: "g" });
    expect(first.statusCode, first.body).toBe(201);
    const consumptionId = (first.json() as { data: { id: string } }).data.id;

    // 同时：撤销第一次消耗（+200）与两个新扣减（-150、-150）。
    const [reversal, second, third] = await Promise.all([
      ctx.request("POST", `/api/v1/consumptions/${consumptionId}/reverse`, { body: { reason: "E2E 并发交错撤销" } }),
      consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "150", wasteQuantity: "0", unit: "g" }),
      consume(ctx, { projectId: project.id, batchId: batch.id, usedQuantity: "150", wasteQuantity: "0", unit: "g" })
    ]);
    expect(reversal.statusCode, reversal.body).toBe(200);
    expect(second.statusCode === 201 || second.statusCode === 409).toBe(true);
    expect(third.statusCode === 201 || third.statusCode === 409).toBe(true);

    // 500 - 200 + 200 = 500，再扣两笔 150：库存足够，两笔都应成功。
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(201);
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("200.000000");

    const reversalRow = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM stock_movements WHERE type = 'REVERSAL' AND batch_id = $1",
      [batch.id]
    );
    expect(Number(reversalRow.rows[0]?.count)).toBe(1);
    await ctx.assertInvariants("扣减与撤销交错");
  });
});
