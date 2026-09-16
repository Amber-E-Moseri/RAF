import { Link } from "react-router-dom";

import { getFinancialHealthReport } from "../../api/reportsApi";
import { useAsyncData } from "../../hooks/useAsyncData";
import { Money } from "../ui/Money";

export function BufferStatusCard() {
  const { data, isLoading } = useAsyncData(() => getFinancialHealthReport(), []);

  if (isLoading || !data) return null;

  const floor = Number(data.savingsFloor || "0");
  const savings = Number(data.savingsBalance || "0");
  const isEnabled = data.savingsFloorEnabled === true;
  const fillPercent = floor > 0 ? Math.min(100, Math.max(0, (savings / floor) * 100)) : 100;
  const isAboveFloor = savings >= floor;
  const shortfall = Math.max(0, floor - savings);

  return (
    <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-5" style={{ background: "var(--surface-plain)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Buffer</p>
          <p className="mt-1 text-sm text-[var(--text-strong)]">
            {isEnabled
              ? "A minimum savings reserve to absorb unexpected expenses without disrupting your plan."
              : "Set a savings floor to protect your plan from irregular expenses."}
          </p>
        </div>
        <Link
          to="/settings?tab=financial"
          className="shrink-0 rounded-full border border-[var(--border-color)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-strong)] transition-colors"
        >
          Configure
        </Link>
      </div>

      {isEnabled ? (
        <div className="mt-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Current savings</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={data.savingsBalance} /></p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Floor target</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={data.savingsFloor} /></p>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{
                width: `${fillPercent}%`,
                background: isAboveFloor
                  ? "color-mix(in srgb, var(--primary-color) 72%, var(--text-strong))"
                  : "#b45309",
              }}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            {isAboveFloor
              ? `Buffer maintained — ${fillPercent.toFixed(0)}% of target.`
              : null}
            {!isAboveFloor ? (
              <><Money value={String(shortfall.toFixed(2))} /> short of buffer target.</>
            ) : null}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          A buffer floor alerts you when savings falls below a threshold, so irregular expenses never silently drain your plan.
        </p>
      )}
    </div>
  );
}
