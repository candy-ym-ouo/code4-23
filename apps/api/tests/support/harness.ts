import { afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";

// 环境变量必须在 import 任何会加载 src/config.ts 的模块之前设置。
// PG* 由 tests/e2e-global-setup.ts 写入同一进程的 process.env；
// 这里补齐仅与本进程相关的变量，并删除本地 .env 可能带来的干扰项。
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.PGHOST = process.env.PGHOST ?? "127.0.0.1";
process.env.PGPORT = process.env.PGPORT ?? "55433";
process.env.PGUSER = process.env.PGUSER ?? "handcraft";
process.env.PGPASSWORD = process.env.PGPASSWORD ?? "e2e-password";
process.env.PGDATABASE = process.env.PGDATABASE ?? "handcraft_e2e";
delete process.env.DATABASE_URL;
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "handcraft-e2e-uploads-"));
process.env.SESSION_SECRET = "e2e-only-session-secret-with-at-least-32-characters";
process.env.COOKIE_SECURE = "false";

// 动态导入发生在环境变量配置之后。
const { buildApp } = await import("../../src/app.js");
const { pool } = await import("../../src/lib/db.js");

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
export type InjectResponse = Awaited<ReturnType<AppInstance["inject"]>>;

/**
 * 不变量校验失败时抛出，message 中逐条列出被破坏的不变量与具体行，
 * 满足“失败须指出被破坏的不变量”的要求。
 */
export class InvariantError extends Error {
  constructor(violations: string[]) {
    super(
      [
        `库存账本不变量被破坏，共 ${violations.length} 项：`,
        ...violations.map((violation, index) => `${index + 1}. ${violation}`)
      ].join("\n")
    );
    this.name = "InvariantError";
  }
}

type InvariantRow = Record<string, unknown>;

/**
 * 库存账本不变量清单。任何业务场景执行后都可以用 assertInvariants 全量校验。
 */
