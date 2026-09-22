import { randomUUID } from "node:crypto";
import type { E2EContext } from "./harness.js";

/**
 * 端到端测试固定装置：所有创建都走真实 HTTP API，保证测试覆盖鉴权、
 * 校验、事务、SQL 约束与序列化的完整链路。
 */

export async function createMaterial(
  ctx: E2EContext,
  overrides: { name?: string; stockUnit?: string; lowStockThreshold?: string | null } = {}
): Promise<{ id: string; name: string; stockUnit: string }> {
  const suffix = randomUUID().slice(0, 8);
  const response = await ctx.request("POST", "/api/v1/materials", {
    body: {
      name: overrides.name ?? `E2E 材料 ${suffix}`,
      craftTypes: ["DYEING"],
      stockUnit: overrides.stockUnit ?? "g",
      lowStockThreshold: overrides.lowStockThreshold === undefined ? null : overrides.lowStockThreshold
    }
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建材料失败：${response.statusCode} ${response.body}`);
  }
  return (response.json() as { data: { id: string; name: string; stock_unit: string } }).data as unknown as {
    id: string;
    name: string;
    stockUnit: string;
  };
}

export async function createBatch(
  ctx: E2EContext,
  materialId: string,
  overrides: { initialQuantity?: string; entryUnit?: string; batchCode?: string } = {}
): Promise<BatchView> {
  const response = await ctx.request("POST", "/api/v1/batches", {
    body: {
      materialId,
      batchCode: overrides.batchCode ?? `B-${randomUUID().slice(0, 8)}`,
      receivedAt: "2026-09-01",
      initialQuantity: overrides.initialQuantity ?? "1000",
      entryUnit: overrides.entryUnit ?? "g"
    }
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建批次失败：${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: Record<string, unknown> };
  return normalizeBatch(body.data);
}

export async function createProject(
  ctx: E2EContext,
  overrides: { name?: string; status?: string; dueDate?: string | null } = {}
): Promise<{ id: string; name: string; status: string; version: number }> {
  const suffix = randomUUID().slice(0, 8);
  const response = await ctx.request("POST", "/api/v1/projects", {
    body: {
      name: overrides.name ?? `E2E 项目 ${suffix}`,
      craftType: "DYEING",
      status: overrides.status ?? "PLANNED",
      dueDate: overrides.dueDate === undefined ? "2026-12-31" : overrides.dueDate
    }
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建项目失败：${response.statusCode} ${response.body}`);
  }
  return (response.json() as { data: { id: string; name: string; status: string; version: number } }).data;
}

export type BatchView = {
  id: string;
  remainingQuantity: string;
  initialQuantity: string;
  stockUnit: string;
  status: string;
  version: number;
};

export function normalizeBatch(data: Record<string, unknown>): BatchView {
  return {
    id: String(data.id),
    remainingQuantity: String(data.remaining_quantity ?? data.remainingQuantity),
    initialQuantity: String(data.initial_quantity ?? data.initialQuantity),
    stockUnit: String(data.stock_unit ?? data.stockUnit),
    status: String(data.status),
    version: Number(data.version)
  };
}

export async function getBatch(ctx: E2EContext, batchId: string): Promise<BatchView> {
  const response = await ctx.request("GET", `/api/v1/batches/${batchId}`);
  if (response.statusCode !== 200) {
    throw new Error(`读取批次失败：${response.statusCode} ${response.body}`);
  }
  return normalizeBatch((response.json() as { data: Record<string, unknown> }).data);
}

export async function consume(
  ctx: E2EContext,
  payload: {
    projectId: string;
    batchId: string;
    projectRequirementId?: string;
    usedQuantity: string;
    wasteQuantity: string;
    unit: string;
  },
  headers: Record<string, string> = {}
) {
  return ctx.request("POST", "/api/v1/consumptions", { body: payload, headers });
}

export function errorBody(response: { json(): unknown }): { code: string; message: string } {
  return (response.json() as { error: { code: string; message: string } }).error;
}

/** 通过 SQL 直接读取批次的权威余额（绕过 API 序列化）。 */
export async function readRemainingQuantity(ctx: E2EContext, batchId: string): Promise<string> {
  const result = await ctx.pool.query<{ remaining: string }>(
    "SELECT remaining_quantity::text AS remaining FROM batches WHERE id = $1",
    [batchId]
  );
  if (!result.rows[0]) throw new Error(`批次 ${batchId} 不存在`);
  return result.rows[0].remaining;
}
