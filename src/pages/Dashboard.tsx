import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getFinancialAccounts } from "../api/accountsApi";
import { getAllocationCategoriesAsOf } from "../api/allocationCategoriesApi";
import { ApiError } from "../api/client";
import { getIncome, getIncomeAllocations } from "../api/incomeApi";
import { getDashboardAggregateReport } from "../api/reportsApi";
import { getTransactions, markTransactionReviewed, markTransactionUnreviewed, bulkReviewTransactions } from "../api/transactionsApi";
import { AllocationBarChart } from "../components/dashboard/AllocationBarChart";
import { FinancialAttentionAggregator } from "../components/dashboard/FinancialAttentionAggregator";
import { getFinancialAttention } from "../api/financialAttentionApi";
import { SummaryMetricCard } from "../components/dashboard/SummaryMetricCard";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { MonthReminderBanner } from "../components/feedback/MonthReminderBanner";
import { IncomeModal } from "../components/income/IncomeModal";
import { PageShell } from "../components/layout/PageShell";
import { usePeriod } from "../components/layout/PeriodProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { useAsyncData } from "../hooks/useAsyncData";
import { useMonthWorkflow } from "../hooks/useMonthWorkflow";
import { useAuth } from "../context/AuthContext";
import { formatIsoDate } from "../lib/format";
import { Money } from "../components/ui/Money";
import { useMoneyFormat } from "../hooks/useMoneyFormat";
import type {
  AllocationCategory,
  DashboardPeriod,
  FinancialAccount,
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
  accounts: FinancialAccount[];
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

function mostRecentTimestamp(values: Array<string | null | undefined>) {
  return values.filter((v): v is string => Boolean(v)).sort((l, r) => r.localeCompare(l))[0] ?? null;
}

function formatFreshnessTimestamp(value: string | null) {
  if (!value) return "Unknown / not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown / not recorded";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

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
  const [showIncomeModal, setShowIncomeModal] = useState(false);
  const [startHereDismissed, setStartHereDismissed] = useState(() => readOnboardingDismissed(activeWorkspaceId));
  const [setupDone, setSetupDone] = useState(readSetupDone);
  const [howRafWorksOpen, setHowRafWorksOpen] = useState(false);
  const [netSurplusExplanationOpen, setNetSurplusExplanationOpen] = useState(false);

  const [reviewUndoId, setReviewUndoId] = useState<string | null>(null);
  const [reviewUndoLabel, setReviewUndoLabel] = useState<string>("");
  const [isReviewingId, setIsReviewingId] = useState<string | null>(null);
  const [isBulkReviewing, setIsBulkReviewing] = useState(false);
  const [reviewedOutIds, setReviewedOutIds] = useState<Set<string>>(new Set());

  const {
    data: inboxData,
    reload: reloadInbox,
  } = useAsyncData<Transaction[]>(async () => {
    const result = await getTransactions({ from, to, reviewed: false, limit: 50 });
    return result.items;
  }, [from, to]);

  const { data: attentionData } = useAsyncData(
    () => getFinancialAttention(),
    [from],
  );

  const eligibleForReview = (inboxData ?? []).filter(
    (t) => !reviewedOutIds.has(t.id) && (t.direction === "credit" || t.linkedDebtId || t.linkedGoalId || t.categoryId),
  );

  async function handleMarkReviewed(txn: Transaction) {
    setIsReviewingId(txn.id);
    setReviewedOutIds((prev) => new Set([...prev, txn.id]));
    try {
      await markTransactionReviewed(txn.id);
      setReviewUndoId(txn.id);
      setReviewUndoLabel(txn.description);
    } catch {
      setReviewedOutIds((prev) => { const next = new Set(prev); next.delete(txn.id); return next; });
    } finally {
      setIsReviewingId(null);
    }
  }

  async function handleBulkReviewAll() {
    const ids = eligibleForReview.map((t) => t.id);
    if (ids.length === 0) return;
    setIsBulkReviewing(true);
    setReviewedOutIds((prev) => new Set([...prev, ...ids]));
    try {
      await bulkReviewTransactions({ transactionIds: ids });
      setReviewUndoId(null);
    } catch {
      setReviewedOutIds((prev) => { const next = new Set(prev); for (const id of ids) next.delete(id); return next; });
    } finally {
      setIsBulkReviewing(false);
    }
  }

  async function handleUndoReview() {
    if (!reviewUndoId) return;
    try {
      await markTransactionUnreviewed(reviewUndoId);
      setReviewedOutIds((prev) => { const next = new Set(prev); next.delete(reviewUndoId); return next; });
      setReviewUndoId(null);
    } catch {
      setReviewUndoId(null);
    }
  }

  const { data, error, isLoading, reload } = useAsyncData<DashboardViewModel>(async () => {
    const [aggregate, incomeResponse, transactionsResponse, accountsResponse] = await Promise.all([
      getDashboardAggregateReport({ from, to }),
      getIncome({ from, to }),
      getTransactions({ from, to, limit: 10 }),
      getFinancialAccounts().catch(() => ({ items: [] as FinancialAccount[] })),
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
      accounts: accountsResponse.items,
    };
  }, [from, to]);

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
      <PageShell eyebrow="Home" title="Your money, with a clear next move." description="RAF keeps the important decisions visible without turning your finances into a wall of charts.">
        <LoadingState label="Loading the current financial snapshot..." />
      </PageShell>
    );
  }

  if (error || !data || monthWorkflow.error || !monthWorkflow.data) {
    return (
      <PageShell eyebrow="Home" title="Your money, with a clear next move." description="RAF keeps the important decisions visible without turning your finances into a wall of charts.">
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
  const surplusExists = Number(dashboardData.surplusRecommendations.netSurplus) > 0;
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

  const latestSpending = dashboardData.latestPeriod?.spendingTotal ?? "0.00";

  return (
    <PageShell
      eyebrow="Home"
      title="Your money, with a clear next move."
      description="RAF keeps the important decisions visible without turning your finances into a wall of charts."
      actions={(
        <div className="flex items-center gap-2">
          <Link to="/monthly-review" className="inline-flex min-h-[40px] items-center rounded-[11px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-[13px] text-[11.5px] font-semibold text-[var(--text-primary)] shadow-[var(--shadow-sm)] transition hover:bg-[var(--surface-muted)]">Monthly review</Link>
          <button type="button" onClick={() => setShowIncomeModal(true)} className="inline-flex min-h-[40px] items-center rounded-[11px] bg-[var(--theme-primary)] px-[13px] text-[11.5px] font-semibold text-white transition hover:opacity-90">Add income</button>
        </div>
      )}
    >
      {/* Net surplus hero — closest truthful RAF equivalent to prototype "Available to allocate" */}
      <div className="raf-hero">
        <div className="raf-hero-top">
          <div>
            <div className="raf-hero-label">Available to allocate</div>
            <div className="raf-hero-value"><Money value={latestSurplus} /></div>
            <div className="raf-hero-note">Income remaining after this month's recorded spending. Applied to categories when you close the month in Monthly Review.</div>
          </div>
          <div className="raf-hero-actions hidden sm:flex">
            <Link to="/monthly-review" className="inline-flex min-h-[38px] items-center rounded-[11px] border border-[var(--border-subtle)] bg-white/70 px-[13px] text-[11.5px] font-semibold text-[var(--text-primary)] transition hover:bg-white/90">Monthly review</Link>
          </div>
        </div>
        <div className="raf-hero-meta">
          <div className="meta"><b><Money value={latestPeriodIncome} /></b>Income this month</div>
          <div className="meta"><b><Money value={latestSpending} /></b>Spent this month</div>
          <div className="meta"><b>{activeMonthLabel}</b>Active period</div>
        </div>
      </div>
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
      <FinancialAttentionAggregator items={attentionData?.items ?? []} />
      {eligibleForReview.length > 0 ? (
        <div id="transaction-review">
        <Card
          title="Mark Transactions Reviewed"
          subtitle={`${eligibleForReview.length} transaction${eligibleForReview.length === 1 ? "" : "s"} ready to confirm`}
        >
          {eligibleForReview.length >= 2 ? (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-[var(--border-color)] bg-[var(--surface-plain)] px-4 py-2">
              <p className="text-sm text-[var(--text-strong)]">
                {eligibleForReview.length} transaction{eligibleForReview.length !== 1 ? "s" : ""} ready
              </p>
              <button
                type="button"
                disabled={isBulkReviewing}
                onClick={() => void handleBulkReviewAll()}
                className="min-h-8 rounded-full bg-[var(--primary-color)] px-3 py-1 text-xs font-semibold text-[var(--primary-contrast)] disabled:opacity-50"
              >
                {isBulkReviewing ? "Marking…" : `Mark all ${eligibleForReview.length} reviewed`}
              </button>
            </div>
          ) : null}
          {reviewUndoId ? (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-[var(--border-color)] bg-[var(--surface-elevated)] px-4 py-2 text-sm">
              <span className="text-[var(--text-secondary)]">Marked reviewed: <span className="font-medium text-[var(--text-strong)]">{reviewUndoLabel}</span></span>
              <button
                type="button"
                className="ml-4 text-[var(--primary-color)] text-xs font-semibold"
                onClick={handleUndoReview}
              >
                Undo
              </button>
            </div>
          ) : null}
          <div className="space-y-2">
            {eligibleForReview.slice(0, 10).map((txn) => (
              <div
                key={txn.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-color)] px-4 py-2.5"
                style={{ background: "var(--surface-plain)" }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--text-strong)]">{txn.description}</p>
                  <p className="text-xs text-[var(--text-secondary)]">{txn.transactionDate} · {txn.direction === "debit" ? "-" : "+"}{txn.amount}</p>
                </div>
                <button
                  type="button"
                  disabled={isReviewingId === txn.id}
                  onClick={() => handleMarkReviewed(txn)}
                  className="min-h-8 shrink-0 rounded-full border border-[var(--border-color)] bg-[var(--surface-plain)] px-3 py-1 text-xs font-medium text-[var(--text-strong)] transition hover:bg-[var(--surface-elevated)] disabled:opacity-50"
                >
                  {isReviewingId === txn.id ? "Marking…" : "Mark reviewed"}
                </button>
              </div>
            ))}
            {eligibleForReview.length > 10 ? (
              <p className="text-xs text-[var(--text-secondary)]">... and {eligibleForReview.length - 10} more</p>
            ) : null}
          </div>
        </Card>
        </div>
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
          <button type="button" onClick={() => setShowIncomeModal(true)} className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]">
            Add income -&gt;
          </button>
        </div>
      ) : null}
      {nextStepState?.kind === "closed-current-month" ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>✓</span>
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
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>→</span>
            <span className="text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-strong)]">Income logged.</span>{" "}
              Next: record transactions to track where it goes.
            </span>
          </div>
          <Link className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]" to="/transactions">
            Track spending →
          </Link>
        </div>
      ) : null}
      {nextStepState?.kind === "income-transactions-open" ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>✓</span>
            <span className="text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-strong)]">Looking good.</span>{" "}
              When you are done spending, close {activeMonthLabel} in Monthly Review.
            </span>
          </div>
          <Link className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]" to="/monthly-review">
            Monthly Review →
          </Link>
        </div>
      ) : null}
      <section className="grid grid-cols-2 gap-4 xl:grid-cols-3">
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

          {surplusExists && activeMonthStatus !== "closed" ? (
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm" style={{ background: "var(--surface-plain)" }}>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base" style={{ background: "var(--theme-soft)" }}>$</span>
                <span className="text-[var(--text-muted)]">
                  <span className="font-semibold text-[var(--text-strong)]">Surplus available.</span>{" "}
                  <Money value={dashboardData.surplusRecommendations.netSurplus} /> ready to allocate.
                </span>
              </div>
              <Link className="shrink-0 text-[12px] font-semibold text-[var(--primary-color)]" to="/monthly-review">
                Review allocation →
              </Link>
            </div>
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

          {(() => {
            const activeAccounts = data.accounts.filter((a) => a.status === "active");
            const dashboardAsOf = data.latestPeriod?.month ?? null;
            const accountFreshness = mostRecentTimestamp(activeAccounts.map((a) => a.balance_as_of));
            const activityFreshness = mostRecentTimestamp(data.recentTransactions.map((t) => t.transactionDate));
            const freshnessRows: Array<{ label: string; value: string | null }> = [
              { label: "Dashboard totals", value: dashboardAsOf },
              { label: "Account balances", value: accountFreshness },
              { label: "Recorded activity", value: activityFreshness },
            ];
            return (
              <Card title="Data Freshness">
                <p className="mb-3 text-[11px] text-[var(--text-muted)]">
                  RAF does not treat age alone as proof that a balance is wrong.
                </p>
                <div className="divide-y" style={{ borderColor: "var(--border-color)" }}>
                  {freshnessRows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                      <span className="text-[var(--text-muted)]">{row.label}</span>
                      <span className="font-medium text-[var(--text-strong)]">{formatFreshnessTimestamp(row.value)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })()}
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

      <IncomeModal isOpen={showIncomeModal} onClose={() => setShowIncomeModal(false)} onSuccess={() => void reload()} />
    </PageShell>
  );
}
