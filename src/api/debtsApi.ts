import type {
  Debt,
  DebtActivity,
  DebtCreateRequest,
  DebtListResponse,
  DebtMatchClassification,
  DebtPaymentPaceAcknowledgement,
  DebtReconciliation,
} from "../lib/types";
import { deleteJson, getJson, patchJson, postJson } from "./client";

export function getDebts() {
  return getJson<DebtListResponse>("/debts");
}

export function createDebt(payload: DebtCreateRequest) {
  return postJson<Debt>("/debts", payload);
}

export function updateDebt(debtId: string, payload: Partial<DebtCreateRequest> & { isActive?: boolean }) {
  return patchJson<Debt>(`/debts/${debtId}`, payload);
}

export function deleteDebt(debtId: string) {
  return deleteJson<void>(`/debts/${debtId}`);
}

export function getDebtActivity(debtId: string, params?: { view?: "economic" | "raw"; month?: string }) {
  return getJson<DebtActivity>(`/debts/${debtId}/activity`, params as Record<string, string | undefined>);
}

export function getDebtPaymentReconciliations(debtId: string) {
  return getJson<DebtReconciliation[]>(`/debts/${debtId}/payment-reconciliations`);
}

export function confirmDebtReconciliation(
  debtId: string,
  payload: { primaryPaymentId: string; duplicatePaymentId: string; matchType: DebtMatchClassification },
) {
  return postJson<DebtReconciliation>(`/debts/${debtId}/payment-reconciliations`, payload);
}

export function rejectDebtReconciliation(
  debtId: string,
  payload: { primaryPaymentId: string; duplicatePaymentId: string; matchType: DebtMatchClassification },
) {
  return postJson<DebtReconciliation>(`/debts/${debtId}/payment-reconciliations`, { action: "reject", ...payload });
}

export function unlinkDebtReconciliation(
  debtId: string,
  payload: { primaryPaymentId: string; duplicatePaymentId: string },
) {
  return deleteJson<DebtReconciliation>(
    `/debts/${debtId}/payment-reconciliations`,
    { primaryPaymentId: payload.primaryPaymentId, duplicatePaymentId: payload.duplicatePaymentId },
  );
}

export function acknowledgePaceInsight(
  debtId: string,
  payload: {
    action: DebtPaymentPaceAcknowledgement["action"];
    paymentPeriodMonth: string;
    newMonthlyPayment?: string;
  },
) {
  return postJson<{ acknowledged: boolean; acknowledgement: DebtPaymentPaceAcknowledgement; debt: Debt }>(
    `/debts/${debtId}/pace-acknowledgement`,
    payload,
  );
}