export const INTEGRITY_CHECKS: Array<{ code: string; description: string; sql: string }> = [
  {
    // 不变量 I1：流水勾稽 —— before + signed = after（numeric(18,6)，按 6 位小数四舍五入比较）。
    code: "I1-MOVEMENT-ARITHMETIC",
    description: "库存流水必须满足 before_quantity + signed_quantity = after_quantity",
    sql: `SELECT batch_id::text AS "batchId", id::text AS "movementId", type,
                  before_quantity::text AS "before", signed_quantity::text AS "signed", after_quantity::text AS "after"
             FROM stock_movements
            WHERE round(before_quantity + signed_quantity, 6) <> round(after_quantity, 6)`
  },
  {
    // 不变量 I2：任何时刻流水的 after/before 都不能为负，signed 不能为 0（表约束之外的二次防御）。
    code: "I2-NO-NEGATIVE-QUANTITY",
    description: "流水 before/after 必须 >= 0，signed_quantity 必须 <> 0",
    sql: `SELECT batch_id::text AS "batchId", id::text AS "movementId", type,
                  before_quantity::text AS "before", signed_quantity::text AS "signed", after_quantity::text AS "after"
             FROM stock_movements
            WHERE before_quantity < 0 OR after_quantity < 0 OR signed_quantity = 0`
  },
  {
    // 不变量 I3：批次余额必须等于其全部流水 signed 累计，也等于按物理插入顺序
    // （ctid）重放后最后一条流水的 after_quantity。
    // 说明：stock_movements 是只追加的不可变流水表，同一批次的插入被
    // SELECT ... FOR UPDATE 串行化，因此 ctid 的物理顺序就是真实的链式顺序。
    // 不能用 created_at 排序：高并发下多条流水时间戳相同，UUID 主键无序，
    // 会错误地把较早的流水当成“最后一条”。
    code: "I3-BATCH-BALANCE-EQUALS-LEDGER",
    description: "batches.remaining_quantity 必须等于流水重放结果（最后一条 after 与 signed 累计均须一致）",
    sql: `WITH ledger AS (
              SELECT batch_id,
                     sum(signed_quantity) AS signed_sum,
                     (array_agg(after_quantity ORDER BY ctid))[cardinality(array_agg(after_quantity ORDER BY ctid))] AS last_after
                FROM stock_movements GROUP BY batch_id
            )
            SELECT b.id::text AS "batchId", b.remaining_quantity::text AS "remaining",
                   ledger.signed_sum::text AS "signedSum", ledger.last_after::text AS "lastAfter"
              FROM batches b JOIN ledger ON ledger.batch_id = b.id
             WHERE round(b.remaining_quantity, 6) <> round(ledger.signed_sum, 6)
                OR round(b.remaining_quantity, 6) <> round(ledger.last_after, 6)`
  },
  {
    // 不变量 I4：余额绝不允许小于 0。
    code: "I4-NO-NEGATIVE-BALANCE",
    description: "batches.remaining_quantity 必须始终 >= 0",
    sql: `SELECT id::text AS "batchId", remaining_quantity::text AS "remaining"
            FROM batches WHERE remaining_quantity < 0`
  },
  {
    // 不变量 I5：状态与余额一致：ACTIVE>0、DEPLETED=0、ARCHIVED=0。
    code: "I5-STATUS-QUANTITY-CONSISTENCY",
    description: "批次状态必须与余额匹配（ACTIVE>0，DEPLETED/ARCHIVED=0）",
    sql: `SELECT id::text AS "batchId", status, remaining_quantity::text AS "remaining"
            FROM batches
           WHERE (status = 'ACTIVE' AND remaining_quantity <= 0)
              OR (status IN ('DEPLETED','ARCHIVED') AND remaining_quantity <> 0)`
  },
  {
    // 不变量 I6：消耗记录的 total_quantity = used + waste，且必须 > 0。
    code: "I6-CONSUMPTION-SUM",
    description: "consumptions.total_quantity 必须等于 used_quantity + waste_quantity 且大于 0",
    sql: `SELECT id::text AS "consumptionId", used_quantity::text AS "used", waste_quantity::text AS "waste",
                  total_quantity::text AS "total"
             FROM consumptions
            WHERE round(used_quantity + waste_quantity, 6) <> round(total_quantity, 6) OR total_quantity <= 0`
  },
  {
    // 不变量 I7：每条消耗恰有一条 CONSUMPTION 流水且扣减量等于 total；REVERSED 消耗恰有一条
    // 等量 REVERSAL 流水；ACTIVE 消耗不得存在 REVERSAL 流水。
    code: "I7-CONSUMPTION-MOVEMENT-CONSISTENCY",
    description: "消耗与 CONSUMPTION/REVERSAL 流水必须一一对应，撤销数量必须等于扣减数量",
    sql: `WITH consume_flow AS (
              SELECT reference_id AS consumption_id, count(*)::int AS n,
                     sum(abs(signed_quantity))::numeric(18,6) AS deducted
                FROM stock_movements
               WHERE reference_type IN ('CONSUMPTION','CONSUMPTION_REVERSAL') AND type = 'CONSUMPTION'
               GROUP BY reference_id
            ),
            reverse_flow AS (
              SELECT reference_id AS consumption_id, count(*)::int AS n,
                     sum(signed_quantity)::numeric(18,6) AS restored
                FROM stock_movements
               WHERE reference_type = 'CONSUMPTION_REVERSAL' AND type = 'REVERSAL'
               GROUP BY reference_id
            )
            SELECT c.id::text AS "consumptionId", c.status, c.total_quantity::text AS "total",
                   coalesce(cf.n, 0) AS "consumptionMovementCount",
                   coalesce(cf.deducted, 0)::text AS "deducted",
                   coalesce(rf.n, 0) AS "reversalMovementCount",
                   coalesce(rf.restored, 0)::text AS "restored"
              FROM consumptions c
              LEFT JOIN consume_flow cf ON cf.consumption_id = c.id
              LEFT JOIN reverse_flow rf ON rf.consumption_id = c.id
             WHERE coalesce(cf.n, 0) <> 1
                OR round(coalesce(cf.deducted, 0), 6) <> round(c.total_quantity, 6)
                OR (c.status = 'REVERSED' AND (coalesce(rf.n, 0) <> 1 OR round(coalesce(rf.restored, 0), 6) <> round(c.total_quantity, 6)))
                OR (c.status = 'ACTIVE' AND coalesce(rf.n, 0) <> 0)`
  },
  {
    // 不变量 I8：幂等键全局唯一（部分唯一索引的兜底验证，避免同键产生两条业务记录）。
    code: "I8-IDEMPOTENCY-UNIQUE",
    description: "同一 Idempotency-Key 至多对应一条库存流水",
    sql: `SELECT idempotency_key AS "idempotencyKey", count(*)::int AS "movementCount"
            FROM stock_movements WHERE idempotency_key IS NOT NULL
           GROUP BY idempotency_key HAVING count(*) > 1`
  },
  {
    // 不变量 I9：OPENING 是每个批次的第一条流水，从 0 起，数量等于初始入库量。
    code: "I9-OPENING-FIRST",
    description: "每个批次首条流水必须是 OPENING，before=0 且 after=initial_quantity",
    sql: `WITH first_movement AS (
              SELECT DISTINCT ON (batch_id) batch_id, type, before_quantity, after_quantity
                FROM stock_movements ORDER BY batch_id, ctid
            )
            SELECT fm.batch_id::text AS "batchId", fm.type, fm.before_quantity::text AS "before",
                   fm.after_quantity::text AS "after", b.initial_quantity::text AS "initial"
              FROM first_movement fm JOIN batches b ON b.id = fm.batch_id
             WHERE fm.type <> 'OPENING' OR fm.before_quantity <> 0
                OR round(fm.after_quantity, 6) <> round(b.initial_quantity, 6)`
  }
];

