import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { getHouseholdSettings } from "../api/householdApi";
import { getDashboardReport, getFinancialHealthReport } from "../api/reportsApi";
import { FinancialHealthIndicator } from "../components/dashboard/FinancialHealthIndicator";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { PageShell } from "../components/layout/PageShell";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { useAsyncData } from "../hooks/useAsyncData";
import { Money } from "../components/ui/Money";
import { formatMonthLabel } from "../lib/period";
import type { AllocationCategory, DashboardReport, FinancialHealthReport } from "../lib/types";

interface InsightsViewModel {
  categories: AllocationCategory[];
  dashboard: DashboardReport;
  financialHealthHistory: FinancialHealthReport[];
  activeMonthLabel: string;
}

function parseMoney(value: string | null | undefined) {
  const numeric = Number(value ?? "0");
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildYearToDateMonths(activeMonth: string) {
  const year = activeMonth.slice(0, 4);
  const finalMonth = Number(activeMonth.slice(5, 7));
  return Array.from({ length: finalMonth }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}-01`);
}

function insightBarColor(index: number) {
  const colors = [
    "bg-emerald-500",
    "bg-blue-500",
    "bg-amber-600",
    "bg-violet-500",
    "bg-pink-500",
    "bg-stone-500",
  ];

  return colors[index % colors.length];
}

export function Insights({
  eyebrow: eyebrowProp,
  title: titleProp,
  description: descriptionProp,
}: {
  eyebrow?: string;
  title?: string;
  description?: string;
} = {}) {
  const eyebrow = eyebrowProp ?? "Insights";
  const title = titleProp ?? "Insights";
  const description = descriptionProp ?? "Year-to-date trends and analytics.";
  const { data, error, isLoading, reload } = useAsyncData<InsightsViewModel>(async () => {
    const household = await getHouseholdSettings();
    const yearStart = `${household.activeMonth.slice(0, 4)}-01-01`;
    const healthMonths = buildYearToDateMonths(household.activeMonth);

    const [categories, dashboard, financialHealthHistory] = await Promise.all([
      getAllocationCategories(),
      getDashboardReport({ from: yearStart, to: household.activeMonth }),
      Promise.all(healthMonths.map((month) => getFinancialHealthReport(month))),
    ]);

    return {
      categories,
      dashboard,
      financialHealthHistory,
      activeMonthLabel: formatMonthLabel(household.activeMonth.slice(0, 7)),
    };
  }, []);

  if (isLoading) {
    return (
      <PageShell eyebrow={eyebrow} title={title} description={description}>
        <LoadingState label="Loading insights..." />
      </PageShell>
    );
  }

  if (error || !data) {
    return (
      <PageShell eyebrow={eyebrow} title={title} description={description}>
        <ErrorState title="Failed to load insights" message={error ?? "Insights could not be loaded."} onRetry={() => void reload()} />
      </PageShell>
    );
  }

  const ytdProgressByBucketId = new Map((data.dashboard.ytd_bucket_progress ?? []).map((progress) => [progress.bucket_id, progress]));
  const healthHistory = data.financialHealthHistory ?? [];
  const latestHealth = healthHistory[healthHistory.length - 1] ?? null;
  const openingHealth = healthHistory[0] ?? null;
  const healthDelta = latestHealth && openingHealth ? latestHealth.healthScore - openingHealth.healthScore : 0;
  const ytdRows = data.categories
    .filter((category) => category.isActive !== false)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug))
    .map((category) => {
      const progress = ytdProgressByBucketId.get(category.id);
      const allocated = parseMoney(progress?.allocated_this_month ?? "0.00") + parseMoney(progress?.added_this_month ?? "0.00");
      const spent = parseMoney(progress?.used_this_month ?? "0.00");
      const goals = parseMoney(progress?.reserved_for_goals_this_month ?? "0.00");

      return {
        id: category.id,
        label: category.label,
        allocated,
        spent,
        goals,
      };
    });
  const ytdTotalAllocated = ytdRows.reduce((sum, row) => sum + row.allocated, 0);
  const ytdTotalSpent = ytdRows.reduce((sum, row) => sum + row.spent, 0);
  const ytdGoalFunding = ytdRows.reduce((sum, row) => sum + row.goals, 0);

  return (
    <PageShell
      eyebrow={eyebrow}
      title={title}
      description={description}
    >
      {latestHealth ? (
        <FinancialHealthIndicator
          report={latestHealth}
          title="Financial Health Score"
          subtitle="Current month score and pillar breakdown, using the same monthly health model shown elsewhere in RAF."
        />
      ) : null}

      <Card title="Yearly Score Trend" subtitle="Month-by-month financial health across the current year">
        {healthHistory.length ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
                <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Latest score</div>
                <div className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--text-strong)]">{latestHealth?.healthScore ?? 0}</div>
              </div>
              <div className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
                <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Change this year</div>
                <div className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--text-strong)]">
                  {healthDelta >= 0 ? "+" : ""}
                  {healthDelta}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              {healthHistory.map((entry) => (
                <div
                  key={entry.reviewMonth ?? entry.activeMonthIncome}
                  className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3"
                  style={{ background: "var(--surface-plain)" }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold text-[var(--text-strong)]">
                        {entry.reviewMonth ? formatMonthLabel(entry.reviewMonth.slice(0, 7)) : "Month"}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                        {entry.healthPillars.length ? entry.healthPillars.map((pillar) => `${pillar.label} ${pillar.score}`).join(" · ") : "No breakdown available"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-medium text-[var(--text-muted)]">Score</div>
                      <div className="mt-1 text-[17px] font-semibold text-[var(--text-strong)]">{entry.healthScore}</div>
                    </div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, entry.healthScore))}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            title="No score trend yet"
            message="Once RAF has monthly data for this year, the health score trend will appear here."
          />
        )}
      </Card>

      <Card title="Dashboard Insights" subtitle="Year-to-date allocation overview">
        {ytdRows.length ? (
          <div className="space-y-3">
            {ytdRows.map((row, index) => {
              const width = ytdTotalAllocated === 0 ? 0 : Math.max(0, Math.min(100, (row.allocated / ytdTotalAllocated) * 100));

              return (
                <div key={row.id} className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold text-[var(--text-strong)]">{row.label}</div>
                      <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                        Spent <Money value={row.spent.toFixed(2)} /> | Goals <Money value={row.goals.toFixed(2)} />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] font-medium text-[var(--text-muted)]">YTD allocated</div>
                      <div className="mt-1 text-[17px] font-semibold text-[var(--text-strong)]">{<Money value={row.allocated.toFixed(2)} />}</div>
                    </div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
                    <div className={`h-full rounded-full ${insightBarColor(index)}`} style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No YTD insights yet"
            message="Once this year has category activity, RAF will show year-to-date allocation analytics here."
          />
        )}
      </Card>

      <Card title="YTD Summary" subtitle="High-level year-to-date totals">
        <div className="grid gap-3">
          <div className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Allocated</div>
            <div className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--text-strong)]">{<Money value={ytdTotalAllocated.toFixed(2)} />}</div>
          </div>
          <div className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Spent</div>
            <div className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--text-strong)]">{<Money value={ytdTotalSpent.toFixed(2)} />}</div>
          </div>
          <div className="rounded-[1.35rem] border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Goal funding</div>
            <div className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--text-strong)]">{<Money value={ytdGoalFunding.toFixed(2)} />}</div>
          </div>
        </div>
      </Card>
    </PageShell>
  );
}
