import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getAllocationCategoriesAsOf } from "../api/allocationCategoriesApi";
import { ApiError } from "../api/client";
import { getIncome, getIncomeAllocations } from "../api/incomeApi";
import { applyMonthlyReview } from "../api/monthlyReviewApi";
import { getDashboardAggregateReport } from "../api/reportsApi";
import { getTransactions } from "../api/transactionsApi";
import { AllocationBarChart } from "../components/dashboard/AllocationBarChart";
import { FinancialAttentionAggregator, deriveAttentionItems } from "../components/dashboard/FinancialAttentionAggregator";
import { SummaryMetricCard } from "../components/dashboard/SummaryMetricCard";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { MonthReminderBanner } from "../components/feedback/MonthReminderBanner";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { usePeriod } from "../components/layout/PeriodProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { MoneyInput } from "../components/ui/MoneyInput";
import { useAsyncData } from "../hooks/useAsyncData";
import { useMonthWorkflow } from "../hooks/useMonthWorkflow";
import { useAuth } from "../context/AuthContext";
import { formatIsoDate } from "../lib/format";
import { Money } from "../components/ui/Money";
import { useMoneyFormat } from "../hooks/useMoneyFormat";
import { normalizeMoneyInput } from "../lib/validation";
import type {
  AllocationCategory,
  DashboardPeriod,
  IncomeAllocationReport,
  SurplusRecommendationsReport,
  Transaction,
} from "../lib/types";

interface DashboardViewModel {
  dashboard: DashboardViewModelReport;
  categories: AllocationCategory[];
  latestAllocationReport: IncomeAllocationReport | null;
  latestPeriod: DashboardPeriod | null;
  financialHealth: DashboardHealthReport;
  surplusRecommendations: SurplusRecommendationsReport;
  recentTransactions: Transaction[];
  incomeCount: number;
}

interface SurplusSuggestionDraftRow {
  id: string;
  sourceSlug: string;
  destinationSlug: string;
  destinationLabel: string;
  destinationType: "bucket" | "goal" | "debt";
  destinationGoalId: string | null;
  destinationDebtId: string | null;
  amount: string;
}

type DashboardNextStepState =
  | { kind: "historical" }
  | { kind: "month-reminder"; monthKey: string }
  | { kind: "setup-incomplete" }
  | { kind: "closed-current-month" }
  | { kind: "setup-complete-no-income" }
  | { kind: "income-no-transactions" }
  | { kind: "income-transactions-open" }
  | null;

type DashboardAggregateReport = Awaited<ReturnType<typeof getDashboardAggregateReport>>;
type DashboardViewModelReport = DashboardAggregateReport["dashboard"];
type DashboardHealthReport = DashboardAggregateReport["financialHealth"];

function alertTone(status: "ok" | "elevated" | "risky" | undefined) {
  if (status === "risky") {
    return "danger";
  }

  if (status === "elevated") {
    return "warning";
  }

  if (status === "ok") {
    return "success";
  }

  return "neutral";
}

function transactionTone(transaction: Transaction) {
  return transaction.direction === "credit" ? "success" : "warning";
}

function onboardingDismissalKey(workspaceId: string) {
  return `raf:start-here-dismissed:${workspaceId}`;
}

function readOnboardingDismissed(workspaceId: string) {
  if (!workspaceId || typeof window === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(onboardingDismissalKey(workspaceId)) === "true";
  } catch {
    return false;
  }
}

function writeOnboardingDismissed(workspaceId: string) {
  if (!workspaceId || typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(onboardingDismissalKey(workspaceId), "true");
  } catch {}
}

function readSetupDone() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem("raf:setup-done") === "true";
  } catch {
    return false;
  }
}

function monthStatusSubtitle(status: string) {
  const labels: Record<string, string> = {
    closed: "Month closed",
    in_progress: "Month in progress",
    needs_review: "Month needs review",
    open: "Awaiting monthly close",
    pending: "Awaiting monthly close",
    ready_to_close: "Ready for monthly close",
  };

  return labels[status] ?? status.replaceAll("_", " ");
}

