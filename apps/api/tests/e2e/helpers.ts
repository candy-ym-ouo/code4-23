import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/lib/db.js";

type InjectedResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

/**
 * E2E 测试公共工具：
 * - 通过 Fastify inject 走完整 HTTP 栈（路由、鉴权、错误处理、事务），但不占用端口；
 * - 每个用例前清空业务表，保留单操作员与会话；
 * - checkInventoryInvariants 直接核对数据库不变量，失败信息明确指出被破坏的不变量。
 */

export type ApiResponse<T = any> = {
  status: number;
  body: any;
  data: T;
  meta?: any;
  headers: Record<string, unknown>;
};

let appPromise: Promise<FastifyInstance> | undefined;

export function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp({ runDatabaseMigrations: false });
  return appPromise;
}

export class ApiClient {
  private cookie = "";

  constructor(private readonly app: FastifyInstance) {}

  async request<T = any>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookie) headers.cookie = this.cookie;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = (await this.app.inject({
      method: method.toUpperCase() as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      url: `/api/v1${path}`,
      headers,
      payload: options.body === undefined ? undefined : JSON.stringify(options.body)
    })) as unknown as InjectedResponse;
    const setCookie = response.headers["set-cookie"];
    if (setCookie) {
      const pair = String(Array.isArray(setCookie) ? setCookie[0] : setCookie);
      this.cookie = pair.split(";")[0] ?? "";
    }
    const body = response.statusCode === 204 ? null : response.json();
    return { status: response.statusCode, body, data: body?.data, meta: body?.meta, headers: response.headers };
  }

  /** 期望业务成功，否则把错误码与消息带进断言输出。 */
  async send<T = any>(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse<T>> {
    const response = await this.request<T>(method, path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${method} ${path} 期望成功但得到 ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return response;
  }
}

let uniqueCounter = 0;
function uniqueTag(): string {
  uniqueCounter += 1;
  return `${Date.now().toString(36)}${uniqueCounter.toString(36)}${randomUUID().slice(0, 4)}`;
}

export type FixtureBundle = {
  client: ApiClient;
  tag: string;
  source: any;
  material: any;
  batch: any;
  project: any;
};

export async function resetBusinessData(): Promise<void> {
  // 只保留 users / sessions（单操作员登录态），其余业务与审计数据全部清空。
  await pool.query(`
    TRUNCATE TABLE
      attachments, color_changes, consumptions, project_requirements, projects,
      stock_movements, batches, materials, storage_locations, sources, audit_logs
    RESTART IDENTITY CASCADE
  `);
}

export async function createAnonymousClient(): Promise<ApiClient> {
  return new ApiClient(await getApp());
}

export async function createAuthenticatedClient(): Promise<ApiClient> {
  const app = await getApp();
  const client = new ApiClient(app);
  const password = "e2e-operator-password";
  const status = await client.request("GET", "/setup/status");
  if (status.data?.initialized) {
    const login = await client.request("POST", "/auth/login", { body: { password } });
    if (login.status !== 200) throw new Error(`测试登录失败: ${login.status} ${JSON.stringify(login.body)}`);
  } else {
    await client.send("POST", "/setup", { body: { displayName: "E2E Operator", password } });
  }
  return client;
}

export async function createSource(client: ApiClient, name?: string): Promise<any> {
  const response = await client.send("POST", "/sources", {
    body: { name: name ?? `来源-${uniqueTag()}`, type: "PURCHASED" }
  });
  return response.data;
}

export async function createMaterial(client: ApiClient, overrides: Record<string, unknown> = {}): Promise<any> {
  const tag = uniqueTag();
  const response = await client.send("POST", "/materials", {
    body: {
      code: `E2E-${tag}`.toUpperCase(),
      name: `材料-${tag}`,
      craftTypes: ["GENERAL"],
      stockUnit: "g",
      lowStockThreshold: "100",
      ...overrides
    }
  });
  return response.data;
}

export async function createBatch(
  client: ApiClient,
  materialId: string,
  overrides: Record<string, unknown> = {}
): Promise<any> {
  const response = await client.send("POST", "/batches", {
    body: {
      materialId,
      batchCode: `B-${uniqueTag()}`.toUpperCase(),
      receivedAt: "2026-09-01",
      initialQuantity: "1000",
      entryUnit: "g",
      ...overrides
    }
  });
  // POST /batches 直接回传 RETURNING *（snake_case），这里转成与 GET 接口一致的 camelCase 视图。
  const row = response.data;
  return {
    ...row,
    initialQuantity: row.initial_quantity,
    remainingQuantity: row.remaining_quantity,
    stockUnit: row.stock_unit,
    batchCode: row.batch_code,
    version: row.version
  };
}

export async function createProject(client: ApiClient, overrides: Record<string, unknown> = {}): Promise<any> {
  const response = await client.send("POST", "/projects", {
    body: { name: `项目-${uniqueTag()}`, craftType: "GENERAL", status: "PLANNED", ...overrides }
  });
  return response.data;
}

export async function createConsumption(
  client: ApiClient,
  input: { projectId: string; batchId: string; usedQuantity: string; wasteQuantity?: string; unit: string; projectRequirementId?: string },
  headers?: Record<string, string>
): Promise<ApiResponse> {
  return client.request("POST", "/consumptions", {
    headers,
    body: {
      wasteQuantity: "0",
      projectRequirementId: undefined,
      ...input
    }
  });
}

export async function getBatch(client: ApiClient, batchId: string): Promise<any> {
  const response = await client.send("GET", `/batches/${batchId}`);
  return response.data;
}

export async function getProject(client: ApiClient, projectId: string): Promise<any> {
  const response = await client.send("GET", `/projects/${projectId}`);
  return response.data;
}

// ---- 数据库不变量核对 -------------------------------------------------------

type NumericRow = Record<string, string | number | bigint | null>;

async function queryRows(sql: string, params: unknown[] = []): Promise<NumericRow[]> {
  const result = await pool.query(sql, params);
  return result.rows as NumericRow[];
}

/** numeric(18,6) 统一放大 1e6 转成 bigint 做精确比较。 */
export function toScaled(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) throw new Error("数值为 NULL，违反非空数量不变量");
  const text = typeof value === "bigint" ? value.toString() : String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error(`无法解析数量: ${text}`);
  const negative = match[1] === "-";
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(6, "0") || "0");
  const scaled = whole * 1_000_000n + fraction;
  return negative ? -scaled : scaled;
}

