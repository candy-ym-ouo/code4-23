import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalSetupContext } from "vitest/node";

/**
 * E2E 数据库生命周期：
 * 1. 若已提供 TEST_DATABASE_URL / DATABASE_URL，则直接复用外部 PostgreSQL（CI 模式），
 *    只执行迁移，不负责关停。
 * 2. 否则以当前用户启动一个嵌入式 PostgreSQL 16（无需 root / docker），
 *    数据目录放在系统临时目录，测试结束后销毁。
 *
 * globalSetup 与测试文件在同一 fork 内执行（见 vitest.e2e.config.ts），
 * 这里写入的 process.env 会被后续动态导入的业务模块直接读到。
 */
const DB_NAME = "handcraft_e2e";
const DB_USER = "handcraft";
const DB_PASSWORD = "e2e-password";

type Teardown = () => Promise<void> | void;

async function runMigrations(): Promise<void> {
  // 延迟加载：config/db/migrate 在加载时读取 process.env，必须先注入测试环境变量。
  const { runMigrations: apply } = await import("../../src/migrate.js");
  // runMigrations 自带独立连接与事务管理，直接复用。
  await apply();
}

function pickFreePort(): number {
  const start = 55_000;
  return start + Math.floor(Math.random() * 10_000);
}

async function startEmbeddedPostgres(): Promise<{ connectionString: string; stop: () => Promise<void> }> {
  // 嵌入式 PostgreSQL 二进制链接的是旧版 ICU；若系统提供了旁加载目录则追加到库搜索路径。
  const icuLibDir = process.env.TEST_ICU_LIB_DIR;
  if (icuLibDir && !` ${process.env.LD_LIBRARY_PATH ?? ""} `.includes(` ${icuLibDir} `)) {
    process.env.LD_LIBRARY_PATH = [icuLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = await mkdtemp(path.join(tmpdir(), "handcraft-e2e-pg-"));
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: DB_USER,
    password: DB_PASSWORD,
    port: pickFreePort(),
    persistent: false,
    initdbFlags: [],
    postgresFlags: []
  });

  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(DB_NAME);
  } catch (error) {
    await embedded.stop().catch(() => undefined);
    await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `无法启动嵌入式 PostgreSQL（${(error as Error).message}）。\n` +
        "请确认未缺 libicu 等共享库；也可改用外部数据库：设置 TEST_DATABASE_URL 后重跑。"
    );
  }

  const options = (embedded as unknown as { options: { port: number } }).options;
  const connectionString = `postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${options.port}/${DB_NAME}`;
  return {
    connectionString,
    stop: async () => {
      await embedded.stop().catch(() => undefined);
      await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export default async function setup(_context: GlobalSetupContext): Promise<Teardown> {
  const external = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  let connectionString = external ?? "";
  let stopEmbedded: (() => Promise<void>) | undefined;

  if (!external) {
    const embedded = await startEmbeddedPostgres();
    connectionString = embedded.connectionString;
    stopEmbedded = embedded.stop;
  }

  // 在导入任何业务模块（config/db 会在加载时读取这些变量）之前固定运行环境。
  process.env.DATABASE_URL = connectionString;
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "e2e-session-secret-0123456789abcdef0123456789abcdef";
  process.env.COOKIE_SECURE = "false";
  process.env.PUBLIC_APP_URL = "http://127.0.0.1:3000";
  process.env.LOG_LEVEL = "fatal";
  process.env.UPLOAD_DIR = await mkdtemp(path.join(tmpdir(), "handcraft-e2e-uploads-"));

  await runMigrations();

  return async () => {
    if (stopEmbedded) await stopEmbedded();
    if (process.env.UPLOAD_DIR) {
      await rm(process.env.UPLOAD_DIR, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
