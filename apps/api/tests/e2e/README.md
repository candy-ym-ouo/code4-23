# API 端到端测试

覆盖业务一致性的六条主线：

| 文件 | 场景 |
| --- | --- |
| `01-unit-conversion.test.ts` | 单位换算：kg/g、m/cm/mm 跨单位入库与消耗、跨家族拒绝、精度边界 |
| `02-idempotency-retry.test.ts` | 幂等重试：同键顺序/并发重试、失败不占键、异键独立扣减 |
| `03-transaction-rollback.test.ts` | 事务回滚：余额不足、需求归属错配、乐观锁冲突、引用归档来源 |
| `04-concurrent-deduction.test.ts` | 并发扣减：12 路并发耗尽、超额竞争、消耗与调整交错 |
| `05-reversal-restore.test.ts` | 撤销恢复：REVERSAL 流水、并发重复撤销、撤销后再消耗、统计口径 |
| `06-data-isolation.test.ts` | 数据隔离：未认证拒绝、项目/材料边界、归档隔离、过滤不串数据 |

## 运行

```bash
pnpm --filter @handcraft/api test:e2e
```

数据库来源（二选一）：

1. **外部 PostgreSQL（CI / 已装 PG 的环境）**：设置 `TEST_DATABASE_URL`（或
   `DATABASE_URL`），套件只会执行迁移，不启动额外进程。
2. **嵌入式 PostgreSQL 16（本地零依赖）**：不设上述变量时，套件以当前用户启动
   [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres)，
   数据目录在系统临时目录中，结束自动销毁。无需 root 或 docker。

嵌入式二进制是按旧版系统库（如 `libicuuc.so.60`）链接的；若系统只有更新的
ICU，可把旧库解压到任意目录并通过 `TEST_ICU_LIB_DIR` 指过去，套件会把它
追加到 `LD_LIBRARY_PATH`：

```bash
TEST_ICU_LIB_DIR=/opt/libicu60/usr/lib/aarch64-linux-gnu pnpm --filter @handcraft/api test:e2e
```

测试通过 Fastify `inject` 走完整 HTTP 栈（路由、鉴权、错误处理、事务、迁移后的
真实 schema），不监听端口。每个用例前清空业务表（保留单操作员与会话），
用例之间互不污染。

## 失败如何读

每个用例结束后，`helpers.ts` 的 `assertInventoryInvariants` 会直接核对数据库，
失败信息形如：

```
[事务回滚] 库存不变量被破坏（1 条）：
  - 破坏不变量【I3 批次余额等于流水累计】：批次 <id> 表内余额=1000.000000，流水累计=900
```

被核对的不变量：

- **I1** 批次余额非负（`remaining_quantity >= 0`）。
- **I2** 每条流水满足 `before_quantity + signed_quantity = after_quantity`。
- **I3** 批次余额等于其流水按提交顺序的逐笔累计，且累计值任何时刻不为负。
- **I4** 幂等键全局唯一：同一 `Idempotency-Key` 重试不得产生第二条流水。
- **I5** 消耗 `total = used + waste`；REVERSED 必须带撤销时间与原因。
- **I6** 每条消耗恰好一条 CONSUMPTION 流水；REVERSED 再恰好一条等额 REVERSAL。
- **I7** 批次状态与余额一致（ACTIVE>0，DEPLETED/ARCHIVED=0）。
- **I8** 消耗的需求必须属于同一项目且材料一致（跨实体串接即破坏隔离）。
- **I9** 消耗引用的项目与批次不得悬空。
