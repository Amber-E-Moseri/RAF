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
  cursor?: string | null;
  limit?: number;
}

export function getTransactions(query: TransactionsQuery) {
  return getJson<TransactionListResponse>("/transactions", query);
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
