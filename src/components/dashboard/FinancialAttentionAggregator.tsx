/**
 * Financial Attention Aggregator
 * Currently implements IMPORT_REVIEW only.
 * RECONCILIATION_DISCREPANCY deferred (requires open-discrepancy query integration).
 * GOAL_FUNDING_REVIEW deferred (requires Goal lifecycle branch, Phase-2 gate).
 * Hidden when no items. Max 3 visible; overflow summarized as "... and N more".
 * Derived on each render; no persistent state. No permanent Inbox nav; Home only.
 */
import { Link } from "react-router-dom";
import { Card } from "../ui/Card";

export type AttentionItemType =
  | "IMPORT_REVIEW"
  | "TRANSACTION_REVIEW"
  | "RECONCILIATION_DISCREPANCY"
  | "GOAL_FUNDING_REVIEW";

export type AttentionPriority = "BLOCKING" | "ACTION_NEEDED" | "REVIEW";

export interface AttentionItem {
  id: string;
  type: AttentionItemType;
  priority: AttentionPriority;
  title: string;
  description: string;
  action: {
    label: string;
    href: string;
  };
  count?: number;
  metadata?: Record<string, unknown>;
}

interface FinancialAttentionAggregatorProps {
  items: AttentionItem[];
}

export function FinancialAttentionAggregator({ items }: FinancialAttentionAggregatorProps) {
  if (!items.length) return null;
  const visibleItems = items.slice(0, 3);
  const hiddenCount = items.length - visibleItems.length;
  return (
    <Card title="Attention Required" subtitle="Decisions waiting for your action">
      <div className="space-y-3">
        {visibleItems.map((item) => (
          <div
            key={item.id}
            className="flex items-start justify-between gap-3 rounded-lg border px-4 py-3"
            style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[var(--text-strong)]">{item.title}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.description}</p>
            </div>
            <Link to={item.action.href} aria-label={item.action.label}>
              <button
                type="button"
                className="min-h-9 rounded-full border border-[var(--border-color)] bg-[var(--surface-plain)] px-3 py-1.5 text-xs font-medium text-[var(--text-strong)] transition hover:bg-[var(--surface-elevated)]"
              >
                {item.action.label}
              </button>
            </Link>
          </div>
        ))}
        {hiddenCount > 0 && (
          <p className="text-xs text-[var(--text-secondary)]">
            ... and {hiddenCount} more decision{hiddenCount !== 1 ? "s" : ""} awaiting action
          </p>
        )}
      </div>
    </Card>
  );
}

export function deriveAttentionItems({
  unreviewedImportsCount = 0,
  unreviewedTransactionsCount = 0,
}: {
  unreviewedImportsCount?: number;
  unreviewedTransactionsCount?: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (unreviewedTransactionsCount > 0) {
    items.push({
      id: "transaction-review",
      type: "TRANSACTION_REVIEW",
      priority: "REVIEW",
      title: "Transactions Ready to Mark Reviewed",
      description:
        unreviewedTransactionsCount === 1
          ? "1 transaction is categorized and ready to be marked reviewed."
          : `${unreviewedTransactionsCount} transactions are categorized and ready to be marked reviewed.`,
      action: {
        label: "Mark Reviewed",
        href: "#transaction-review",
      },
      count: unreviewedTransactionsCount,
    });
  }
  if (unreviewedImportsCount > 0) {
    items.push({
      id: "import-review",
      type: "IMPORT_REVIEW",
      priority: "ACTION_NEEDED",
      title: "Transactions Need Review",
      description:
        unreviewedImportsCount === 1
          ? "1 imported transaction awaits categorization before month close."
          : `${unreviewedImportsCount} imported transactions await categorization before month close.`,
      action: {
        label: "Review Now",
        href: "/transactions?tab=needs-review",
      },
      count: unreviewedImportsCount,
    });
  }
  return items;
}
