import { describe, expect, it } from "vitest";
import { registerE2EHarness } from "./support/harness.js";
import { consume, createBatch, createMaterial, createProject, errorBody, getBatch } from "./support/fixtures.js";

/**
 * 端到端：单位换算
 *
 * 关键不变量：
 *  - 批次以材料的 stockUnit 为唯一核算单位（见 sql/002_unit_integrity.sql）；
 *  - 入库/消耗提交的其它单位只能在同一单位族内换算；
 *  - 换算结果必须落到 numeric(18,6) 的 6 位小数精度，不可整除时拒绝，
 *    绝不允许静默截断造成库存凭空增减。
 */
describe("E2E · 单位换算", () => {
  const ctx = registerE2EHarness();

  it("入库与消耗使用不同单位时，按同一单位族正确换算并记账", async () => {
    // 材料库存单位 g；入库 1.5 kg；消耗使用 kg 提交（用 0.3 kg + 损耗 0.05 kg）。
    const material = await createMaterial(ctx, { stockUnit: "g" });
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1.5", entryUnit: "kg" });
    expect(batch.stockUnit).toBe("g");
    expect(batch.initialQuantity).toBe("1500.000000");
    expect(batch.remainingQuantity).toBe("1500.000000");

    const project = await createProject(ctx);
    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "0.3",
      wasteQuantity: "0.05",
      unit: "kg"
    });
    expect(response.statusCode, response.body).toBe(201);
    const consumption = (response.json() as { data: Record<string, string> }).data;
    expect(consumption.usedQuantity).toBe("300.000000");
    expect(consumption.wasteQuantity).toBe("50.000000");
    expect(consumption.totalQuantity).toBe("350.000000");
    expect(consumption.stockUnit).toBe("g");

    const refreshed = await getBatch(ctx, batch.id);
    expect(refreshed.remainingQuantity).toBe("1150.000000");
    expect(refreshed.status).toBe("ACTIVE");
    await ctx.assertInvariants("kg→g 换算消耗");
  });

  it("长度族 mm/cm/m 之间的换算消耗保持勾稽", async () => {
    const material = await createMaterial(ctx, { name: "E2E 木料", stockUnit: "mm" });
    // 入库 2 m = 2000 mm
    const batch = await createBatch(ctx, material.id, { initialQuantity: "2", entryUnit: "m" });
    expect(batch.remainingQuantity).toBe("2000.000000");

    const project = await createProject(ctx);
    // 使用 75 cm = 750 mm，损耗 5 cm = 50 mm
    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "75",
      wasteQuantity: "5",
      unit: "cm"
    });
    expect(response.statusCode, response.body).toBe(201);
    expect((response.json() as { data: { totalQuantity: string } }).data.totalQuantity).toBe("800.000000");
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("1200.000000");
    await ctx.assertInvariants("cm→mm 换算消耗");
  });

  it("换算后超过 6 位小数精度（不可整除）时拒绝请求，库存不变", async () => {
    // 库存单位 kg，numeric(18,6) 最多保留 6 位小数：
    //   0.001 g = 0.000001 kg 恰好可整除，应精确扣减；
    //   0.0001 g = 0.0000001 kg 需要 7 位小数、无法整除，必须拒绝。
    const material = await createMaterial(ctx, { name: "E2E 精密染料", stockUnit: "kg" });
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1", entryUnit: "kg" });
    const project = await createProject(ctx);

    const exact = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "0.001",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(exact.statusCode, exact.body).toBe(201);
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("0.999999");

    const overflow = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "0.0001",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(overflow.statusCode).toBe(422);
    expect(errorBody(overflow).code).toBe("UNIT_INCOMPATIBLE");
    // 关键断言：被拒绝后余额不得有任何变化（不能静默截断成 0.000000）。
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("0.999999");
    await ctx.assertInvariants("不可整除换算被拒绝");
  });

  it("跨单位族（体积→质量）的消耗被拒绝且不产生流水", async () => {
    const material = await createMaterial(ctx, { name: "E2E 染液", stockUnit: "ml" });
    const batch = await createBatch(ctx, material.id, { initialQuantity: "1000", entryUnit: "ml" });
    const project = await createProject(ctx);

    const response = await consume(ctx, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "100",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(response.statusCode).toBe(422);
    expect(errorBody(response).code).toBe("UNIT_INCOMPATIBLE");
    expect((await getBatch(ctx, batch.id)).remainingQuantity).toBe("1000.000000");

    const movements = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM stock_movements WHERE batch_id = $1",
      [batch.id]
    );
    // 只有 OPENING 一条流水；失败消耗不得留下任何记录。
    expect(movements.rows[0]?.count).toBe(1);
    await ctx.assertInvariants("跨单位族消耗被拒绝");
  });

  it("入库时跨单位族（pcs→g）同样被拒绝", async () => {
    const material = await createMaterial(ctx, { name: "E2E 金属件", stockUnit: "g" });
    const response = await ctx.request("POST", "/api/v1/batches", {
      body: {
        materialId: material.id,
        batchCode: "BAD-UNIT",
        receivedAt: "2026-09-01",
        initialQuantity: "10",
        entryUnit: "pcs"
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorBody(response).code).toBe("UNIT_INCOMPATIBLE");
    const batches = await ctx.pool.query("SELECT count(*)::int AS count FROM batches WHERE material_id = $1", [material.id]);
    expect(batches.rows[0]?.count).toBe(0);
    await ctx.assertInvariants("跨单位族入库被拒绝");
  });
});
