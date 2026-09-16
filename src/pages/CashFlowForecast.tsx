import { type FormEvent, useState } from "react";

import {
  type CashFlowForecast,
  type CreateUpcomingExpenseInput,
  type ForecastDays,
  type UpcomingExpense,
  createUpcomingExpense,
  deleteUpcomingExpense,
  getCashFlowForecast,
  listUpcomingExpenses,
} from "../api/cashFlowForecastApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { PageShell } from "../components/layout/PageShell";
import { useAsyncData } from "../hooks/useAsyncData";
import { formatIsoDate } from "../lib/format";
import { Money } from "../components/ui/Money";
import { useMoneyFormat } from "../hooks/useMoneyFormat";

// ── Helpers ──────────────────────────────────────────────────────────

const DAYS_OPTIONS: { label: string; value: ForecastDays }[] = [
  { label: "30 days", value: 30 },
  { label: "60 days", value: 60 },
  { label: "90 days", value: 90 },
];

const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  expected: "Expected",
  estimated: "Estimated",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  confirmed: "text-emerald-600 dark:text-emerald-400",
  expected: "text-blue-600 dark:text-blue-400",
  estimated: "text-[var(--text-subtle)]",
};

const RISK_COLORS: Record<string, string> = {
  healthy: "text-emerald-600 dark:text-emerald-400",
  tight: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

function parseMoney(value: string | null | undefined): number {
  return Number(value ?? "0") || 0;
}


function confidenceBadge(level: string) {
  return (
    <span className={`text-[11px] font-medium ${CONFIDENCE_COLORS[level] ?? "text-[var(--text-subtle)]"}`}>
      {CONFIDENCE_LABELS[level] ?? level}
    </span>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: "danger" | "warning" | "ok";
}) {
  const valueColor =
    highlight === "danger"
      ? "text-red-600 dark:text-red-400"
      : highlight === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : highlight === "ok"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-[var(--text-primary)]";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4">
      <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">{label}</p>
      <p className={`mt-1 text-[22px] font-bold tabular-nums ${valueColor}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[12px] text-[var(--text-subtle)]">{sub}</p> : null}
    </div>
  );
}

function DeficitBanner({ date }: { date: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800/40 dark:bg-red-900/10">
      <span className="mt-0.5 text-[16px] text-red-500">⚠</span>
      <div>
        <p className="text-[13px] font-semibold text-red-800 dark:text-red-300">Projected deficit detected</p>
        <p className="text-[12px] text-red-700 dark:text-red-400">
          Your projected balance is expected to drop below $0 on {formatIsoDate(date)}. Review your upcoming bills
          or spending, or add income to prevent this.
        </p>
      </div>
    </div>
  );
}

function ConfidenceTotals({ forecast }: { forecast: CashFlowForecast }) {
  const { summaryMetrics } = forecast;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
          Confirmed obligations
        </p>
        <p className="mt-1 text-[18px] font-bold tabular-nums text-[var(--text-primary)]">
          <Money value={summaryMetrics.obligations.totalConfirmedObligations} />
        </p>
        <p className="text-[11px] text-[var(--text-subtle)]">Fixed bills ({forecast.days}-day window)</p>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">
          Expected obligations
        </p>
        <p className="mt-1 text-[18px] font-bold tabular-nums text-[var(--text-primary)]">
          <Money value={summaryMetrics.obligations.totalExpectedObligations} />
        </p>
        <p className="text-[11px] text-[var(--text-subtle)]">Debt payments ({forecast.days}-day window)</p>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
          Estimated variable spending
        </p>
        <p className="mt-1 text-[18px] font-bold tabular-nums text-[var(--text-primary)]">
          <Money value={summaryMetrics.totalEstimatedVariableSpending} />
        </p>
        <p className="text-[11px] text-[var(--text-subtle)]">Trailing 3-month avg (excl. bills)</p>
      </div>
    </div>
  );
}

function AssumptionsPanel({ forecast }: { forecast: CashFlowForecast }) {
  const { assumptions } = forecast;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
      <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
        Forecast Assumptions
      </h3>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex justify-between gap-2 text-[13px]">
          <dt className="text-[var(--text-secondary)]">Liquid cash balance</dt>
          <dd className="font-medium tabular-nums text-[var(--text-primary)]">
            <Money value={assumptions.liquidCashBalance ?? assumptions.startingBalance} />
          </dd>
        </div>
        {parseMoney(assumptions.savingsAccountBalance) > 0 && (
          <div className="flex justify-between gap-2 text-[13px]">
            <dt className="text-[var(--text-secondary)]">Savings accounts</dt>
            <dd className="font-medium tabular-nums text-[var(--text-primary)]">
              <Money value={assumptions.savingsAccountBalance} />
            </dd>
          </div>
        )}
        {parseMoney(assumptions.investmentAccountsExcluded) > 0 && (
          <div className="flex justify-between gap-2 text-[13px]">
            <dt className="text-[var(--text-secondary)]">Investment (excluded from forecast)</dt>
            <dd className="font-medium tabular-nums text-[var(--text-subtle)]">
              <Money value={assumptions.investmentAccountsExcluded} />
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-2 text-[13px]">
          <dt className="text-[var(--text-secondary)]">Avg monthly income</dt>
          <dd className="flex items-center gap-1 font-medium tabular-nums text-[var(--text-primary)]">
            <Money value={assumptions.avgMonthlyIncome} />
            {confidenceBadge(assumptions.incomeConfidence)}
          </dd>
        </div>
        {assumptions.savingsFloorEnabled && (
          <div className="flex justify-between gap-2 text-[13px]">
            <dt className="text-[var(--text-secondary)]">Savings floor</dt>
            <dd className="font-medium tabular-nums text-[var(--text-primary)]">
              <Money value={assumptions.savingsFloor} />
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-2 text-[13px]">
          <dt className="text-[var(--text-secondary)]">Fixed bills tracked</dt>
          <dd className="font-medium tabular-nums text-[var(--text-primary)]">{assumptions.fixedBillsCount}</dd>
        </div>
        {(assumptions.upcomingExpensesCount ?? 0) > 0 && (
          <div className="flex justify-between gap-2 text-[13px]">
            <dt className="text-[var(--text-secondary)]">Upcoming expenses included</dt>
            <dd className="font-medium tabular-nums text-[var(--text-primary)]">
              {assumptions.upcomingExpensesCount}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-2 text-[13px]">
          <dt className="text-[var(--text-secondary)]">Baseline source</dt>
          <dd className="text-[var(--text-secondary)]">{assumptions.baselineSource}</dd>
        </div>
      </dl>

      {(assumptions.obligationCategoriesExcluded ?? []).length > 0 && (
        <div className="mt-3 rounded-lg bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--text-subtle)]">
          <span className="font-medium">Categories excluded from variable baseline</span> (already counted in fixed
          bills): {assumptions.obligationCategoriesExcluded.join(", ")}
        </div>
      )}

      {assumptions.categoryBaselines.filter((b) => parseMoney(b.monthlyAverage) > 0).length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
            Category baselines (monthly avg)
          </p>
          <div className="flex flex-wrap gap-2">
            {assumptions.categoryBaselines
              .filter((b) => parseMoney(b.monthlyAverage) > 0)
              .map((b) => (
                <span
                  key={b.categoryId}
                  className="rounded-full bg-[var(--surface)] px-2.5 py-0.5 text-[12px] text-[var(--text-secondary)]"
                >
                  {b.label}: <Money value={b.monthlyAverage} />
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DailyTimeline({ forecast }: { forecast: CashFlowForecast }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const daysWithActivity = forecast.projections.filter(
    (p) =>
      parseMoney(p.projectedIncome.amount) > 0 ||
      p.projectedFixedBills.bills.length > 0 ||
      p.projectedDebtPayments.byDebt.length > 0 ||
      (p.projectedUpcomingExpenses?.expenses?.length ?? 0) > 0 ||
      p.pressureIndicators.riskLevel !== "healthy",
  );

  if (daysWithActivity.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
        <p className="text-[13px] text-[var(--text-subtle)]">
          No scheduled income, fixed bills, or debt payments in this window.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]">
      <div className="px-5 py-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
          Key events — {forecast.days}-day window
        </h3>
      </div>
      {daysWithActivity.map((p) => {
        const isOpen = expanded === p.date;
        const riskColor = RISK_COLORS[p.pressureIndicators.riskLevel] ?? "";
        const balance = parseMoney(p.projectedBalance);
        const margin = parseMoney(p.projectedAvailableMargin);

        return (
          <div key={p.date}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-[var(--surface)]"
              onClick={() => setExpanded(isOpen ? null : p.date)}
            >
              <div className="min-w-[7rem] text-[12px] font-medium text-[var(--text-secondary)]">
                {formatIsoDate(p.date)}
              </div>

              <div className="flex flex-1 flex-wrap items-center gap-2">
                {parseMoney(p.projectedIncome.amount) > 0 && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                    <Money value={p.projectedIncome.amount} signed /> income
                  </span>
                )}
                {p.projectedFixedBills.bills.map((b) => (
                  <span
                    key={b.billId}
                    className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]"
                  >
                    {b.description} <Money value={b.amount} />
                  </span>
                ))}
                {p.projectedDebtPayments.byDebt.map((d) => (
                  <span
                    key={d.debtId}
                    className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]"
                  >
                    {d.description} <Money value={d.amount} />
                  </span>
                ))}
                {(p.projectedUpcomingExpenses?.expenses ?? []).map((e) => (
                  <span
                    key={e.expenseId}
                    className="rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                  >
                    {e.description} <Money value={e.amount} />
                  </span>
                ))}
                {p.pressureIndicators.riskLevel !== "healthy" && (
                  <span className={`text-[11px] font-medium ${riskColor}`}>
                    ⚠ {p.pressureIndicators.riskLevel}
                  </span>
                )}
              </div>

              <div
                className={`min-w-[6rem] text-right text-[13px] font-semibold tabular-nums ${riskColor || "text-[var(--text-primary)]"}`}
              >
                <Money value={balance} />
              </div>

              <span className="text-[var(--text-subtle)]">{isOpen ? "▲" : "▼"}</span>
            </button>

            {isOpen && (
              <div className="space-y-1.5 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3 text-[12px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-subtle)]">Net cash flow</span>
                  <span
                    className={`font-medium tabular-nums ${parseMoney(p.netCashFlow) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                  >
                    <Money value={p.netCashFlow} signed />
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-subtle)]">Projected balance</span>
                  <span className="font-medium tabular-nums text-[var(--text-primary)]">
                    <Money value={p.projectedBalance} />
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-subtle)]">Available margin</span>
                  <span
                    className={`font-medium tabular-nums ${margin >= 0 ? "text-[var(--text-primary)]" : "text-red-600 dark:text-red-400"}`}
                  >
                    <Money value={p.projectedAvailableMargin ?? "0"} />
                  </span>
                </div>
                {parseMoney(p.projectedCategorySpending.total) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-[var(--text-subtle)]">Est. spending (all categories)</span>
                    <span className="font-medium tabular-nums text-[var(--text-secondary)]">
                      <Money value={p.projectedCategorySpending.total} />
                      <span className="ml-1 text-[10px] font-normal text-[var(--text-subtle)]">estimated</span>
                    </span>
                  </div>
                )}
                {(p.projectedUpcomingExpenses?.expenses ?? []).length > 0 && (
                  <div className="mt-0.5">
                    <p className="text-[var(--text-subtle)]">Planned expenses:</p>
                    {p.projectedUpcomingExpenses.expenses.map((e) => (
                      <div key={e.expenseId} className="flex justify-between pl-2">
                        <span className="text-purple-600 dark:text-purple-400">{e.description}</span>
                        <span className="font-medium tabular-nums text-purple-600 dark:text-purple-400">
                          -<Money value={e.amount} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {p.constraints.belowSavingsFloor && (
                  <p className="mt-1 text-red-600 dark:text-red-400">
                    Balance falls below savings floor (<Money value={p.constraints.savingsFloorAmount} />)
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BalanceChart({ forecast }: { forecast: CashFlowForecast }) {
  const format = useMoneyFormat();
  const balances = forecast.projections.map((p) => parseMoney(p.projectedBalance));
  const max = Math.max(...balances);
  const min = Math.min(...balances, 0);
  const range = max - min || 1;

  const floorCents = parseMoney(forecast.assumptions.savingsFloor);
  const floorPct = forecast.assumptions.savingsFloorEnabled
    ? ((floorCents - min) / range) * 100
    : null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
      <h3 className="mb-4 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
        Projected balance — {forecast.days}-day window
      </h3>
      <div className="relative h-32">
        {floorPct != null && floorPct >= 0 && floorPct <= 100 && (
          <div
            className="absolute inset-x-0 border-t border-dashed border-amber-400/70"
            style={{ bottom: `${floorPct}%` }}
            title={`Savings floor: ${format(forecast.assumptions.savingsFloor)}`}
          />
        )}
        <div className="flex h-full items-end gap-px">
          {balances.map((bal, i) => {
            const heightPct = Math.max(((bal - min) / range) * 100, 1);
            const risk = forecast.projections[i].pressureIndicators.riskLevel;
            const barColor =
              risk === "critical" ? "bg-red-500" : risk === "tight" ? "bg-amber-400" : "bg-emerald-500";
            return (
              <div
                key={forecast.projections[i].date}
                className={`flex-1 rounded-sm ${barColor} opacity-80`}
                style={{ height: `${heightPct}%` }}
                title={`${forecast.projections[i].date}: ${format(bal)}`}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-[var(--text-subtle)]">
        <span>{forecast.startDate}</span>
        <span>{forecast.endDate}</span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> Healthy
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" /> Tight
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-red-500" /> Critical
        </span>
        {forecast.assumptions.savingsFloorEnabled && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-4 border-t-2 border-dashed border-amber-400" /> Floor
          </span>
        )}
      </div>
    </div>
  );
}

const EMPTY_FORM: CreateUpcomingExpenseInput = {
  name: "",
  amount: "",
  expectedDate: "",
  priority: "planned",
  confidence: "expected",
};

function UpcomingExpensesSection({ onForecastInvalidated }: { onForecastInvalidated: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CreateUpcomingExpenseInput>(EMPTY_FORM);

  const {
    data: expensesData,
    isLoading,
    reload: reloadExpenses,
  } = useAsyncData<{ items: UpcomingExpense[] }>(() => listUpcomingExpenses("active"), []);

  const expenses = expensesData?.items ?? [];

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!form.name || !form.amount || !form.expectedDate) return;
    setSaving(true);
    try {
      await createUpcomingExpense(form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      reloadExpenses();
      onForecastInvalidated();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteUpcomingExpense(id);
    reloadExpenses();
    onForecastInvalidated();
  }

  const inputClass =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--text-primary)]/20";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
          Upcoming Expenses
        </h3>
        <button
          type="button"
          className="rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--surface)] transition-opacity hover:opacity-80"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? "Cancel" : "+ Add"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleAdd}
          className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Car repair, Tuition payment"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">Amount ($)</label>
            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">Expected date</label>
            <input
              type="date"
              required
              value={form.expectedDate}
              onChange={(e) => setForm((f) => ({ ...f, expectedDate: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">Priority</label>
            <select
              value={form.priority}
              onChange={(e) =>
                setForm((f) => ({ ...f, priority: e.target.value as "essential" | "planned" | "optional" }))
              }
              className={inputClass}
            >
              <option value="essential">Essential</option>
              <option value="planned">Planned</option>
              <option value="optional">Optional</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">Confidence</label>
            <select
              value={form.confidence}
              onChange={(e) =>
                setForm((f) => ({ ...f, confidence: e.target.value as "confirmed" | "expected" }))
              }
              className={inputClass}
            >
              <option value="confirmed">Confirmed — will definitely happen</option>
              <option value="expected">Expected — likely to happen</option>
            </select>
          </div>
          <div className="flex justify-end sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-[var(--text-primary)] px-4 py-1.5 text-[12px] font-medium text-[var(--surface)] transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save expense"}
            </button>
          </div>
        </form>
      )}

      {isLoading && <p className="text-[13px] text-[var(--text-subtle)]">Loading…</p>}

      {!isLoading && expenses.length === 0 && !showForm && (
        <p className="text-[13px] text-[var(--text-subtle)]">
          No upcoming expenses planned. Add one to include it in the forecast timeline.
        </p>
      )}

      {expenses.length > 0 && (
        <ul className="divide-y divide-[var(--border)]">
          {expenses.map((exp) => (
            <li key={exp.id} className="flex items-center gap-3 py-2.5 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-[var(--text-primary)]">{exp.name}</p>
                <p className="text-[11px] text-[var(--text-subtle)]">
                  {formatIsoDate(exp.expectedDate)} · {exp.priority} · {exp.confidence}
                </p>
              </div>
              <span className="font-semibold tabular-nums text-[var(--text-primary)]">
                <Money value={exp.amount} />
              </span>
              <button
                type="button"
                onClick={() => handleDelete(exp.id)}
                className="ml-1 text-[12px] text-[var(--text-subtle)] transition-colors hover:text-red-500"
                title="Remove"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HeadroomShortfallCard({ forecast }: { forecast: CashFlowForecast }) {
  const { headroom, shortfall } = forecast.summaryMetrics;
  const hasHeadroom = headroom != null && headroom !== "" && parseMoney(headroom) !== 0;
  const hasShortfall = shortfall != null && shortfall !== "" && parseMoney(shortfall) !== 0;
  if (!hasHeadroom && !hasShortfall) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {hasHeadroom && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800/40 dark:bg-emerald-900/10">
          <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Headroom</p>
          <p className="mt-1 text-[22px] font-bold tabular-nums text-emerald-800 dark:text-emerald-300">
            <Money value={headroom!} />
          </p>
          <p className="mt-0.5 text-[12px] text-emerald-700 dark:text-emerald-400">
            Available above obligations this period
          </p>
        </div>
      )}
      {hasShortfall && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-800/40 dark:bg-red-900/10">
          <p className="text-[11px] font-medium uppercase tracking-wide text-red-700 dark:text-red-400">Shortfall</p>
          <p className="mt-1 text-[22px] font-bold tabular-nums text-red-800 dark:text-red-300">
            <Money value={shortfall!} />
          </p>
          <p className="mt-0.5 text-[12px] text-red-700 dark:text-red-400">
            Obligations exceed available income this period
          </p>
        </div>
      )}
    </div>
  );
}

function FreshnessPanel({ forecast }: { forecast: CashFlowForecast }) {
  const { freshnessBreakdown, daysSinceOldestBalance, accountBalanceAsOf } = forecast.assumptions;
  if (!freshnessBreakdown || freshnessBreakdown.length === 0) return null;

  const oldestAge = daysSinceOldestBalance;
  const staleThreshold = 3;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
          Balance Freshness
        </h3>
        {accountBalanceAsOf && (
          <span className="text-[12px] text-[var(--text-subtle)]">
            As of {formatIsoDate(accountBalanceAsOf)}
          </span>
        )}
      </div>
      {oldestAge != null && oldestAge > staleThreshold && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/10 dark:text-amber-300">
          Oldest balance is {oldestAge} day{oldestAge === 1 ? "" : "s"} old — may not include recent transactions.
          Forecast accuracy improves with fresher data; older balances remain the best available until refreshed.
        </div>
      )}
      <div className="divide-y divide-[var(--border)]">
        {freshnessBreakdown.map((acct) => (
          <div key={acct.accountId} className="flex items-center gap-3 py-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[var(--text-primary)]">{acct.accountName}</p>
              <p className="text-[11px] text-[var(--text-subtle)]">{acct.accountType}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold tabular-nums text-[var(--text-primary)]"><Money value={acct.balance} /></p>
              {acct.balanceAgeInDays != null && (
                <p className={`text-[11px] ${acct.balanceAgeInDays > staleThreshold ? "text-amber-600 dark:text-amber-400" : "text-[var(--text-subtle)]"}`}>
                  {acct.balanceAgeInDays === 0 ? "today" : `${acct.balanceAgeInDays}d ago`}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountCompositionPanel({ forecast }: { forecast: CashFlowForecast }) {
  const { accountBreakdown } = forecast.assumptions;
  if (!accountBreakdown || accountBreakdown.length === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
      <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
        Account Composition
      </h3>
      <div className="divide-y divide-[var(--border)]">
        {accountBreakdown.map((acct, i) => (
          <div key={acct.accountId ?? i} className="flex items-center gap-3 py-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <p className="font-medium capitalize text-[var(--text-primary)]">{acct.type.replace(/_/g, " ")}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold tabular-nums text-[var(--text-primary)]"><Money value={acct.balance} /></p>
              {acct.balanceAsOf && (
                <p className="text-[11px] text-[var(--text-subtle)]">as of {formatIsoDate(acct.balanceAsOf)}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CoverageGapWarning({ forecast }: { forecast: CashFlowForecast }) {
  const gaps = forecast.assumptions.coverageGaps;
  if (!gaps || gaps.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-800/40 dark:bg-amber-900/10">
      <h3 className="mb-2 text-[13px] font-semibold text-amber-800 dark:text-amber-300">
        Coverage gaps ({gaps.length})
      </h3>
      <p className="mb-3 text-[12px] text-amber-700 dark:text-amber-400">
        The following accounts have payment activity that RAF cannot fully attribute. The forecast excludes these obligations.
      </p>
      <ul className="space-y-1.5">
        {gaps.map((gap) => (
          <li key={gap.accountId} className="flex items-center gap-2 text-[12px] text-amber-700 dark:text-amber-400">
            <span className="font-medium">{gap.name}</span>
            <span className="text-amber-500">·</span>
            <span className="capitalize">{gap.accountType.replace(/_/g, " ")}</span>
            <span className="ml-auto rounded-full bg-amber-200/50 px-1.5 py-0.5 text-[10px] font-medium dark:bg-amber-800/30">
              payment coverage unknown
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PendingReviewWarning({ forecast }: { forecast: CashFlowForecast }) {
  const count = forecast.assumptions.pendingReviewCount;
  if (!count || count === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800/40 dark:bg-blue-900/10">
      <span className="mt-0.5 text-[16px] text-blue-500">ℹ</span>
      <p className="text-[13px] text-blue-800 dark:text-blue-300">
        <strong>{count} transaction{count === 1 ? "" : "s"} pending review.</strong>{" "}
        Unreviewed transactions may affect category baselines used in this forecast.
      </p>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CashFlowForecast() {
  const format = useMoneyFormat();
  const [selectedDays, setSelectedDays] = useState<ForecastDays>(30);

  const { data: forecast, isLoading, error, reload } = useAsyncData<CashFlowForecast>(
    () => getCashFlowForecast(selectedDays),
    [selectedDays],
  );

  const tabActions = (
    <div className="flex overflow-hidden rounded-lg border border-[var(--border)]">
      {DAYS_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => setSelectedDays(opt.value)}
          className={`px-4 py-1.5 text-[13px] font-medium transition-colors ${
            selectedDays === opt.value
              ? "bg-[var(--text-primary)] text-[var(--surface)]"
              : "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface)]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );

  return (
    <PageShell
      eyebrow="Cash Flow"
      title="See the next 30 days with context."
      description="RAF keeps household cash pooled, separates freshness from certainty, and avoids inventing obligations it cannot prove."
      actions={tabActions}
    >
      {isLoading && <LoadingState label="Building forecast…" />}
      {error && !isLoading && <ErrorState message={error} onRetry={reload} />}

      {forecast && !isLoading && (
        <div className="space-y-5">
          {/* Pending review advisory */}
          <PendingReviewWarning forecast={forecast} />

          {/* Deficit warning — primary alert when balance goes negative */}
          {forecast.summaryMetrics.firstProjectedDeficitDate && (
            <DeficitBanner date={forecast.summaryMetrics.firstProjectedDeficitDate} />
          )}

          {/* Primary summary: liquid position, available margin, lowest balance, avg net flow */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard
              label="Liquid cash"
              value={format(forecast.assumptions.liquidCashBalance ?? forecast.assumptions.startingBalance)}
              sub="Checking + cash accounts"
            />
            <SummaryCard
              label="Lowest available margin"
              value={format(forecast.summaryMetrics.lowestProjectedAvailableMargin?.amount ?? "0")}
              sub={
                forecast.summaryMetrics.lowestProjectedAvailableMargin?.date
                  ? `on ${formatIsoDate(forecast.summaryMetrics.lowestProjectedAvailableMargin.date)}`
                  : undefined
              }
              highlight={
                parseMoney(forecast.summaryMetrics.lowestProjectedAvailableMargin?.amount) < 0
                  ? "danger"
                  : parseMoney(forecast.summaryMetrics.lowestProjectedAvailableMargin?.amount) <
                      parseMoney(forecast.assumptions.savingsFloor) * 0.1
                    ? "warning"
                    : "ok"
              }
            />
            <SummaryCard
              label="Lowest projected balance"
              value={format(forecast.summaryMetrics.lowestProjectedBalance.amount)}
              sub={`on ${formatIsoDate(forecast.summaryMetrics.lowestProjectedBalance.date)}`}
              highlight={
                parseMoney(forecast.summaryMetrics.lowestBalanceMargin.amount) < 0
                  ? "danger"
                  : parseMoney(forecast.summaryMetrics.lowestProjectedBalance.amount) <
                      parseMoney(forecast.assumptions.savingsFloor)
                    ? "warning"
                    : "ok"
              }
            />
            <SummaryCard
              label="Avg daily net flow"
              value={parseMoney(forecast.summaryMetrics.averageDailyNetFlow) > 0 ? `+${format(forecast.summaryMetrics.averageDailyNetFlow)}` : format(forecast.summaryMetrics.averageDailyNetFlow)}
              highlight={parseMoney(forecast.summaryMetrics.averageDailyNetFlow) >= 0 ? "ok" : "danger"}
            />
          </div>

          {/* Confidence legend */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-2.5 text-[12px]">
            <span className="font-medium text-[var(--text-subtle)]">Confidence:</span>
            {Object.entries(CONFIDENCE_LABELS).map(([key, label]) => (
              <span key={key} className={`flex items-center gap-1 ${CONFIDENCE_COLORS[key]}`}>
                <span className="font-semibold">{label}</span>
                <span className="text-[var(--text-subtle)]">
                  {key === "confirmed" && "— user-entered bills"}
                  {key === "expected" && "— scheduled income & debt payments"}
                  {key === "estimated" && "— trailing 3-month average"}
                </span>
              </span>
            ))}
          </div>

          {/* Headroom / shortfall — from summaryMetrics */}
          <HeadroomShortfallCard forecast={forecast} />

          {/* Confirmed / expected / estimated totals */}
          <ConfidenceTotals forecast={forecast} />

          <BalanceChart forecast={forecast} />
          <DailyTimeline forecast={forecast} />
          <AssumptionsPanel forecast={forecast} />

          {/* Account-level freshness breakdown */}
          <FreshnessPanel forecast={forecast} />

          {/* Account type composition */}
          <AccountCompositionPanel forecast={forecast} />

          {forecast.pressurePoints.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-800/40 dark:bg-amber-900/10">
              <h3 className="mb-2 text-[13px] font-semibold text-amber-800 dark:text-amber-300">Pressure points</h3>
              <ul className="space-y-1">
                {forecast.pressurePoints.map((pp) => (
                  <li
                    key={`${pp.date}-${pp.reason}`}
                    className="flex items-center gap-2 text-[13px] text-amber-700 dark:text-amber-400"
                  >
                    <span className="font-medium">{formatIsoDate(pp.date)}</span>
                    <span className="text-amber-500">—</span>
                    <span>{pp.reason}</span>
                    <span className={`ml-auto text-[11px] font-semibold ${RISK_COLORS[pp.riskLevel] ?? ""}`}>
                      {pp.riskLevel}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Coverage gaps — accounts with unknown payment attribution */}
          <CoverageGapWarning forecast={forecast} />

          {/* Upcoming expenses — manage planned one-time expenses */}
          <UpcomingExpensesSection onForecastInvalidated={reload} />

          <p className="text-center text-[11px] text-[var(--text-subtle)]">
            Forecast generated {new Date(forecast.generatedAt).toLocaleString()} · This is a projection, not a
            guarantee. Actual income, bills, and spending may differ.
          </p>
        </div>
      )}
    </PageShell>
  );
}