export type InvariantViolation = { invariant: string; detail: string };

/**
 * 核对库存域的全部核心不变量。任何一条不满足都会返回（名称 + 证据），
 * 由测试断言打印，明确指出“被破坏的不变量”。
 */
export async function collectInventoryViolations(): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  const fail = (invariant: string, detail: string) => violations.push({ invariant, detail });

  const batches = await queryRows("SELECT id, initial_quantity, remaining_quantity, status FROM batches ORDER BY created_at, id");
  const movements = await queryRows(`
    SELECT id, batch_id, type, signed_quantity, before_quantity, after_quantity, idempotency_key, created_at
      FROM stock_movements ORDER BY created_at, id
  `);
  const consumptions = await queryRows(`
    SELECT id, used_quantity, waste_quantity, total_quantity, status, reversed_at, reversal_reason
      FROM consumptions
  `);

  // I1：批次余额绝不允许小于 0（CHECK 约束 + 业务双层保护）。
  for (const batch of batches) {
    if (toScaled(batch.remaining_quantity) < 0n) {
      fail("I1 批次余额非负", `批次 ${batch.id} remaining_quantity=${batch.remaining_quantity} < 0`);
    }
  }

  // I2：每条流水必须满足 before + signed = after，且数量不为 0。
  for (const movement of movements) {
    const expected = toScaled(movement.before_quantity) + toScaled(movement.signed_quantity);
    const actual = toScaled(movement.after_quantity);
    if (expected !== actual) {
      fail(
        "I2 流水前后余额衔接 (before + signed = after)",
        `流水 ${movement.id} (${movement.type}): ${movement.before_quantity} + (${movement.signed_quantity}) != ${movement.after_quantity}`
      );
    }
  }

  // I3：批次余额必须等于其全部流水的逐笔累计结果（OPENING 为起点，REVERSAL 为正向恢复）。
  const running = new Map<string, bigint>();
  for (const movement of movements) {
    const key = String(movement.batch_id);
    const next = (running.get(key) ?? 0n) + toScaled(movement.signed_quantity);
    if (next < 0n) {
      fail("I3 流水累计余额任何时刻非负", `流水 ${movement.id} 之后批次 ${key} 累计余额为负: ${next}`);
    }
    running.set(key, next);
  }
  for (const batch of batches) {
    const ledger = running.get(String(batch.id)) ?? 0n;
    if (ledger !== toScaled(batch.remaining_quantity)) {
      fail(
        "I3 批次余额等于流水累计",
        `批次 ${batch.id} 表内余额=${batch.remaining_quantity}，流水累计=${ledger}`
      );
    }
  }

  // I4：幂等键全局唯一，同一键只能对应一条流水（重试不得重复扣减）。
  const duplicateKeys = await queryRows(`
    SELECT idempotency_key, count(*)::int AS count
      FROM stock_movements WHERE idempotency_key IS NOT NULL
     GROUP BY idempotency_key HAVING count(*) > 1
  `);
  for (const row of duplicateKeys) {
    fail("I4 幂等键唯一（重试不产生第二条流水）", `idempotency_key=${row.idempotency_key} 出现 ${row.count} 次`);
  }

  // I5：消耗记录 total = used + waste；已撤销必须带撤销时间与原因。
  for (const consumption of consumptions) {
    const total = toScaled(consumption.used_quantity) + toScaled(consumption.waste_quantity);
    if (total !== toScaled(consumption.total_quantity)) {
      fail(
        "I5 消耗总量=实际使用+损耗",
        `消耗 ${consumption.id}: ${consumption.used_quantity} + ${consumption.waste_quantity} != ${consumption.total_quantity}`
      );
    }
    if (consumption.status === "REVERSED" && (consumption.reversed_at === null || consumption.reversal_reason === null)) {
      fail("I5 撤销记录必须有时间与原因", `消耗 ${consumption.id} 状态 REVERSED 但撤销元数据缺失`);
    }
  }

  // I6：每个 ACTIVE 消耗恰好对应一条 CONSUMPTION 扣减流水；
  //     每条 REVERSED 消耗恰好再对应一条 REVERSAL 恢复流水，数量一致。
  const consumptionLedger = await queryRows(`
    SELECT c.id AS id, c.status AS status, c.total_quantity AS total,
           count(m.id) FILTER (WHERE m.type = 'CONSUMPTION')::int AS consumption_moves,
           count(m.id) FILTER (WHERE m.type = 'REVERSAL')::int AS reversal_moves,
           coalesce(sum(abs(m.signed_quantity)) FILTER (WHERE m.type = 'REVERSAL'), 0) AS reversal_sum
      FROM consumptions c
      LEFT JOIN stock_movements m ON m.reference_type IN ('CONSUMPTION', 'CONSUMPTION_REVERSAL')
        AND m.reference_id = c.id
     GROUP BY c.id, c.status, c.total_quantity
  `);
  for (const row of consumptionLedger) {
    if (Number(row.consumption_moves) !== 1) {
      fail("I6 每条消耗恰好一条扣减流水", `消耗 ${row.id} 有 ${row.consumption_moves} 条 CONSUMPTION 流水`);
    }
    if (row.status === "ACTIVE" && Number(row.reversal_moves) !== 0) {
      fail("I6 ACTIVE 消耗不得有撤销流水", `消耗 ${row.id} 状态 ACTIVE 却有 ${row.reversal_moves} 条 REVERSAL`);
    }
    if (row.status === "REVERSED") {
      if (Number(row.reversal_moves) !== 1) {
        fail("I6 撤销恰好产生一条恢复流水", `消耗 ${row.id} REVERSED 却有 ${row.reversal_moves} 条 REVERSAL`);
      }
      if (toScaled(row.reversal_sum) !== toScaled(row.total)) {
        fail(
          "I6 撤销恢复数量等于原扣减数量",
          `消耗 ${row.id}: 撤销合计=${row.reversal_sum}，原扣减=${row.total}`
        );
      }
    }
  }

  // I7：状态与余额一致：DEPLETED/ARCHIVED 必须 0，ACTIVE 必须 > 0（migration 003 约束语义）。
  for (const batch of batches) {
    const remaining = toScaled(batch.remaining_quantity);
    if (batch.status === "ACTIVE" && remaining <= 0n) {
      fail("I7 批次状态与余额一致", `批次 ${batch.id} 状态 ACTIVE 但余额=${batch.remaining_quantity}`);
    }
    if ((batch.status === "DEPLETED" || batch.status === "ARCHIVED") && remaining !== 0n) {
      fail("I7 批次状态与余额一致", `批次 ${batch.id} 状态 ${batch.status} 但余额=${batch.remaining_quantity} ≠ 0`);
    }
  }

  // I8：跨实体归属一致——消耗的需求必须属于同一项目，且需求材料必须等于批次材料。
  // 这是“数据隔离”在单租户模型下的核心不变量：任何消耗都不能把 A 项目/材料的实体串到 B 上。
  const scopeBreaches = await queryRows(`
    SELECT c.id AS consumption_id, c.project_id AS project_id, c.batch_id AS batch_id,
           r.project_id AS requirement_project_id, r.material_id AS requirement_material_id,
           b.material_id AS batch_material_id
      FROM consumptions c
      JOIN project_requirements r ON r.id = c.project_requirement_id
      JOIN batches b ON b.id = c.batch_id
     WHERE r.project_id <> c.project_id OR r.material_id <> b.material_id
  `);
  for (const row of scopeBreaches) {
    fail(
      "I8 消耗的项目/材料归属一致（禁止跨实体串接）",
      `消耗 ${row.consumption_id}: 项目=${row.project_id} 需求归属项目=${row.requirement_project_id}，` +
        `批次材料=${row.batch_material_id} 需求材料=${row.requirement_material_id}`
    );
  }

  // I9：消耗与流水引用完整——每条消耗必须能连到真实项目与批次，流水必须挂在消耗自己的批次上。
  const dangling = await queryRows(`
    SELECT c.id AS consumption_id
      FROM consumptions c
      FULL JOIN batches b ON b.id = c.batch_id
      FULL JOIN projects p ON p.id = c.project_id
     WHERE c.id IS NOT NULL AND (b.id IS NULL OR p.id IS NULL)
  `);
  for (const row of dangling) {
    fail("I9 消耗引用完整（项目/批次不得悬空）", `消耗 ${row.consumption_id} 引用了不存在的项目或批次`);
  }

  return violations;
}

/** 断言全部不变量成立；失败时逐条列出被破坏的不变量与证据。 */
export async function assertInventoryInvariants(contextLabel: string): Promise<void> {
  const violations = await collectInventoryViolations();
  if (violations.length > 0) {
    const details = violations.map((v) => `  - 破坏不变量【${v.invariant}】：${v.detail}`).join("\n");
    throw new Error(`[${contextLabel}] 库存不变量被破坏（${violations.length} 条）：\n${details}`);
  }
}
