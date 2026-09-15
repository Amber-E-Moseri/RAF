import type { AttentionItem } from "../components/dashboard/FinancialAttentionAggregator";
import { getJson } from "./client";

export interface FinancialAttentionResponse {
  items: AttentionItem[];
  summary: {
    total: number;
    urgent: number;
    attention: number;
  };
}

export function getFinancialAttention(): Promise<FinancialAttentionResponse> {
  return getJson<FinancialAttentionResponse>("financial-attention");
}
