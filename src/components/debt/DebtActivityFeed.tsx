import { useState } from "react";
import { getDebtActivity } from "../../api/debtsApi";
import { ErrorState } from "../feedback/ErrorState";
import { LoadingState } from "../feedback/LoadingState";
import { Badge } from "../ui/Badge";
import { Money } from "../ui/Money";
import { useAsyncData } from "../../hooks/useAsyncData";
import { formatIsoDate } from "../../lib/format";
import type { DebtActivityFull, DebtActivityItem, DebtActivityType } from "../../lib/types";

interface DebtActivityFeedProps {
  debtId: string;
  onMatchesAvailable?: (data: DebtActivityFull) => void;
}

function activityTypeLabel(type: DebtActivityType): string {
  switch (type) {
    case "payment": return "Payment";
    case "interest": return "Interest";
    case "fee": return "Fee";
    case "adjustment": return "Adjustment";
    case "balance_reconciliation": return "Balance reconciliation";
    default: return type;
  }
}

function activityTypeTone(type: DebtActivityType): "success" | "warning" | "danger" | "neutral" {
  switch (type) {
    case "payment": return "success";
    case "interest": return "warning";
    case "fee": return "danger";
    default: return "neutral";
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case "manual": return "Manual";
    case "import": return "Imported";
    case "buffer": return "Buffer";
    case "monthly_review": return "Monthly review";
    case "system": return "System";
    case "reconciliation": return "Reconciliation";
    default: return "";
  }
}

function ActivityRow({ activity }: { activity: DebtActivityItem }) {
  const amountDisplay = (activity.amountCents / 100).toFixed(2);
  const src = sourceLabel(activity.source);

  return (
    <div className="flex items-start justify-between gap-3 py-3 border-b border-[var(--border-color)] last:border-0">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={activityTypeTone(activity.type)}>{activityTypeLabel(activity.type)}</Badge>
          {src ? (
            <span className="text-[10px] text-[var(--text-muted)] font-medium">{src}</span>
          ) : null}
        </div>
        <p className="text-xs text-[var(--text-muted)]">{formatIsoDate(activity.effectiveDate)}</p>
      </div>
      <div className="flex-shrink-0 text-right">
        <p className="text-sm font-semibold text-[var(--text-strong)]">
          <Money value={amountDisplay} />
        </p>
      </div>
    </div>
  );
}

export function DebtActivityFeed({ debtId, onMatchesAvailable }: DebtActivityFeedProps) {
  const [view, setView] = useState<"economic" | "raw">("economic");

  const { data, error, isLoading, reload } = useAsyncData(async () => {
    const result = await getDebtActivity(debtId, { view });
    if (view === "economic" && "matches" in result && onMatchesAvailable) {
      onMatchesAvailable(result as DebtActivityFull);
    }
    return result;
  }, [debtId, view]);

  const activities = data && "activities" in data ? data.activities : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[9px] font-black uppercase tracking-[0.12em] text-[var(--text-muted)]">Payment activity</p>
        <div className="flex gap-1 rounded-full border border-[var(--border-color)] bg-[var(--surface-elevated)] p-0.5">
          <button
            type="button"
            onClick={() => setView("economic")}
            className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${view === "economic" ? "bg-[var(--primary-color)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"}`}
          >
            Economic
          </button>
          <button
            type="button"
            onClick={() => setView("raw")}
            className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${view === "raw" ? "bg-[var(--primary-color)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"}`}
          >
            All records
          </button>
        </div>
      </div>

      {view === "economic" ? (
        <p className="text-[10px] text-[var(--text-muted)]">
          Confirmed duplicate payments are counted once.
        </p>
      ) : (
        <p className="text-[10px] text-[var(--text-muted)]">
          All recorded payments and adjustments, including possible duplicates.
        </p>
      )}

      {isLoading ? <LoadingState label="Loading activity..." /> : null}
      {!isLoading && error ? (
        <ErrorState title="Failed to load activity" message={error} onRetry={() => void reload()} />
      ) : null}
      {!isLoading && !error && activities.length === 0 ? (
        <p className="py-4 text-center text-xs text-[var(--text-muted)]">No activity recorded yet.</p>
      ) : null}
      {!isLoading && !error && activities.length > 0 ? (
        <div>
          {activities.map((item) => (
            <ActivityRow key={item.id} activity={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
