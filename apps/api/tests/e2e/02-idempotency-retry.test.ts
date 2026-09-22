import { randomUUID } from "node:crypto";
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

async function countMovements(): Promise<number> {
  const result = await pool.query("SELECT count(*)::int AS count FROM stock_movements");
  return Number(result.rows[0]?.count ?? 0);
}

describe("E2E 幂等重试", () => {
  let client: ApiClient;

  beforeEach(async () => {
    await resetBusinessData();
    client = await createAuthenticatedClient();
  });

  afterEach(async () => {
    await assertInventoryInvariants("幂等重试");
  });

  it("同一 Idempotency-Key 顺序重试只创建一条批次入库流水", async () => {
    const material = await createMaterial(client, { stockUnit: "g" });
    const key = `e2e-batch-seq-${randomUUID()}`;
    const payload = { materialId: material.id, receivedAt: "2026-09-01", initialQuantity: "1", entryUnit: "kg" };

    const first = await client.request("POST", "/batches", { headers: { "idempotency-key": key }, body: payload });
    const second = await client.request("POST", "/batches", { headers: { "idempotency-key": key }, body: payload });
    const third = await client.request("POST", "/batches", { headers: { "idempotency-key": key }, body: payload });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    expect(third.data.id).toBe(first.data.id);

    const detail = await getBatch(client, first.data.id);
    expect(detail.remainingQuantity).toBe("1000.000000");
    expect(detail.movements).toHaveLength(1);
  });

  it("同一 Idempotency-Key 的并发消耗请求串行化，只扣减一次", async () => {
    const material = await createMaterial(client, { stockUnit: "g" });
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const key = `e2e-consume-race-${randomUUID()}`;
    const payload = {
      projectId: project.id,
      batchId: batch.id,
      usedQuantity: "300",
      wasteQuantity: "20",
      unit: "g"
    };

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.request("POST", "/consumptions", { headers: { "idempotency-key": key }, body: payload })
      )
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 201]);
    const ids = new Set(responses.map((r) => r.data.id));
    expect(ids.size).toBe(1);

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("680.000000");
    const consumeMoves = detail.movements.filter((m: any) => m.type === "CONSUMPTION");
    expect(consumeMoves).toHaveLength(1);

    const list = await client.send("GET", `/consumptions?batchId=${batch.id}`);
    expect(list.meta.total).toBe(1);
  });

  it("失败的请求不占用幂等键，更换载荷后可用同一键成功", async () => {
    const material = await createMaterial(client, { stockUnit: "g" });
    const batch = await createBatch(client, material.id, { initialQuantity: "100", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });
    const key = `e2e-consume-retry-${randomUUID()}`;

    const failed = await createConsumption(
      client,
      { projectId: project.id, batchId: batch.id, usedQuantity: "200", wasteQuantity: "0", unit: "g" },
      { "idempotency-key": key }
    );
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe("INSUFFICIENT_STOCK");

    const succeeded = await createConsumption(
      client,
      { projectId: project.id, batchId: batch.id, usedQuantity: "30", wasteQuantity: "0", unit: "g" },
      { "idempotency-key": key }
    );
    expect(succeeded.status).toBe(201);

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("70.000000");
  });

  it("不同幂等键的相同请求各自独立扣减", async () => {
    const material = await createMaterial(client, { stockUnit: "g" });
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });

    const [a, b] = await Promise.all([
      createConsumption(
        client,
        { projectId: project.id, batchId: batch.id, usedQuantity: "100", unit: "g" },
        { "idempotency-key": `e2e-distinct-${randomUUID()}` }
      ),
      createConsumption(
        client,
        { projectId: project.id, batchId: batch.id, usedQuantity: "100", unit: "g" },
        { "idempotency-key": `e2e-distinct-${randomUUID()}` }
      )
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.data.id).not.toBe(b.data.id);

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("800.000000");
    expect(await countMovements()).toBe(3); // OPENING + 2 × CONSUMPTION
  });
});
