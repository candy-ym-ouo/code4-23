import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("E2E 单位换算", () => {
  let client: ApiClient;

  beforeEach(async () => {
    await resetBusinessData();
    client = await createAuthenticatedClient();
  });

  afterEach(async () => {
    await assertInventoryInvariants("单位换算");
  });

  it("入库时 kg 自动换算到材料库存单位 g", async () => {
    const material = await createMaterial(client, { stockUnit: "g" });
    const batch = await createBatch(client, material.id, { initialQuantity: "1.5", entryUnit: "kg" });

    expect(batch.stockUnit).toBe("g");
    expect(batch.remainingQuantity).toBe("1500.000000");
    expect(batch.initialQuantity).toBe("1500.000000");

    const detail = await getBatch(client, batch.id);
    const opening = detail.movements.find((m: any) => m.type === "OPENING");
    expect(opening.signedQuantity).toBe("1500.000000");
    expect(opening.beforeQuantity).toBe("0.000000");
    expect(opening.afterQuantity).toBe("1500.000000");
  });

  it("消耗时按批次库存单位归一化：kg 用量换算为 g，余额只扣一次", async () => {
    const material = await createMaterial(client, { stockUnit: "g" });
    const batch = await createBatch(client, material.id, { initialQuantity: "2", entryUnit: "kg" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });

    const response = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "0.25",
      wasteQuantity: "0.05",
      unit: "kg"
    });

    expect(response.status).toBe(201);
    expect(response.data.usedQuantity).toBe("250.000000");
    expect(response.data.wasteQuantity).toBe("50.000000");
    expect(response.data.totalQuantity).toBe("300.000000");
    expect(response.data.stockUnit).toBe("g");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1700.000000");
  });

  it("长度家族 m / cm / mm 之间换算", async () => {
    const material = await createMaterial(client, { stockUnit: "mm", lowStockThreshold: null });
    const batch = await createBatch(client, material.id, { initialQuantity: "2", entryUnit: "m" });
    expect(batch.remainingQuantity).toBe("2000.000000");

    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const response = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "50",
      wasteQuantity: "0",
      unit: "cm"
    });
    expect(response.status).toBe(201);
    expect(response.data.totalQuantity).toBe("500.000000");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1500.000000");
  });

  it("拒绝跨单位家族（质量 vs 体积）的入库与消耗", async () => {
    // 入库单位家族不兼容：材料按 g 核算，却用 ml 入库
    const massMaterial = await createMaterial(client, { stockUnit: "g" });
    const badBatch = await client.request("POST", "/batches", {
      body: {
        materialId: massMaterial.id,
        receivedAt: "2026-09-01",
        initialQuantity: "1",
        entryUnit: "ml"
      }
    });
    expect(badBatch.status).toBe(422);
    expect(badBatch.body.error.code).toBe("UNIT_INCOMPATIBLE");

    const batch = await createBatch(client, massMaterial.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const badConsumption = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "100",
      unit: "ml"
    });
    expect(badConsumption.status).toBe(422);
    expect(badConsumption.body.error.code).toBe("UNIT_INCOMPATIBLE");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
    expect(detail.movements).toHaveLength(1);
  });

  it("换算结果超出 6 位小数精度时拒绝且不截断（g 消耗应用到 kg 库存批次）", async () => {
    const material = await createMaterial(client, { stockUnit: "kg", lowStockThreshold: null });
    const batch = await createBatch(client, material.id, { initialQuantity: "1", entryUnit: "kg" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });

    // 0.0001 g -> kg 需要 10 位小数，numeric(18,6) 的千克尺度无法表示，必须拒绝。
    const tooFine = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "0.0001",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(tooFine.status).toBe(422);
    expect(tooFine.body.error.code).toBe("UNIT_INCOMPATIBLE");

    // 0.001 g -> kg = 0.000001 kg，恰可精确表示，同一路径放行。
    const exact = await createConsumption(client, {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "0.001",
      wasteQuantity: "0",
      unit: "g"
    });
    expect(exact.status).toBe(201);
    expect(exact.data.totalQuantity).toBe("0.000001");

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("0.999999");
  });
});
