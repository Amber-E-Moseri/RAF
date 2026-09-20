import { DEFAULT_HOUSEHOLD_ID } from "../lib/constants";
import type {
  BankStatementImportResponse,
  ImportedTransaction,
  ImportedTransactionListResponse,
  ImportClassificationPayload,
  ImportReviewRule,
  ImportReviewRuleListResponse,
  ImportReviewRuleUpdatePayload,
  ImportHistoryListResponse,
  ImportHistoryDetailResponse,
} from "../lib/types";
import { deleteJson, getJson, patchJson, postForm, postJson } from "./client";

const importHeaders = {
  "x-household-id": DEFAULT_HOUSEHOLD_ID,
};

export function getImportedTransactions() {
  return getJson<ImportedTransactionListResponse>("/imports", undefined, {
    headers: importHeaders,
  });
}

export function importBankStatement(file: File) {
  const formData = new FormData();
  formData.set("file", file);

  return postForm<BankStatementImportResponse>("/imports/bank-statement", formData, undefined, {
    headers: importHeaders,
  });
}

export function ignoreImportedTransaction(importId: string, reviewNote?: string) {
  return postJson<ImportedTransaction>(`/imports/${importId}/ignore`, { review_note: reviewNote ?? "" }, undefined, {
    headers: importHeaders,
  });
}

export function unignoreImportedTransaction(importId: string) {
  return postJson<ImportedTransaction>(`/imports/${importId}/unignore`, {}, undefined, {
    headers: importHeaders,
  });
}

export function unprocessImportedTransaction(importId: string) {
  return postJson<ImportedTransaction>(`/imports/${importId}/unprocess`, {}, undefined, {
    headers: importHeaders,
  });
}

export function classifyImportedTransaction(importId: string, payload: ImportClassificationPayload) {
  return postJson<ImportedTransaction>(`/imports/${importId}/classify`, payload, undefined, {
    headers: importHeaders,
  });
}

export function getImportReviewRules() {
  return getJson<ImportReviewRuleListResponse>("/import-rules", undefined, {
    headers: importHeaders,
  });
}

export function updateImportReviewRule(ruleId: string, payload: ImportReviewRuleUpdatePayload) {
  return patchJson<ImportReviewRule>(`/import-rules/${ruleId}`, payload, undefined, {
    headers: importHeaders,
  });
}

export function deleteImportReviewRule(ruleId: string) {
  return deleteJson<{ success: true }>(`/import-rules/${ruleId}`, undefined, {
    headers: importHeaders,
  });
}

export function getImportHistory() {
  return getJson<ImportHistoryListResponse>("/imports/history/list", undefined, { headers: importHeaders });
}

export function getImportHistoryDetail(importId: string) {
  return getJson<ImportHistoryDetailResponse>(`/imports/history/${importId}`, undefined, { headers: importHeaders });
}
