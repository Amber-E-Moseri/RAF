import type {
  Transaction,
  TransactionCreateRequest,
  TransactionListResponse,
  TransactionSplitDraft,
  TransactionSplitsResponse,
} from "../lib/types";
import { deleteJson, getJson, patchJson, postJson, putJson } from "./client";

export interface TransactionsQuery {
  from: string;
  to: string;
  categoryId?: string | null;
  categorySlug?: string | null;
  reviewed?: boolean | null;
  cursor?: string | null;
  limit?: number;
}

export interface BulkReviewPayload {
  transactionIds: string[];
}

export interface BulkReviewResult {
  reviewedIds: string[];
  reviewedAt: string;
}

export function getTransactions(query: TransactionsQuery) {
  return getJson<TransactionListResponse>("/transactions", query as unknown as Record<string, string | number | null | undefined>);
}

export function createTransaction(payload: TransactionCreateRequest) {
  return postJson<Transaction>("/transactions", payload);
}

export function updateTransaction(transactionId: string, payload: Partial<TransactionCreateRequest>) {
  return patchJson<Transaction>(`/transactions/${transactionId}`, payload);
}

export function deleteTransaction(transactionId: string) {
  return deleteJson<void>(`/transactions/${transactionId}`);
}

export function getTransactionSplits(transactionId: string) {
  return getJson<TransactionSplitsResponse>(`/transactions/${transactionId}/splits`);
}

export function setTransactionSplits(transactionId: string, splits: TransactionSplitDraft[]) {
  return putJson<TransactionSplitsResponse>(`/transactions/${transactionId}/splits`, { splits });
}

export function clearTransactionSplits(transactionId: string) {
  return deleteJson<void>(`/transactions/${transactionId}/splits`);
}

export function markTransactionReviewed(transactionId: string) {
  return postJson<Transaction>(`/transactions/${transactionId}/review`, {});
}

export function markTransactionUnreviewed(transactionId: string) {
  return deleteJson<Transaction>(`/transactions/${transactionId}/review`);
}

export function bulkReviewTransactions(payload: BulkReviewPayload) {
  return postJson<BulkReviewResult>("/transactions/bulk-review", payload);
}

export interface TransactionSuggestion {
  id: string;
  normalized_description: string;
  normalized_merchant: string | null;
  classification_type: string | null;
  category_id: string | null;
  linked_debt_id: string | null;
  linked_fixed_bill_id: string | null;
  linked_goal_id: string | null;
  rule_type: string;
  auto_apply: boolean;
  confirmation_count: number;
  correction_count: number;
}

export interface TransactionSuggestionResponse {
  suggestion: TransactionSuggestion | null;
}

export function fetchTransactionSuggestion(transactionId: string) {
  return getJson<TransactionSuggestionResponse>(`/transactions/${transactionId}/suggestion`);
}
