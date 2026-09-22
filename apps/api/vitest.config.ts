import { defineConfig } from "vitest/config";

/**
 * 端到端测试通过 globalSetup 启动真实的 embedded PostgreSQL 16 集群。
 *
 * 所有 e2e 文件共享同一数据库与 TRUNCATE 隔离策略，因此必须串行执行：
 *  - fileParallelism:false：文件不并行，避免相互清空数据或在 TRUNCATE 上死锁；
 *  - fileConcurrency:1：describe.concurrent 也不允许。
 *
 * 纯契约单测（validation.test.ts）不依赖数据库，globalSetup 对其无副作用，
 * 仅会额外启动一个本地临时集群。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/e2e-global-setup.ts"],
    fileParallelism: false,
    fileConcurrency: 1,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: "threads",
    poolOptions: {
      threads: {
        // 单线程：保证 src/lib/db.ts 里模块级连接池在所有文件间安全复用。
        singleThread: true
      }
    }
  }
});
