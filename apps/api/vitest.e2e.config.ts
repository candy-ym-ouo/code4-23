import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    globalSetup: ["tests/e2e/global-setup.ts"],
    // 所有 E2E 用例共享同一个数据库实例，串行执行避免并发套件互相清空数据。
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
});