// 测试间数据隔离：清空所有业务表，只保留 migrations 记录。
const RESET_SQL = `TRUNCATE TABLE
  audit_logs, attachments, color_changes, consumptions, project_requirements,
  projects, stock_movements, batches, materials, storage_locations, sources,
  sessions, users RESTART IDENTITY CASCADE`;

export type E2EContext = {
  app: AppInstance;
  pool: Pool;
  /** 当前 setup 返回的会话 Cookie，例如 handcraft_session=... */
  cookie: string;
  request: (method: string, url: string, options?: HttpRequestOptions) => Promise<InjectResponse>;
  setupFreshWorkspace: () => Promise<void>;
  resetDatabase: () => Promise<void>;
  assertInvariants: (label?: string) => Promise<void>;
  invariantSnapshot: () => Promise<InvariantCounterSnapshot>;
};

type HttpRequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  /** null 表示显式匿名；undefined 表示使用当前会话 Cookie。 */
  cookie?: string | null;
};

type InvariantCounterSnapshot = {
  counts: Record<string, number>;
  auditCount: number;
};

let app: AppInstance;
let activeCookie = "";

async function resetDatabase(): Promise<void> {
  await pool.query(RESET_SQL);
}

async function setupFreshWorkspace(): Promise<void> {
  await resetDatabase();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: { displayName: "E2E 操作员", password: "e2e-operator-password" },
    headers: { "content-type": "application/json" }
  });
  if (response.statusCode !== 201) {
    throw new Error(`测试工作区初始化失败：${response.statusCode} ${response.body}`);
  }
  const setCookie = response.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieValue) throw new Error("setup 未返回会话 Cookie");
  activeCookie = cookieValue.split(";")[0] ?? "";
}

async function assertInvariants(label?: string): Promise<void> {
  const violations: string[] = [];
  for (const check of INTEGRITY_CHECKS) {
    const result = await pool.query<InvariantRow>(check.sql);
    if (result.rows.length > 0) {
      violations.push(
        `[${check.code}] ${check.description}；${result.rows.length} 行违规，例如：${formatRows(result.rows.slice(0, 3))}${
          label ? `（场景：${label}）` : ""
        }`
      );
    }
  }
  if (violations.length > 0) throw new InvariantError(violations);
}

function formatRows(rows: InvariantRow[]): string {
  return rows
    .map((row) => `{ ${Object.entries(row).map(([key, value]) => `${key}=${String(value)}`).join(", ")} }`)
    .join("; ");
}

async function invariantSnapshot(): Promise<InvariantCounterSnapshot> {
  const counts: Record<string, number> = {};
  for (const check of INTEGRITY_CHECKS) {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${check.sql}) AS violations`);
    counts[check.code] = Number(result.rows[0]?.count ?? 0);
  }
  const audit = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_logs");
  return { counts, auditCount: Number(audit.rows[0]?.count ?? 0) };
}

function createRequest() {
  return async (method: string, url: string, options: HttpRequestOptions = {}): Promise<InjectResponse> => {
    const headers: Record<string, string> = { ...options.headers };
    const cookie = options.cookie === undefined ? activeCookie : options.cookie;
    if (cookie) headers.cookie = cookie;
    if (options.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    const response = await app.inject({
      method: method as never,
      url,
      payload: options.body as never,
      headers
    });
    return response as InjectResponse;
  };
}

// 文件串行、单线程执行，数据库集群由 globalSetup 管理，模块级 pool 在所有
// 文件间复用；任何文件都不能关闭它，否则后续文件会拿到已关闭的连接池。
export function registerE2EHarness(): E2EContext {
  beforeAll(async () => {
    app = await buildApp();
    await setupFreshWorkspace();
  });

  beforeEach(async () => {
    await setupFreshWorkspace();
  });

  afterAll(async () => {
    await app?.close();
  });

  return {
    get app() {
      return app;
    },
    get pool() {
      return pool;
    },
    get cookie() {
      return activeCookie;
    },
    request: createRequest(),
    setupFreshWorkspace,
    resetDatabase,
    assertInvariants,
    invariantSnapshot
  };
}
