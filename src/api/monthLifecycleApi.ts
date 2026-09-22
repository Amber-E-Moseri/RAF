import { deleteJson, getJson, postJson } from "./client";

export type LifecycleState = "OPEN" | "REVIEWING" | "CLOSED";

export interface MonthLifecycleResponse {
  state: LifecycleState;
  period: string;
  version?: number;
  closedAt?: string;
  closedBy?: string | null;
  snapshot?: MonthCloseSnapshot | null;
  bufferDisposition?: BufferDisposition | null;
  closeId?: string;
  review?: Record<string, unknown> | null;
  history?: MonthCloseRecord[];
}

export interface MonthCloseSnapshot {
  capturedAt: string;
  period: string;
  income: { totalReceived: string };
  spending: { totalSpent: string; netSurplus: string };
  allocations: Array<{
    categoryId: string;
    slug: string;
    label: string;
    isBuffer: boolean;
    allocated: string;
    spent: string;
    remaining: string;
  }>;
  buffer: {
    categoryId: string;
    label: string;
    allocated: string;
    spent: string;
    remaining: string;
    overrun: boolean;
    overrunAmount: string;
  } | null;
  goals: {
    contributions: Array<{ goalId: string; goalName: string | null; amount: string }>;
    totalContributions: string;
  };
  debts: {
    payments: Array<{ debtId: string; debtName: string | null; amount: string }>;
    totalPayments: string;
  };
  transactions: { total: number; reviewed: number; unreviewed: number };
}

export interface BufferDisposition {
  type: "apply_to_goal" | "apply_to_debt" | "return_to_plan";
  amount: string;
  targetId?: string | null;
}

export interface MonthCloseRecord {
  id: string;
  period: string;
  version: number;
  status: "CLOSED" | "REOPENED";
  closedAt: string;
  closedBy: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
}

export interface CloseReadinessResponse {
  period: string;
  state: LifecycleState;
  canClose: boolean;
  summary: {
    totalTransactions: number;
    unreviewedTransactions: number;
    hasMonthlyReview: boolean;
    bufferCategory: { id: string; label: string } | null;
    bufferRemaining: string | null;
    goalContributionsTotal: string;
    debtPaymentsTotal: string;
    goalCount: number;
    debtCount: number;
  };
  warnings: Array<{ code: string; message: string; count?: number }>;
  blockers: Array<{ code: string; message: string }>;
}

export interface CloseMonthResponse {
  state: "CLOSED";
  period: string;
  version: number;
  closeId: string;
  closedAt: string;
  snapshot: MonthCloseSnapshot;
  bufferDisposition: BufferDisposition | null;
}

export interface ReopenMonthResponse {
  state: "REVIEWING";
  period: string;
  previousCloseId: string;
  previousCloseVersion: number;
  previousSnapshotPreserved: boolean;
}

export function getMonthLifecycle(period: string) {
  return getJson<MonthLifecycleResponse>("/monthly-reviews/lifecycle", { period });
}

export function startReview(payload: { period: string }) {
  return postJson<{ state: "REVIEWING"; period: string }>("/monthly-reviews/lifecycle", payload);
}

export function getCloseReadiness(period: string) {
  return getJson<CloseReadinessResponse>("/monthly-reviews/close-readiness", { period });
}

export function closeMonth(payload: { period: string; bufferDisposition?: BufferDisposition | null }) {
  return postJson<CloseMonthResponse>("/monthly-reviews/close", payload);
}

export function reopenMonth(payload: { period: string; reason?: string | null }) {
  return postJson<ReopenMonthResponse>("/monthly-reviews/reopen", payload);
}

export function applyBufferDisposition(payload: {
  period: string;
  disposition: BufferDisposition;
}) {
  return postJson<{ applied: boolean; dispositionType: string; amount: string; bufferRemaining: string }>("/monthly-reviews/buffer-disposition", payload);
}
