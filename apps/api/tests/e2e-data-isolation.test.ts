import { describe, expect, it } from "vitest";
import { registerE2EHarness } from "./support/harness.js";
import { consume, createBatch, createMaterial, createProject, getBatch } from "./support/fixtures.js";

/**
 * 端到端：数据隔离
 *
 * 本系统是单操作员应用，没有多租户概念，这里的“数据隔离”指：
 *  - 资源隔离：对批次 A 的扣减/撤销绝不影响批次 B 的余额与流水（I3 分批次成立）；
 *  - 查询隔离：按 batchId/materialId/projectId 过滤时不串数据；
 *  - 鉴权边界：未认证请求不能读取或修改任何业务数据；
 *  - 测试隔离：每个用例从空业务表开始，上一个用例的数据不得泄漏（harness 在
 *    beforeEach 执行 TRUNCATE ... CASCADE）。
 *
 * 任何隔离断言失败都会附带具体被破坏的不变量标识（见 support/harness.ts）。
 */
describe("E2E · 数据隔离", () => {
  const ctx = registerE2EHarness();

  it("对批次 A 的扣减与撤销不影响批次 B（同材料、不同批次）", async () => {
    const material = await createMaterial(ctx);
    const batchA = await createBatch(ctx, material.id, { initialQuantity: "1000", batchCode: "ISOL-A" });
    const batchB = await createBatch(ctx, material.id, { initialQuantity: "500", batchCode: "ISOL-B" });
    const project = await createProject(ctx);

    const consumeA = await consume(ctx, { projectId: project.id, batchId: batchA.id, usedQuantity: "300", wasteQuantity: "20", unit: "g" });
    expect(consumeA.statusCode, consumeA.body).toBe(201);
    const consumptionAId = (consumeA.json() as { data: { id: string } }).data.id;

    // B 的余额、版本、流水完全不动。
    expect((await getBatch(ctx, batchB.id)).remainingQuantity).toBe("500.000000");
    const bMovements = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM stock_movements WHERE batch_id = $1",
      [batchB.id]
    );
    expect(Number(bMovements.rows[0]?.count)).toBe(1); // 仅 OPENING

    await ctx.request("POST", `/api/v1/consumptions/${consumptionAId}/reverse`, { body: { reason: "E2E 隔离验证撤销 A" } });
    expect((await getBatch(ctx, batchA.id)).remainingQuantity).toBe("1000.000000");
    expect((await getBatch(ctx, batchB.id)).remainingQuantity).toBe("500.000000");

    const crossContamination = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stock_movements
        WHERE reference_id = $1 AND batch_id <> $2`,
      [consumptionAId, batchA.id]
    );
    expect(Number(crossContamination.rows[0]?.count)).toBe(0);
    await ctx.assertInvariants("批次间隔离");
  });

  it("不同材料、不同单位的批次互不影响，列表过滤按 materialId 严格隔离", async () => {
    const grams = await createMaterial(ctx, { name: "隔离材料-克", stockUnit: "g" });
    const meters = await createMaterial(ctx, { name: "隔离材料-米", stockUnit: "m" });
    const gramBatch = await createBatch(ctx, grams.id, { initialQuantity: "100", batchCode: "G-ISOL" });
    const meterBatch = await createBatch(ctx, meters.id, { initialQuantity: "3", entryUnit: "m", batchCode: "M-ISOL" });

    const gramList = await ctx.request("GET", `/api/v1/batches?materialId=${grams.id}`);
    expect(gramList.statusCode).toBe(200);
    const gramIds = ((gramList.json() as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
    expect(gramIds).toEqual([gramBatch.id]);
    expect(gramIds).not.toContain(meterBatch.id);

    const meterList = await ctx.request("GET", `/api/v1/batches?materialId=${meters.id}`);
    expect((meterList.json() as { data: unknown[] }).data).toHaveLength(1);

    // 流水也按批次隔离：meterBatch 只有 OPENING，单位 m；查不到克批次的任何流水。
    const meterMovements = await ctx.request("GET", `/api/v1/batches/${meterBatch.id}/movements`);
    const movements = (meterMovements.json() as { data: Array<{ stockUnit: string; type: string }> }).data;
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe("OPENING");
    expect(movements[0]?.stockUnit).toBe("m");
    await ctx.assertInvariants("材料/单位隔离");
  });

  it("消耗列表按 projectId / batchId 过滤时不串项目数据", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const projectOne = await createProject(ctx, { name: "隔离项目一" });
    const projectTwo = await createProject(ctx, { name: "隔离项目二" });

    const first = await consume(ctx, { projectId: projectOne.id, batchId: batch.id, usedQuantity: "10", wasteQuantity: "0", unit: "g" });
    expect(first.statusCode).toBe(201);
    const second = await consume(ctx, { projectId: projectTwo.id, batchId: batch.id, usedQuantity: "20", wasteQuantity: "0", unit: "g" });
    expect(second.statusCode).toBe(201);

    const listOne = await ctx.request("GET", `/api/v1/consumptions?projectId=${projectOne.id}`);
    const rowsOne = (listOne.json() as { data: Array<{ projectId: string }> }).data;
    expect(rowsOne).toHaveLength(1);
    expect(rowsOne[0]?.projectId).toBe(projectOne.id);

    const listTwo = await ctx.request("GET", `/api/v1/consumptions?projectId=${projectTwo.id}`);
    expect((listTwo.json() as { data: unknown[] }).data).toHaveLength(1);
    await ctx.assertInvariants("项目查询隔离");
  });

  it("未认证请求被鉴权层隔离：不能读取或修改任何业务数据", async () => {
    const material = await createMaterial(ctx);
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000" });
    const project = await createProject(ctx);

    const unauthorizedRead = await ctx.request("GET", `/api/v1/batches/${batch.id}`, { cookie: null });
    expect(unauthorizedRead.statusCode).toBe(401);
    const unauthorizedList = await ctx.request("GET", "/api/v1/materials", { cookie: null });
    expect(unauthorizedList.statusCode).toBe(401);
    const unauthorizedConsume = await ctx.request(
      "POST",
      "/api/v1/consumptions",
      {
        cookie: null,
        body: { projectId: project.id, batchId: batch.id, usedQuantity: "1", wasteQuantity: "0", unit: "g" }
      }
    );
    expect(unauthorizedConsume.statusCode).toBe(401);
    // 被拒绝后余额不变。
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("1000.000000");
    await ctx.assertInvariants("鉴权隔离");
  });

  it("用例间数据隔离：本用例创建的带唯一标记的材料不会出现在下一个用例", async () => {
    // 该用例显式验证 harness 的 beforeEach TRUNCATE 策略：
    // 创建唯一标记材料+批次，随后在下一个用例中通过 SQL 确认不存在。
    const marker = `ISOLATION-MARKER-${process.env.VITEST_POOL_ID ?? "single"}`;
    await createMaterial(ctx, { name: marker });
    const persisted = await ctx.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM materials WHERE name = $1", [marker]);
    expect(Number(persisted.rows[0]?.count)).toBe(1);
    // 存储标记供下个用例读取（文件级变量）。
    isolationMarker = marker;
    await ctx.assertInvariants("隔离标记写入");
  });

  it("上一用例的数据已被清空（无跨用例泄漏）", async () => {
    const leaked = await ctx.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM materials WHERE name = $1", [
      isolationMarker ?? "__none__"
    ]);
    expect(Number(leaked.rows[0]?.count)).toBe(0);
    // 同时确认工作区被重新初始化：操作员仍可访问接口。
    const me = await ctx.request("GET", "/api/v1/auth/me");
    expect(me.statusCode).toBe(200);
    await ctx.assertInvariants("跨用例隔离");
  });
});

let isolationMarker = "";
