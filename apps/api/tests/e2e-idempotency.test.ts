import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerE2EHarness } from "./support/harness.js";
import { consume, createBatch, createMaterial, createProject, errorBody, getBatch } from "./support/fixtures.js";

/**
 * 端到端：幂等重试
 *
 * 关键不变量：
 *  - 同一 Idempotency-Key 的重试（串行或并发）只能产生一次业务副作用
 *    （I8：一条幂等键至多一条流水）；
 *  - 重试返回首次创建的同一资源，HTTP 200 而非 201；
 *  - 即使请求体不同，幂等键相同也必须回放首次结果，不能产生第二次扣减。
 */
describe("E2E · 幂等重试", () => {
  const ctx = registerE2EHarness();

  it("串行重试相同 Idempotency-Key 只扣减一次并回放同一消耗记录", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const project = await createProject(ctx);
    const key = `e2e-key-${randomUUID()}`;
    const payload = { projectId: project.id, batchId: batch.id, usedQuantity: "100", wasteQuantity: "10", unit: "g" };

    const first = await consume(ctx, payload, { "idempotency-key": key });
    expect(first.statusCode, first.body).toBe(201);
    const firstData = (first.json() as { data: { id: string } }).data;

    const retry = await consume(ctx, payload, { "idempotency-key": key });
    expect(retry.statusCode).toBe(200);
    const retryData = (retry.json() as { data: { id: string } }).data;
    expect(retryData.id).toBe(firstData.id);

    // 第三次、不同请求体：仍必须回放，禁止第二次扣减。
    const differentBody = { ...payload, usedQuantity: "999", wasteQuantity: "0" };
    const replay = await consume(ctx, differentBody, { "idempotency-key": key });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { data: { id: string } }).data.id).toBe(firstData.id);

    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("890.000000");

    const count = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM consumptions c
         JOIN stock_movements m ON m.reference_type = 'CONSUMPTION' AND m.reference_id = c.id
        WHERE m.idempotency_key = $1`,
      [key]
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
    await ctx.assertInvariants("串行幂等重试");
  });

  it("并发发送相同 Idempotency-Key 时只有一个请求实际扣减", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const project = await createProject(ctx);
    const key = `e2e-concurrent-${randomUUID()}`;
    const payload = { projectId: project.id, batchId: batch.id, usedQuantity: "300", wasteQuantity: "0", unit: "g" };

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => consume(ctx, payload, { "idempotency-key": key }))
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    // 恰好一个 201，其余都是 200 回放。
    expect(statuses[0]).toBe(200);
    expect(statuses[statuses.length - 1]).toBe(201);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);

    const ids = new Set(
      responses.map((response) => (response.json() as { data: { id: string } }).data.id)
    );
    expect(ids.size).toBe(1);

    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("700.000000");
    await ctx.assertInvariants("并发幂等重试");
  });

  it("幂等保护同样适用于批次入库", async () => {
    const material = await createMaterial(ctx);
    const key = `e2e-batch-${randomUUID()}`;
    const body = {
      materialId: material.id,
      batchCode: "IDEM-BATCH",
      receivedAt: "2026-09-01",
      initialQuantity: "250",
      entryUnit: "g"
    };
    const first = await ctx.request("POST", "/api/v1/batches", { body, headers: { "idempotency-key": key } });
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as { data: { id: string } }).data.id;

    const retry = await ctx.request("POST", "/api/v1/batches", {
      body: { ...body, initialQuantity: "999" },
      headers: { "idempotency-key": key }
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { data: { id: string } }).data.id).toBe(firstId);

    const batches = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM batches WHERE material_id = $1",
      [material.id]
    );
    expect(Number(batches.rows[0]?.count)).toBe(1);
    expect((await getBatch(ctx, firstId)).initialQuantity).toBe("250.000000");
    await ctx.assertInvariants("批次入库幂等");
  });

  it("非法 Idempotency-Key 被拒绝且不产生任何副作用", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const project = await createProject(ctx);

    const blank = await consume(
      ctx,
      { projectId: project.id, batchId: batch.id, usedQuantity: "1", wasteQuantity: "0", unit: "g" },
      { "idempotency-key": "   " }
    );
    expect(blank.statusCode).toBe(422);
    expect(errorBody(blank).code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("1000.000000");
    await ctx.assertInvariants("非法幂等键");
  });
});
