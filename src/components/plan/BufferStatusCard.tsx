import { useMemo } from "react";

import { getAllocationCategories } from "../../api/allocationCategoriesApi";
import { getDashboardReport } from "../../api/reportsApi";
import { usePeriod } from "../layout/PeriodProvider";
import { useAsyncData } from "../../hooks/useAsyncData";
import { Money } from "../ui/Money";

export function BufferStatusCard() {
  const { activeRange } = usePeriod();

  const { data: categories, isLoading: catLoading } = useAsyncData(
    () => getAllocationCategories(),
    [],
  );
  const { data: dashboard, isLoading: dashLoading, error } = useAsyncData(
    () => getDashboardReport({ from: activeRange.from, to: activeRange.to }),
    [activeRange.from, activeRange.to],
  );

  const isLoading = catLoading || dashLoading;

  const buffer = useMemo(() => {
    if (!categories || !dashboard) return null;

    const bufferCat = categories.find((c) => c.isBuffer === true && c.isActive !== false);
    if (!bufferCat) {
      return { configured: false, label: "", starting: "0.00", used: "0.00", remaining: "0.00" };
    }

    const prog = dashboard.monthly_bucket_progress.find(
      (p) => p.slug === bufferCat.slug || p.bucket_id === bufferCat.id,
    );

    return {
      configured: true,
      label: bufferCat.label,
      starting: prog?.allocated_this_month ?? "0.00",
      used: prog?.used_this_month ?? "0.00",
      remaining: prog?.remaining_this_month ?? "0.00",
    };
  }, [categories, dashboard]);

  if (isLoading) return null;

  if (error) {
    return (
      <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
        <p className="text-sm text-[var(--text-muted)]">Buffer status unavailable.</p>
      </div>
    );
  }

  if (!buffer) return null;

  if (!buffer.configured) {
    return (
      <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-5" style={{ background: "var(--surface-plain)" }}>
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Buffer</p>
        <p className="mt-1 text-sm text-[var(--text-strong)]">No Buffer category configured.</p>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Mark an allocation category as Buffer in its settings to track your reserve separately.
          Buffer absorbs unexpected expenses without disrupting the rest of your plan.
        </p>
      </div>
    );
  }

  const startingNum = Number(buffer.starting);
  const usedNum = Number(buffer.used);
  const remainingNum = Number(buffer.remaining);
  const exceeded = remainingNum < 0;
  const fullyUsed = !exceeded && remainingNum === 0 && usedNum > 0;
  const unused = usedNum === 0;
  const fillPercent = startingNum > 0
    ? Math.min(100, Math.max(0, (remainingNum / startingNum) * 100))
    : 0;

  const statusLabel = exceeded ? "Exceeded" : fullyUsed ? "Fully used" : unused ? "Unused" : "Partially used";
  const fillColor = exceeded || fullyUsed
    ? "var(--status-danger)"
    : unused
      ? "var(--theme-primary)"
      : "var(--status-warning)";

  return (
    <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-5" style={{ background: "var(--surface-plain)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Buffer · {buffer.label}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Reserve set aside to absorb unexpected expenses this period. Display only — no automatic disposition.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border-color)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
          {statusLabel}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Starting</p>
          <p className="mt-1 text-base font-semibold text-[var(--text-strong)]"><Money value={buffer.starting} /></p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Used</p>
          <p className="mt-1 text-base font-semibold text-[var(--text-strong)]"><Money value={buffer.used} /></p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Remaining</p>
          <p className={`mt-1 text-base font-semibold ${exceeded ? "text-red-600" : "text-[var(--text-strong)]"}`}>
            {exceeded
              ? <><Money value={String(Math.abs(remainingNum).toFixed(2))} /> over</>
              : <Money value={buffer.remaining} />}
          </p>
        </div>
      </div>

      {startingNum > 0 && (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
          <div
            className="h-full rounded-full transition-[width] duration-200"
            style={{ width: `${fillPercent}%`, background: fillColor }}
          />
        </div>
      )}
    </div>
  );
}
