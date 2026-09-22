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

describe("E2E 并发扣减", () => {
  let client: ApiClient;

  beforeEach(async () => {
    await resetBusinessData();
    client = await createAuthenticatedClient();
  });

  afterEach(async () => {
    await assertInventoryInvariants("并发扣减");
  });

  it("12 个并发消耗按批次行锁串行提交，合计扣减精确等于初始库存", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1200", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });

    // 6 笔（90 使用 + 10 损耗）与 6 笔 100 使用：合计 600 + 600 = 1200，恰好耗尽。
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createConsumption(client, {
          projectId: project.id,
          batchId: batch.id,
          usedQuantity: index % 2 === 0 ? "90" : "100",
          wasteQuantity: index % 2 === 0 ? "10" : "0",
          unit: "g"
        })
      )
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const [index, response] of responses.entries()) {
      expect(response.data.usedQuantity).toBe(index % 2 === 0 ? "90.000000" : "100.000000");
      expect(response.data.wasteQuantity).toBe(index % 2 === 0 ? "10.000000" : "0.000000");
      expect(response.data.totalQuantity).toBe("100.000000");
    }

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("0.000000");
    expect(detail.status).toBe("DEPLETED");

    const result = await pool.query(
      `SELECT coalesce(sum(total_quantity), 0)::text AS total, count(*)::int AS count
         FROM consumptions WHERE batch_id = $1 AND status = 'ACTIVE'`,
      [batch.id]
    );
    expect(result.rows[0]?.total).toBe("1200.000000");
    expect(Number(result.rows[0]?.count)).toBe(12);
  });

  it("超额并发竞争：库存恰够 2 笔时只有 2 笔成功，其余拿到 INSUFFICIENT_STOCK", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "200", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        createConsumption(client, {
          projectId: project.id,
          batchId: batch.id,
          usedQuantity: "100",
          wasteQuantity: "0",
          unit: "g"
        })
      )
    );

    const succeeded = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_STOCK");
    expect(succeeded).toHaveLength(2);
    expect(rejected).toHaveLength(6);
    // 不允许出现其他形式的失败（例如序列化错误或 500）。
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);

    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe("0.000000");
    expect(detail.status).toBe("DEPLETED");
  });

  it("混合并发：消耗扣减与入库调整交错执行，批次余额始终等于流水累计", async () => {
    const material = await createMaterial(client);
    const batch = await createBatch(client, material.id, { initialQuantity: "1000", entryUnit: "g" });
    const project = await createProject(client, { status: "IN_PROGRESS", startDate: "2026-09-01" });

    // 每个调整请求在发送前从数据库读取最新 version，使调整与消耗真正并发竞争行锁，
    // 而不是被乐观锁提前挡掉；拿到 VERSION_CONFLICT 的请求由调用方自行重试。
    async function adjustmentIn(quantity: string, label: string): Promise<"committed" | "conflict"> {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const current = await pool.query("SELECT version FROM batches WHERE id = $1", [batch.id]);
        const response = await client.request("POST", `/batches/${batch.id}/adjustments`, {
          body: { direction: "IN", quantity, unit: "g", reason: label, version: current.rows[0]?.version }
        });
        if (response.status === 201) return "committed";
        if (response.status === 409 && response.body.error.code === "VERSION_CONFLICT") continue;
        throw new Error(`调整请求异常: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return "conflict";
    }

    const results = await Promise.all([
      createConsumption(client, { projectId: project.id, batchId: batch.id, usedQuantity: "200", unit: "g" }),
      createConsumption(client, { projectId: project.id, batchId: batch.id, usedQuantity: "150", wasteQuantity: "50", unit: "g" }),
      createConsumption(client, { projectId: project.id, batchId: batch.id, usedQuantity: "300", unit: "g" }),
      adjustmentIn("120", "并发入库一"),
      adjustmentIn("80", "并发入库二")
    ]);

    const consumptions = results.slice(0, 3) as Awaited<ReturnType<typeof createConsumption>>[];
    expect(consumptions.every((r) => r.status === 201)).toBe(true);

    // 期望余额 = 初始库存 + 初始入库之后全部业务流水的带符号数量（不含 OPENING/PURCHASE）。
    const expected = await pool.query(
      `SELECT (b.initial_quantity + coalesce(sum(m.signed_quantity)
                FILTER (WHERE m.type NOT IN ('OPENING', 'PURCHASE')), 0))::text AS balance
         FROM batches b
         LEFT JOIN stock_movements m ON m.batch_id = b.id
        WHERE b.id = $1
        GROUP BY b.initial_quantity`,
      [batch.id]
    );
    const detail = await getBatch(client, batch.id);
    expect(detail.remainingQuantity).toBe(expected.rows[0]?.balance);

    const committedAdjustments = results.slice(3).filter((r) => r === "committed").length;
    const adjustmentMoves = detail.movements.filter((m: any) => m.type === "ADJUSTMENT_IN");
    expect(adjustmentMoves).toHaveLength(committedAdjustments);
  });
});