function deriveDashboardNextStepState({
  isCurrentMonth,
  setupDone,
  incomeCount,
  recentTransactionCount,
  startHereDismissed,
  activeMonthStatus,
  reminderMonthKey,
}: {
  isCurrentMonth: boolean;
  setupDone: boolean;
  incomeCount: number;
  recentTransactionCount: number;
  startHereDismissed: boolean;
  activeMonthStatus: string;
  reminderMonthKey: string | null;
}): DashboardNextStepState {
  if (!isCurrentMonth) {
    return { kind: "historical" };
  }

  if (reminderMonthKey) {
    return { kind: "month-reminder", monthKey: reminderMonthKey };
  }

  if (!setupDone && incomeCount === 0 && recentTransactionCount === 0 && !startHereDismissed) {
    return { kind: "setup-incomplete" };
  }

  if (activeMonthStatus === "closed") {
    return { kind: "closed-current-month" };
  }

  if (setupDone && incomeCount === 0) {
    return { kind: "setup-complete-no-income" };
  }

  if (incomeCount > 0 && recentTransactionCount === 0) {
    return { kind: "income-no-transactions" };
  }

  if (incomeCount > 0 && recentTransactionCount > 0) {
    return { kind: "income-transactions-open" };
  }

  return null;
}

export function Dashboard() {
  const { activeMonthLabel, activeRange, isCurrentMonth, jumpToCurrentMonth } = usePeriod();
  const format = useMoneyFormat();
  const { session } = useAuth();
  const activeWorkspaceId = session?.workspaceId ?? session?.householdId ?? "local";
  const { from, to } = activeRange;
  const monthWorkflow = useMonthWorkflow(activeRange.from.slice(0, 7));
  const [surplusDraftRows, setSurplusDraftRows] = useState<SurplusSuggestionDraftRow[]>([]);
  const [editingSurplusRowId, setEditingSurplusRowId] = useState<string | null>(null);
  const [surplusRowDraft, setSurplusRowDraft] = useState<{ destinationSlug: string; amount: string }>({ destinationSlug: "", amount: "0.00" });
  const [surplusMessage, setSurplusMessage] = useState<string | null>(null);
  const [surplusApplyError, setSurplusApplyError] = useState<string | null>(null);
  const [isQuickApplyingSurplus, setIsQuickApplyingSurplus] = useState(false);
  const [startHereDismissed, setStartHereDismissed] = useState(() => readOnboardingDismissed(activeWorkspaceId));
  const [setupDone, setSetupDone] = useState(readSetupDone);
  const [howRafWorksOpen, setHowRafWorksOpen] = useState(false);
  const [netSurplusExplanationOpen, setNetSurplusExplanationOpen] = useState(false);

  const { data, error, isLoading, reload } = useAsyncData<DashboardViewModel>(async () => {
    const [aggregate, incomeResponse, transactionsResponse] = await Promise.all([
      getDashboardAggregateReport({ from, to }),
      getIncome({ from, to }),
      getTransactions({ from, to, limit: 10 }),
    ]);

    let categories: AllocationCategory[] = [];

    try {
      categories = await getAllocationCategoriesAsOf(to);
    } catch (loadError) {
      if (!(loadError instanceof ApiError) || loadError.status !== 404) {
        throw loadError;
      }
    }

    const latestIncome = [...incomeResponse.items].sort((left, right) => right.receivedDate.localeCompare(left.receivedDate))[0];
    const latestAllocationReport = latestIncome ? await getIncomeAllocations(latestIncome.incomeId) : null;
    const latestPeriod = [...aggregate.dashboard.periods].sort((left, right) => right.month.localeCompare(left.month))[0] ?? null;

    return {
      dashboard: aggregate.dashboard,
      categories,
      latestAllocationReport,
      latestPeriod,
      financialHealth: aggregate.financialHealth,
      surplusRecommendations: aggregate.surplusRecommendations,
      recentTransactions: transactionsResponse.items.slice(0, 5),
      incomeCount: incomeResponse.items.length,
    };
  }, [from, to]);

  useEffect(() => {
    if (!data?.surplusRecommendations) {
      return;
    }

    setSurplusDraftRows(
      data.surplusRecommendations.distributions
        .filter((distribution) => Number(distribution.amount) > 0)
        .map((distribution, index) => ({
          id: `surplus_row_${index}_${distribution.slug}`,
          sourceSlug: distribution.slug,
          destinationSlug: distribution.destinationBucketSlug ?? distribution.slug,
          destinationLabel: distribution.label,
          destinationType: distribution.destinationType ?? "bucket",
          destinationGoalId: distribution.destinationGoalId ?? null,
          destinationDebtId: distribution.destinationDebtId ?? null,
          amount: distribution.amount,
        })),
    );
    setSurplusMessage(null);
    setSurplusApplyError(null);
    setEditingSurplusRowId(null);
  }, [data?.surplusRecommendations]);

  useEffect(() => {
    setStartHereDismissed(readOnboardingDismissed(activeWorkspaceId));
    setSetupDone(readSetupDone());
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!netSurplusExplanationOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setNetSurplusExplanationOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [netSurplusExplanationOpen]);

  if (isLoading || monthWorkflow.isLoading) {
    return (
      <PageShell eyebrow="Overview" title="Dashboard" description="Your money, with a clear next move.">
        <LoadingState label="Loading the current financial snapshot..." />
      </PageShell>
    );
  }

  if (error || !data || monthWorkflow.error || !monthWorkflow.data) {
    return (
      <PageShell eyebrow="Overview" title="Dashboard" description="Your money, with a clear next move.">
        <ErrorState
          title="Failed to load dashboard"
          message={error ?? monthWorkflow.error ?? "We could not load the current dashboard data. Please try again."}
          onRetry={() => {
            void reload();
            void monthWorkflow.reload();
          }}
        />
      </PageShell>
    );
  }

  const dashboardData = data;
  const workflowData = monthWorkflow.data;

  const activeCategories = dashboardData.categories
    .filter((category) => category.isActive !== false)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug));

  const activeCategoryCount = activeCategories.length || dashboardData.latestAllocationReport?.allocations.length || 0;
  const latestPeriodIncome = dashboardData.latestPeriod?.incomeTotal ?? "0.00";
  const latestSurplus = dashboardData.latestPeriod?.surplusOrDeficit ?? "0.00";
  const netSurplusExplanation = dashboardData.latestPeriod?.explanations?.netSurplus ?? null;
  const activeMonthName = activeMonthLabel.replace(/\s+\d{4}$/, "");
  const bucketBalancesBySlug = new Map(dashboardData.dashboard.bucket_balances.map((bucket) => [bucket.slug, bucket]));
  const monthlyProgressByBucketId = new Map(dashboardData.dashboard.monthly_bucket_progress.map((progress) => [progress.bucket_id, progress]));
  const latestAllocationAmounts = new Map((dashboardData.latestAllocationReport?.allocations ?? []).map((allocation) => [allocation.slug, allocation.amount]));
  const allocationRows = activeCategories.length
    ? activeCategories.map((category) => ({
      bucketId: category.id,
      slug: category.slug,
      label: category.label,
      percent: category.allocationPercent,
      allocatedAmount: latestAllocationAmounts.get(category.slug) ?? null,
      monthlyProgress: monthlyProgressByBucketId.get(category.id) ?? null,
    }))
    : [];

  const savingsBalance = Number(dashboardData.financialHealth.savingsBalance);
  const savingsFloor = Number(dashboardData.financialHealth.savingsFloor);
  const savingsFloorEnabled = dashboardData.financialHealth.savingsFloorEnabled === true;
  const isBelowSavingsFloor = savingsFloorEnabled && savingsBalance < savingsFloor;
  const activeDestinationOptions = activeCategories.map((category) => ({
    slug: category.slug,
    label: category.label,
  }));
  const suggestedRows = savingsFloorEnabled && isBelowSavingsFloor
    ? [...surplusDraftRows].sort((left, right) => (left.destinationSlug === "savings" ? -1 : 0) - (right.destinationSlug === "savings" ? -1 : 0))
    : surplusDraftRows;
  const surplusExists = Number(dashboardData.surplusRecommendations.netSurplus) > 0 && suggestedRows.length > 0;
  const draftTotal = suggestedRows.reduce((sum, row) => sum + Number(normalizeMoneyInput(row.amount) ?? "0.00"), 0);
  const netSurplus = Number(dashboardData.surplusRecommendations.netSurplus);
  const draftMatchesSurplus = Math.abs(draftTotal - netSurplus) < 0.005;
  const editingSurplusRow = suggestedRows.find((row) => row.id === editingSurplusRowId) ?? null;
  const movingSavingsPriorityAway = Boolean(
    editingSurplusRow
    && savingsFloorEnabled
    && isBelowSavingsFloor
    && editingSurplusRow.destinationSlug === "savings"
    && surplusRowDraft.destinationSlug !== "savings",
  );
  const activeMonthStatus = workflowData.activeMonthStatus.status;
  const nextStepState = deriveDashboardNextStepState({
    isCurrentMonth,
    setupDone,
    incomeCount: dashboardData.incomeCount,
    recentTransactionCount: dashboardData.recentTransactions.length,
    startHereDismissed,
    activeMonthStatus,
    reminderMonthKey: workflowData.reminderMonth?.monthKey ?? null,
  });

  function dismissStartHere() {
    writeOnboardingDismissed(activeWorkspaceId);
    setStartHereDismissed(true);
  }

  function handleResetSurplusDraftRows() {
    setSurplusDraftRows(
      dashboardData.surplusRecommendations.distributions
        .filter((distribution) => Number(distribution.amount) > 0)
        .map((distribution, index) => ({
          id: `surplus_row_${index}_${distribution.slug}`,
          sourceSlug: distribution.slug,
          destinationSlug: distribution.destinationBucketSlug ?? distribution.slug,
          destinationLabel: distribution.label,
          destinationType: distribution.destinationType ?? "bucket",
          destinationGoalId: distribution.destinationGoalId ?? null,
          destinationDebtId: distribution.destinationDebtId ?? null,
          amount: distribution.amount,
        })),
    );
    setSurplusMessage(null);
    setSurplusApplyError(null);
    setEditingSurplusRowId(null);
  }

  function openSurplusRowEditor(row: SurplusSuggestionDraftRow) {
    setEditingSurplusRowId(row.id);
    setSurplusRowDraft({
      destinationSlug: row.destinationSlug,
      amount: row.amount,
    });
    setSurplusMessage(null);
  }

  function handleApplySurplusRowEdit() {
    const nextDestination = activeDestinationOptions.find((option) => option.slug === surplusRowDraft.destinationSlug);
    if (!editingSurplusRow || !nextDestination) {
      return;
    }

    setSurplusDraftRows((current) => current.map((row) => (
      row.id === editingSurplusRow.id
        ? {
          ...row,
          destinationSlug: nextDestination.slug,
          destinationLabel: nextDestination.label,
          destinationType: "bucket",
          destinationGoalId: null,
          destinationDebtId: null,
          amount: normalizeMoneyInput(surplusRowDraft.amount) ?? surplusRowDraft.amount,
        }
        : row
    )));
    setEditingSurplusRowId(null);
    setSurplusApplyError(null);
    setSurplusMessage("Suggestion updated. Use Quick apply when you are ready to confirm it in Monthly Review.");
  }

  function handleCancelSurplusRowEdit() {
    setEditingSurplusRowId(null);
    setSurplusRowDraft({ destinationSlug: "", amount: "0.00" });
  }

  async function handleQuickApplySurplus() {
    if (!surplusExists || !draftMatchesSurplus || workflowData.closeSummary.canClose === false || workflowData.activeMonthStatus.status === "closed") {
      return;
    }

    setIsQuickApplyingSurplus(true);
    setSurplusMessage(null);
    setSurplusApplyError(null);

    try {
      const normalizedNetSurplus = Number(dashboardData.surplusRecommendations.netSurplus || "0");
      const splitOverride = suggestedRows.map((row, index) => {
        const normalizedAmount = Number(normalizeMoneyInput(row.amount) ?? row.amount ?? "0");
        const splitPercent = normalizedNetSurplus > 0 ? (normalizedAmount / normalizedNetSurplus).toFixed(4) : "0.0000";

        return {
          slug: row.sourceSlug,
          label: row.destinationLabel,
          splitPercent,
          sortOrder: index + 1,
          isActive: true,
          destinationType: row.destinationType,
          destinationBucketSlug: row.destinationType === "bucket" ? row.destinationSlug : null,
          destinationGoalId: row.destinationType === "goal" ? row.destinationGoalId : null,
          destinationDebtId: row.destinationType === "debt" ? row.destinationDebtId : null,
        };
      });

      await applyMonthlyReview({
        reviewMonth: from,
        splitOverride,
      });

      setSurplusMessage(`Surplus for ${activeMonthLabel} was applied. The month is now saved through Monthly Review.`);
      await Promise.all([reload(), monthWorkflow.reload()]);
    } catch (applyError) {
      setSurplusApplyError(applyError instanceof Error ? applyError.message : "Quick apply failed.");
    } finally {
      setIsQuickApplyingSurplus(false);
    }
  }

  return (
    <PageShell eyebrow="Overview" title="Dashboard" description="Your money, with a clear next move.">
      {nextStepState?.kind === "historical" ? (
        <div
          className="rounded-2xl border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--border-color)",
            background: "var(--surface-plain)",
            color: "var(--text-muted)",
          }}
        >
          Viewing {activeMonthLabel} - this is a historical snapshot.{" "}
          <button type="button" className="font-medium text-[var(--primary-color)]" onClick={jumpToCurrentMonth}>
            Back to current month
          </button>
        </div>
      ) : null}
      {nextStepState?.kind === "month-reminder" ? <MonthReminderBanner monthKey={nextStepState.monthKey} /> : null}
      {(nextStepState?.kind === "income-transactions-open" ||
        nextStepState?.kind === "income-no-transactions" ||
        nextStepState?.kind === "month-reminder") ? (
        <FinancialAttentionAggregator
          items={deriveAttentionItems({
            unreviewedImportsCount:
              nextStepState.kind === "month-reminder"
                ? (workflowData.reminderMonth?.unresolvedImports ?? 0)
                : workflowData.activeMonthStatus.unresolvedImports,
          })}
        />
      ) : null}
      {nextStepState?.kind === "setup-incomplete" ? (
        <Card
          title="Start Here"
          subtitle="A simple monthly setup path from RAF's allocation template."
          actions={(
            <Button type="button" variant="ghost" className="min-h-8 rounded-full px-3 py-1 text-xs" onClick={dismissStartHere}>
              Dismiss
            </Button>
          )}
        >
          <div className="grid gap-3 md:grid-cols-4">
            {[
              { step: "1", label: "Run the setup wizard", to: "/plan-wizard" },
              { step: "2", label: "Log income", to: "/income/new" },
              { step: "3", label: "Track spending", to: "/transactions" },
              { step: "4", label: "Review surplus", description: "Close the month and confirm where any remaining money goes", to: "/monthly-review" },
            ].map((item) => (
              <Link
                key={item.step}
                to={item.to}
                className="rounded-2xl border border-[var(--border-color)] px-4 py-3 transition hover:bg-[var(--surface-plain)]"
              >
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">Step {item.step}</span>
                <span className="mt-1 block text-sm font-semibold text-[var(--text-strong)]">{item.label}</span>
                {"description" in item ? <span className="mt-1 block text-[12px] leading-5 text-[var(--text-muted)]">{item.description}</span> : null}
              </Link>
            ))}
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--border-color)]" style={{ background: "var(--surface-plain)" }}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-[var(--text-strong)]"
              onClick={() => setHowRafWorksOpen((current) => !current)}
              aria-expanded={howRafWorksOpen}
            >
              <span>How RAF works</span>
              <span className="text-[var(--text-muted)]">{howRafWorksOpen ? "^" : "v"}</span>
            </button>
            {howRafWorksOpen ? (
              <ol className="space-y-3 border-t border-[var(--border-color)] px-4 py-4 text-sm text-[var(--text-muted)]">
                <li><span className="font-semibold text-[var(--text-strong)]">Log income</span> - record each paycheck or deposit. RAF splits it across your categories by the percentages you configured.</li>
                <li><span className="font-semibold text-[var(--text-strong)]">Track spending</span> - record transactions against your categories. RAF tracks how much of each category's allocation has been used.</li>
                <li><span className="font-semibold text-[var(--text-strong)]">Monthly Review</span> - at month end, close the month. RAF calculates any surplus (income exceeded spending) or deficit.</li>
                <li><span className="font-semibold text-[var(--text-strong)]">Distribute surplus</span> - tell RAF where surplus goes: debt paydown, savings goals, or other categories.</li>
                <li><span className="font-semibold text-[var(--text-strong)]">Repeat</span> - next month starts fresh with your same plan.</li>
              </ol>
            ) : null}
          </div>
        </Card>
      ) : null}
      {nextStepState?.kind === "setup-complete-no-income" ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>1</span>
            <span className="text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-strong)]">Setup complete.</span>{" "}
              Log this month's income to begin.
            </span>
          </div>
          <Link className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]" to="/income/new">
            Add income -&gt;
          </Link>
        </div>
      ) : null}
      {nextStepState?.kind === "closed-current-month" ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>âœ“</span>
            <span className="text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-strong)]">{activeMonthName} is closed. Your month is complete.</span>{" "}
              RAF will guide the next cycle when new activity begins.
            </span>
          </div>
        </div>
      ) : null}
      {nextStepState?.kind === "income-no-transactions" ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>â†’</span>
            <span className="text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-strong)]">Income logged.</span>{" "}
              Next: record transactions to track where it goes.
            </span>
          </div>
          <Link className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]" to="/transactions">
            Track spending â†’
          </Link>
        </div>
      ) : null}
      {nextStepState?.kind === "income-transactions-open" ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>âœ“</span>
            <span className="text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-strong)]">Looking good.</span>{" "}
              When you are done spending, close {activeMonthLabel} in Monthly Review.
            </span>
          </div>
          <Link className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]" to="/monthly-review">
            Monthly Review â†’
          </Link>
        </div>
      ) : null}
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        <SummaryMetricCard
          title="Income this month"
          value={format(latestPeriodIncome)}
          subtitle={data.incomeCount ? `${data.incomeCount} deposit${data.incomeCount === 1 ? "" : "s"}` : "Start here each month"}
          badge={data.latestPeriod?.alertStatus ?? "ok"}
          tone={alertTone(data.latestPeriod?.alertStatus)}
        />
        <SummaryMetricCard
          title="Net surplus"
          value={format(latestSurplus)}
          subtitle={`Remaining after this month's spending - ${monthStatusSubtitle(activeMonthStatus)}`}
          badge={activeMonthStatus}
          tone={activeMonthStatus === "closed" ? "success" : alertTone(data.latestPeriod?.alertStatus)}
          action={netSurplusExplanation ? (
            <button
              type="button"
              aria-expanded={netSurplusExplanationOpen}
              aria-haspopup="dialog"
              className="text-[11px] font-semibold text-[var(--primary-color)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-color)]"
              onClick={() => setNetSurplusExplanationOpen(true)}
            >
              How is this calculated?
            </button>
          ) : null}
        />
        <div className="col-span-2 xl:col-span-1">
          <SummaryMetricCard
            title="Active categories"
            value={String(activeCategoryCount)}
            subtitle={activeCategoryCount ? "Configuration ready" : "Awaiting setup"}
            badge={activeCategoryCount ? "configured" : "empty"}
            tone={activeCategoryCount ? "success" : "warning"}
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.6fr,1fr]">
        <div className="space-y-4">
          {allocationRows.length === 0 ? (
            <Card title="Categories">
              <EmptyState
                title="No categories configured"
                message="Run the setup wizard to define your spending categories."
              />
              <div className="mt-4 text-center">
                <Link className="text-sm font-semibold text-[var(--primary-color)]" to="/plan-wizard">
                  Open setup wizard -&gt;
                </Link>
              </div>
            </Card>
          ) : (
            <AllocationBarChart
              activeMonthLabel={activeMonthLabel}
              items={allocationRows.map((row) => ({
                bucketId: row.bucketId,
                slug: row.slug,
                label: row.label,
                allocationPercent: row.percent,
                thisMonth: {
                  allocated: row.monthlyProgress?.allocated_this_month ?? row.allocatedAmount ?? null,
                  added: row.monthlyProgress?.added_this_month ?? "0.00",
                  reservedForGoals: row.monthlyProgress?.reserved_for_goals_this_month ?? "0.00",
                  available: row.monthlyProgress?.available_this_month ?? null,
                  used: row.monthlyProgress?.used_this_month ?? null,
                  remaining: row.monthlyProgress?.remaining_this_month ?? null,
                },
              }))}
            />
          )}
        </div>

        <div className="space-y-4">
          {savingsFloorEnabled && isBelowSavingsFloor ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">Savings is below your floor.</div>
                  <div className="mt-1 text-[12px] leading-5">
                    Current savings is <Money value={data.financialHealth.savingsBalance} /> against a floor of <Money value={data.financialHealth.savingsFloor} />.
                  </div>
                </div>
                <Link className="text-[12px] font-semibold text-rose-700 underline-offset-2 hover:underline" to="/settings">
                  Adjust in Settings
                </Link>
              </div>
            </div>
          ) : null}

          {surplusExists ? (
            <Card
              title="Surplus Allocation"
              subtitle="Where surplus goes when you close the month."
              actions={(
                <div className="flex flex-wrap items-center gap-2">
                  <Link className="text-[11px] font-medium text-[var(--primary-color)]" to="/monthly-review">
                    Default split in Monthly Review
                  </Link>
                  <Badge tone={alertTone(data.surplusRecommendations.alertStatus)}>Surplus</Badge>
                </div>
              )}
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-[var(--border-color)] px-4 py-4" style={{ background: "var(--surface-plain)" }}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Surplus available</div>
                      <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]"><Money value={data.surplusRecommendations.netSurplus} /></div>
                      <div className="mt-2 text-[12px] text-[var(--text-muted)]">
                        These are editable suggestions only. Nothing moves until you confirm it in Monthly Review.
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex min-h-9 items-center rounded-full bg-[var(--primary-color)] px-3.5 py-1.5 text-xs font-semibold text-[var(--primary-contrast)] disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isQuickApplyingSurplus || !draftMatchesSurplus || monthWorkflow.data.closeSummary.canClose === false || monthWorkflow.data.activeMonthStatus.status === "closed"}
                        onClick={() => void handleQuickApplySurplus()}
                      >
                        {isQuickApplyingSurplus ? "Applying..." : "Quick apply all"}
                      </button>
                      <Link className="inline-flex min-h-9 items-center rounded-full border border-[var(--border-color)] px-3 py-1.5 text-xs font-medium text-[var(--text-strong)]" to="/monthly-review">
                        Review in Monthly Review
                      </Link>
                    </div>
                  </div>
                  <div className="mt-3 text-[12px] text-[var(--text-muted)]">
                    Adjust the saved default split in Monthly Review when this month's surplus needs a different plan.
                  </div>
                  <div className="mt-4 grid gap-3">
                    {suggestedRows.map((row) => (
                      <div
                        key={row.id}
                        className="rounded-2xl border border-[var(--border-color)] px-3 py-3"
                        style={{ background: "var(--surface-color)" }}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-base font-semibold text-[var(--text-strong)]"><Money value={row.amount} /></div>
                            <div className="mt-1 text-sm font-medium text-[var(--text-strong)]">To {row.destinationLabel}</div>
                            <div className="mt-1 text-[12px] text-[var(--text-muted)]">Included in the current quick-apply draft.</div>
                            {savingsFloorEnabled && isBelowSavingsFloor && row.destinationSlug === "savings" ? (
                              <span className="mt-2 inline-flex rounded-full bg-[var(--badge-warning-bg,var(--surface-elevated))] px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
                                Savings priority
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="secondary" className="min-h-8 rounded-full px-3 py-1 text-[11px]" onClick={() => openSurplusRowEditor(row)}>
                              Edit
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {editingSurplusRow ? (
                  <div className="rounded-[1.5rem] border border-[var(--border-color)] px-4 py-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--text-strong)]">Edit suggestion</div>
                        <div className="mt-1 text-[12px] text-[var(--text-muted)]">Adjust the amount and destination category, then save the draft before using Quick apply.</div>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <MoneyInput
                        label="Amount"
                        name={`surplus-amount-${editingSurplusRow.id}`}
                        value={surplusRowDraft.amount}
                        onChange={(value) => {
                          setSurplusRowDraft((current) => ({ ...current, amount: value }));
                          setSurplusMessage(null);
                        }}
                      />
                      <label className="block">
                        <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-strong)]">Destination category</span>
                        <select
                          className="ui-field"
                          value={surplusRowDraft.destinationSlug}
                          onChange={(event) => {
                            setSurplusRowDraft((current) => ({ ...current, destinationSlug: event.target.value }));
                            setSurplusMessage(null);
                          }}
                        >
                          {activeDestinationOptions.map((option) => (
                            <option key={option.slug} value={option.slug}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {movingSavingsPriorityAway ? (
                      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                        Warning: this choice conflicts with your savings floor. Savings is already below the floor, so RAF is prioritizing Savings in the recommendation.
                      </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-color)] px-3 py-3 text-sm" style={{ background: "var(--surface-color)" }}>
                      <div>
                        <div className="font-semibold text-[var(--text-strong)]">Draft total <Money value={draftTotal.toFixed(2)} /></div>
                        <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                          {draftMatchesSurplus
                            ? "The draft matches the current surplus."
                            : `Keep this aligned with ${format(data.surplusRecommendations.netSurplus)} before confirming.`}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="secondary" className="min-h-9 rounded-full px-3 py-1.5 text-xs" onClick={handleCancelSurplusRowEdit}>
                          Cancel
                        </Button>
                        <Button type="button" className="min-h-9 rounded-full px-3 py-1.5 text-xs" disabled={!draftMatchesSurplus} onClick={handleApplySurplusRowEdit}>
                          Save draft
                        </Button>
                      </div>
                    </div>
                    {surplusMessage ? <div className="mt-3"><SuccessNotice title="Surplus draft saved" message={surplusMessage} /></div> : null}
                    {surplusApplyError ? <p className="mt-3 text-[12px] italic text-rose-500">{surplusApplyError}</p> : null}
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button type="button" variant="secondary" className="min-h-9 rounded-full px-3 py-1.5 text-xs" onClick={handleResetSurplusDraftRows}>
                    Reset suggestions
                  </Button>
                </div>
                {!editingSurplusRow && surplusApplyError ? <p className="text-[12px] italic text-rose-500">{surplusApplyError}</p> : null}
                {!editingSurplusRow && surplusMessage ? <SuccessNotice title="Surplus updated" message={surplusMessage} /> : null}
              </div>
            </Card>
          ) : data.incomeCount > 0 ? (
            <Card
              title="Surplus Allocation"
              subtitle="Where surplus goes when you close the month."
            >
              <div className="rounded-2xl border border-[var(--border-color)] px-4 py-4 text-sm text-[var(--text-muted)]" style={{ background: "var(--surface-plain)" }}>
                No surplus to distribute yet. Close the month in Monthly Review to see whether there's a surplus.
              </div>
            </Card>
          ) : null}

          <Card
            title="Recent transactions"
            actions={(
              <Link className="text-[11px] font-medium text-[var(--primary-color)]" to="/transactions#transactions-table">
                See all -&gt;
              </Link>
            )}
          >
            {data.recentTransactions.length ? (
              <div style={{ borderColor: "var(--border-color)" }} className="divide-y">
                {data.recentTransactions.map((transaction) => {
                  const categoryLabel = transaction.categoryId
                    ? activeCategories.find((category) => category.id === transaction.categoryId)?.label ?? transaction.categoryId
                    : "Unassigned";

                  return (
                    <Link
                      key={transaction.id}
                      to="/transactions#transactions-table"
                      className="flex min-h-9 items-center gap-3 py-2.5 transition hover:opacity-90"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--text-strong)]">{transaction.description}</div>
                        <div className="mt-1 text-[10px] text-[var(--text-muted)]">{formatIsoDate(transaction.transactionDate)}</div>
                      </div>
                      <Badge tone={transactionTone(transaction)}>{categoryLabel}</Badge>
                      <div className={`w-20 text-right text-[13px] font-semibold ${transaction.direction === "credit" ? "text-emerald-700" : "text-rose-700"}`}>
                        <Money value={transaction.amount} signed={transaction.direction === "credit"} />
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                title="No activity yet"
                message="Recorded transactions will show up here."
              />
            )}
          </Card>
        </div>
      </section>

      {netSurplusExplanationOpen && netSurplusExplanation ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 px-3 py-4 sm:items-center"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setNetSurplusExplanationOpen(false);
            }
          }}
        >
          <div
            aria-labelledby="net-surplus-explanation-title"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-5 shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p id="net-surplus-explanation-title" className="text-base font-semibold text-[var(--text-strong)]">
                  {netSurplusExplanation.label}
                </p>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  Based on recorded {activeMonthLabel} activity.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close calculation explanation"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-color)] text-sm font-semibold text-[var(--text-muted)] hover:bg-[var(--surface-plain)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-color)]"
                onClick={() => setNetSurplusExplanationOpen(false)}
              >
                X
              </button>
            </div>

            <div className="mt-5 space-y-3 text-sm">
              {netSurplusExplanation.components.map((component) => (
                <div key={`${component.label}-${component.value}`} className="flex items-center justify-between gap-4">
                  <span className="text-[var(--text-muted)]">{component.label}</span>
                  <span className="font-semibold text-[var(--text-strong)]"><Money value={component.value} /></span>
                </div>
              ))}
              <div className="border-t border-[var(--border-color)] pt-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-semibold text-[var(--text-strong)]">Remaining</span>
                  <span className="font-bold text-[var(--text-strong)]"><Money value={netSurplusExplanation.value} /></span>
                </div>
              </div>
            </div>

            {netSurplusExplanation.assumptions?.length ? (
              <ul className="mt-5 space-y-2 text-[12px] leading-5 text-[var(--text-muted)]">
                {netSurplusExplanation.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

    </PageShell>
  );
}
