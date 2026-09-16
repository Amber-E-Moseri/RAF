import { useMemo } from "react";

import { getAllocationCategories } from "../../api/allocationCategoriesApi";
import { getDashboardReport } from "../../api/reportsApi";
import { usePeriod } from "../layout/PeriodProvider";
import { useAsyncData } from "../../hooks/useAsyncData";
import { Money } from "../ui/Money";

export function PlanExecutionCard() {
  const { activeRange, activeMonthLabel } = usePeriod();

  const { data: categories } = useAsyncData(() => getAllocationCategories(), []);
  const { data: dashboard, isLoading } = useAsyncData(
    () => getDashboardReport({ from: activeRange.from, to: activeRange.to }),
    [activeRange.from, activeRange.to],
  );

  const rows = useMemo(() => {
    if (!categories || !dashboard) return [];
    return categories
      .filter((c) => c.isActive !== false)
      .map((cat) => {
        const prog = dashboard.monthly_bucket_progress.find(
          (p) => p.slug === cat.slug || p.bucket_id === cat.id,
        );
        return {
          id: cat.id,
          label: cat.label,
          isBuffer: cat.isBuffer === true,
          planned: prog?.allocated_this_month ?? "0.00",
          used: prog?.used_this_month ?? "0.00",
          remaining: prog?.remaining_this_month ?? "0.00",
        };
      })
      .filter((r) => Number(r.planned) > 0 || Number(r.used) > 0);
  }, [categories, dashboard]);

  if (isLoading || !rows.length) return null;

  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--border-color)]" style={{ background: "var(--surface-plain)" }}>
      <div className="border-b border-[var(--border-color)] px-4 py-3">
        <p className="text-sm font-semibold text-[var(--text-strong)]">Plan Execution · {activeMonthLabel}</p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">Planned vs actual spend per category this period.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border-color)]">
              <th className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Category</th>
              <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Planned</th>
              <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Used</th>
              <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rem = Number(row.remaining);
              return (
                <tr key={row.id} className="border-b border-[var(--border-color)] last:border-b-0">
                  <td className="px-4 py-2.5 font-medium text-[var(--text-strong)]">
                    {row.label}
                    {row.isBuffer
                      ? <span className="ml-2 rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">Buffer</span>
                      : null}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[var(--text-strong)]">
                    <Money value={row.planned} />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[var(--text-strong)]">
                    <Money value={row.used} />
                  </td>
                  <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${rem < 0 ? "text-red-600" : rem === 0 ? "text-[var(--text-muted)]" : "text-emerald-700"}`}>
                    <Money value={row.remaining} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
