import type { GlobalSetupContext } from "vitest/node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { ensureEmbeddedPostgresLibraries, describeEmbeddedPackage } from "./support/embedded-pg.js";

/**
 * 整个测试套件共享一个真实的 PostgreSQL 16 集群：
 *   - 全局 setup 启动集群、建库、跑全部 SQL migrations；
 *   - 用例间通过 TRUNCATE ... CASCADE 做数据隔离（vitest 配置 fileParallelism:false，
 *     文件串行执行，避免跨文件清空彼此数据）；
 *   - teardown 停止集群，数据目录位于临时目录并由 embedded-postgres 清理。
 */

const TEST_PORT = 55433;
const TEST_DATABASE = "handcraft_e2e";
const TEST_USER = "handcraft";
const TEST_PASSWORD = "e2e-password";

export default async function setup(_context: GlobalSetupContext): Promise<() => Promise<void>> {
  const { nativeDir } = ensureEmbeddedPostgresLibraries();
  const dataDir = mkdtempSync(path.join(tmpdir(), "handcraft-e2e-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: TEST_USER,
    password: TEST_PASSWORD,
    port: TEST_PORT,
    persistent: false,
    initdbFlags: ["--encoding=UTF8"],
    // 注意：不能把 log_min_messages 提到 error/fatal，embedded-postgres 依靠
    // "database system is ready to accept connections" 这条 LOG 判定启动完成，
    // 抑制该日志会让 start() 永远挂起。
    postgresFlags: ["-c", "fsync=off", "-c", "full_page_writes=off", "-c", "logging_collector=off"]
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(TEST_DATABASE);

  process.env.PGHOST = "127.0.0.1";
  process.env.PGPORT = String(TEST_PORT);
  process.env.PGUSER = TEST_USER;
  process.env.PGPASSWORD = TEST_PASSWORD;
  process.env.PGDATABASE = TEST_DATABASE;
  process.env.DATABASE_URL = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DATABASE}`;

  const { runMigrations } = await import("../src/migrate.js");
  await runMigrations();

  // eslint-disable-next-line no-console
  console.log(`[e2e] embedded PostgreSQL ${describeEmbeddedPackage(nativeDir)} ready on port ${TEST_PORT}`);

  return async () => {
    // 关闭测试进程内的连接池，避免空闲连接拖住集群的快速停机。
    const { pool } = await import("../src/lib/db.js");
    await pool.end();
    await pg.stop();
  };
}
