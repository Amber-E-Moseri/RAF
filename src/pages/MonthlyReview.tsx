import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { getDebts } from "../api/debtsApi";
import { getGoals } from "../api/goalsApi";
import {
  closeMonth,
  getCloseReadiness,
  getMonthLifecycle,
  reopenMonth,
  startReview,
} from "../api/monthLifecycleApi";
import type { CloseMonthResponse, CloseReadinessResponse, MonthLifecycleResponse } from "../api/monthLifecycleApi";
import { applyMonthlyReview, applyMonthlyReviewsInRange, deleteMonthlyReview as removeMonthlyReview } from "../api/monthlyReviewApi";
import { getSurplusRecommendations } from "../api/reportsApi";
import { saveSurplusAllocationPreferences } from "../api/surplusAllocationApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingSpinner } from "../components/feedback/LoadingSpinner";
import { LoadingState } from "../components/feedback/LoadingState";
import { MonthReminderBanner } from "../components/feedback/MonthReminderBanner";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { usePeriod } from "../components/layout/PeriodProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Table } from "../components/ui/Table";
import { useAsyncData } from "../hooks/useAsyncData";
import { useMonthWorkflow } from "../hooks/useMonthWorkflow";
import { useRole } from "../hooks/usePermission";
import { Money } from "../components/ui/Money";
import { validateFirstDayOfMonth, validateIsoDate } from "../lib/validation";
import type { AllocationCategory, ApplyMonthlyReviewResponse, Debt, Goal, SurplusRecommendationsReport } from "../lib/types";

interface SurplusSplitDraftRow {
  id?: string | null;
  slug: string;
  label: string;
  splitPercent: string;
  destinationType: "bucket" | "goal" | "debt";
  destinationBucketSlug: string | null;
  destinationGoalId: string | null;
  destinationDebtId: string | null;
}

function defaultReviewMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function alertTone(status: "ok" | "elevated" | "risky") {
  if (status === "risky") {
    return "danger";
  }

  if (status === "elevated") {
    return "warning";
  }

  return "success";
}

function summaryStatusTone(status: "On Budget" | "Slight Overrun" | "Over Budget" | "Deficit Month") {
  if (status === "Deficit Month" || status === "Over Budget") {
    return "danger";
  }

  if (status === "Slight Overrun") {
    return "warning";
  }

  return "success";
}

function incrementMonth(reviewMonth: string) {
  const value = new Date(`${reviewMonth}T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 10);
}

function toMonthStart(value: string) {
  return `${value.slice(0, 7)}-01`;
}

function buildReviewMonthRange(startMonth: string, endMonth: string) {
  const normalizedStartMonth = toMonthStart(startMonth);
  const normalizedEndMonth = toMonthStart(endMonth);

  if (normalizedStartMonth > normalizedEndMonth) {
    return [];
  }

  const reviewMonths = [];
  let currentMonth = normalizedStartMonth;

  while (currentMonth <= normalizedEndMonth) {
    reviewMonths.push(currentMonth);
    currentMonth = incrementMonth(currentMonth);
  }

  return reviewMonths;
}

function fractionToPercentInput(value: string | undefined) {
  const numeric = Number(value ?? "0");
  return Number.isFinite(numeric) ? (numeric * 100).toFixed(2) : "0.00";
}

function percentInputToFraction(value: string) {
  const numeric = Number(value || "0");
  return Number.isFinite(numeric) ? (numeric / 100).toFixed(4) : "0.0000";
}

function parseMoneyToCents(value: string) {
  const numeric = Number(value ?? "0");
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}

function formatCents(cents: number) {
  return (cents / 100).toFixed(2);
}

function buildSurplusDistributionPreview(netSurplus: string, rows: SurplusSplitDraftRow[]) {
  const netSurplusCents = parseMoneyToCents(netSurplus);
  const distributions = Object.fromEntries(rows.map((row) => [row.slug, "0.00"])) as Record<string, string>;

  if (netSurplusCents <= 0 || !rows.length) {
    return distributions;
  }

  let assignedCents = 0;
  for (const row of rows) {
    const cents = Math.floor((netSurplusCents * Number(percentInputToFraction(row.splitPercent))) / 1);
    distributions[row.slug] = formatCents(cents);
    assignedCents += cents;
  }

  const remainder = netSurplusCents - assignedCents;
  if (remainder > 0 && distributions.emergency_fund) {
    distributions.emergency_fund = formatCents(parseMoneyToCents(distributions.emergency_fund) + remainder);
  }

  return distributions;
}

function nextMonthPeriod(period: string): string {
  const d = new Date(`${period}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}

function formatMonthLabel(period: string): string {
  try {
    return new Date(`${period}T12:00:00.000Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return period;
  }
}

export function MonthlyReview() {
  const { activeMonth, activeMonthLabel, isCurrentMonth, jumpToCurrentMonth, setActiveMonth } = usePeriod();
  const role = useRole();
  const canClose = role === "owner" || role === "admin" || role === "member";
  const canReopen = role === "owner" || role === "admin";
  const initialMonth = useMemo(() => activeMonth ? `${activeMonth}-01` : defaultReviewMonth(), [activeMonth]);
  const [reviewMonth, setReviewMonth] = useState(initialMonth);
  const [batchStartMonth, setBatchStartMonth] = useState(initialMonth);
  const [batchEndMonth, setBatchEndMonth] = useState(initialMonth);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [preview, setPreview] = useState<SurplusRecommendationsReport | null>(null);
  const [splitDraftRows, setSplitDraftRows] = useState<SurplusSplitDraftRow[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUnclosing, setIsUnclosing] = useState(false);
  const [isBatchSubmitting, setIsBatchSubmitting] = useState(false);
  const [isSavingSurplusPreferences, setIsSavingSurplusPreferences] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uncloseMessage, setUncloseMessage] = useState<string | null>(null);
  const [surplusPreferenceMessage, setSurplusPreferenceMessage] = useState<string | null>(null);
  const [surplusPreferenceError, setSurplusPreferenceError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyMonthlyReviewResponse | null>(null);
  const [showBatchTools, setShowBatchTools] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    reviewMonths: string[];
    appliedCount: number;
    totalTransactions: number;
  } | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const monthWorkflow = useMonthWorkflow(activeMonth);

  // ── Wave C lifecycle state ──────────────────────────────────────────────────
  const [lifecycle, setLifecycle] = useState<MonthLifecycleResponse | null>(null);
  const [closeReadiness, setCloseReadiness] = useState<CloseReadinessResponse | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showReopenConfirm, setShowReopenConfirm] = useState(false);
  const [showCloseSummary, setShowCloseSummary] = useState(false);
  const [isClosingMonth, setIsClosingMonth] = useState(false);
  const [isReopeningMonth, setIsReopeningMonth] = useState(false);
  const [isStartingReview, setIsStartingReview] = useState(false);
  const [closeResult, setCloseResult] = useState<CloseMonthResponse | null>(null);
  const [lifecycleActionError, setLifecycleActionError] = useState<string | null>(null);
  const lifecyclePeriodRef = useRef<string | null>(null);

  const lifecyclePeriod = useMemo(() => activeMonth ? `${activeMonth}-01` : null, [activeMonth]);

  const loadLifecycle = useCallback(async (period: string) => {
    setLifecycleLoading(true);
    setLifecycleError(null);
    try {
      const [lc, cr] = await Promise.all([
        getMonthLifecycle(period),
        getCloseReadiness(period),
      ]);
      setLifecycle(lc);
      setCloseReadiness(cr);
    } catch (e) {
      setLifecycleError(e instanceof Error ? e.message : "Could not load lifecycle state.");
    } finally {
      setLifecycleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!lifecyclePeriod) return;
    if (lifecyclePeriodRef.current === lifecyclePeriod) return;
    lifecyclePeriodRef.current = lifecyclePeriod;
    void loadLifecycle(lifecyclePeriod);
  }, [lifecyclePeriod, loadLifecycle]);

  async function handleStartReview() {
    if (!lifecyclePeriod) return;
    setIsStartingReview(true);
    setLifecycleActionError(null);
    try {
      await startReview({ period: lifecyclePeriod });
      await loadLifecycle(lifecyclePeriod);
    } catch (e) {
      setLifecycleActionError(e instanceof Error ? e.message : "Could not start review.");
    } finally {
      setIsStartingReview(false);
    }
  }

  async function handleCloseMonth() {
    if (!lifecyclePeriod) return;
    setIsClosingMonth(true);
    setLifecycleActionError(null);
    try {
      const result = await closeMonth({ period: lifecyclePeriod });
      setCloseResult(result);
      setShowCloseConfirm(false);
      setShowCloseSummary(true);
      await loadLifecycle(lifecyclePeriod);
      await monthWorkflow.reload();
    } catch (e) {
      setLifecycleActionError(e instanceof Error ? e.message : "Could not close month.");
      setShowCloseConfirm(false);
    } finally {
      setIsClosingMonth(false);
    }
  }

  async function handleReopenMonth() {
    if (!lifecyclePeriod) return;
    setIsReopeningMonth(true);
    setLifecycleActionError(null);
    try {
      await reopenMonth({ period: lifecyclePeriod });
      setShowReopenConfirm(false);
      setCloseResult(null);
      setShowCloseSummary(false);
      lifecyclePeriodRef.current = null;
      await loadLifecycle(lifecyclePeriod);
      await monthWorkflow.reload();
    } catch (e) {
      setLifecycleActionError(e instanceof Error ? e.message : "Could not reopen month.");
      setShowReopenConfirm(false);
    } finally {
      setIsReopeningMonth(false);
    }
  }
  const destinationData = useAsyncData<{ categories: AllocationCategory[]; goals: Goal[]; debts: Debt[] }>(async () => {
    const [categories, goalsResponse, debtsResponse] = await Promise.all([
      getAllocationCategories(),
      getGoals(),
      getDebts(),
    ]);

    return {
      categories: categories.filter((category) => category.isActive !== false),
      goals: goalsResponse.items.filter((goal) => goal.active !== false),
      debts: debtsResponse.items.filter((debt) => debt.isActive !== false),
    };
  }, []);

  useEffect(() => {
    const nextMonth = `${activeMonth}-01`;
    setReviewMonth(nextMonth);
    setBatchStartMonth(nextMonth);
    setBatchEndMonth(nextMonth);
    // Reset lifecycle so it reloads for the new period
    lifecyclePeriodRef.current = null;
    setLifecycle(null);
    setCloseReadiness(null);
    setCloseResult(null);
    setShowCloseSummary(false);
    setShowCloseConfirm(false);
    setShowReopenConfirm(false);
    setLifecycleActionError(null);
  }, [activeMonth]);

  useEffect(() => {
    let isCancelled = false;

    async function loadPreview() {
      setIsPreviewLoading(true);
      setPreviewError(null);

      try {
        const next = await getSurplusRecommendations(reviewMonth);
        if (!isCancelled) {
          setPreview(next);
        }
      } catch (error) {
        if (!isCancelled) {
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : "Preview could not be loaded.");
        }
      } finally {
        if (!isCancelled) {
          setIsPreviewLoading(false);
        }
      }
    }

    void loadPreview();

    return () => {
      isCancelled = true;
    };
  }, [reviewMonth, previewVersion]);

  useEffect(() => {
    if (!preview) {
      setSplitDraftRows([]);
      return;
    }

    setSplitDraftRows(
      preview.distributions.map((distribution) => ({
        id: null,
        slug: distribution.slug,
        label: distribution.label,
        splitPercent: fractionToPercentInput(distribution.splitPercent),
        destinationType: distribution.destinationType ?? "bucket",
        destinationBucketSlug: distribution.destinationBucketSlug ?? null,
        destinationGoalId: distribution.destinationGoalId ?? null,
        destinationDebtId: distribution.destinationDebtId ?? null,
      })),
    );
  }, [preview]);

  const splitDraftTotal = useMemo(
    () => splitDraftRows.reduce((sum, row) => sum + Number(row.splitPercent || "0"), 0),
    [splitDraftRows],
  );
  const hasEmergencyDraft = splitDraftRows.some((row) => row.slug === "emergency_fund");
  const splitDraftIsBalanced = Math.abs(splitDraftTotal - 100) < 0.01;
  const splitDraftError = !splitDraftRows.length
    ? null
    : !hasEmergencyDraft
      ? "Surplus allocation must include Emergency Fund for remainder handling."
      : !splitDraftIsBalanced
        ? `Allocation must total 100.00%. Current total is ${splitDraftTotal.toFixed(2)}%.`
        : null;
  const missingDestinationDraft = splitDraftRows.find((row) => {
    if (row.destinationType === "bucket") {
      return !row.destinationBucketSlug || !destinationData.data?.categories.some((category) => category.slug === row.destinationBucketSlug);
    }
    if (row.destinationType === "goal") {
      return !row.destinationGoalId || !destinationData.data?.goals.some((goal) => goal.id === row.destinationGoalId);
    }
    return !row.destinationDebtId || !destinationData.data?.debts.some((debt) => debt.id === row.destinationDebtId);
  }) ?? null;
  const previewDistributions = useMemo(
    () => buildSurplusDistributionPreview(preview?.netSurplus ?? "0.00", splitDraftRows),
    [preview?.netSurplus, splitDraftRows],
  );
  const splitOverride = useMemo(
    () => splitDraftRows.map((row, index) => ({
      id: row.id ?? null,
      slug: row.slug,
      label: row.label,
      splitPercent: percentInputToFraction(row.splitPercent),
      sortOrder: index + 1,
      isActive: true,
      destinationType: row.destinationType,
      destinationBucketSlug: row.destinationType === "bucket" ? row.destinationBucketSlug : null,
      destinationGoalId: row.destinationType === "goal" ? row.destinationGoalId : null,
      destinationDebtId: row.destinationType === "debt" ? row.destinationDebtId : null,
    })),
    [splitDraftRows],
  );

  async function handleSubmit() {
    const reviewMonthError = validateFirstDayOfMonth(reviewMonth, "Review month");
    const nextErrors = { reviewMonth: reviewMonthError };
    setFieldErrors(nextErrors);

    if (reviewMonthError || monthWorkflow.data?.closeSummary.canClose === false || Boolean(splitDraftError) || Boolean(missingDestinationDraft)) {
      setSubmitError(
        (missingDestinationDraft ? "One or more surplus destinations no longer exists. Update the draft before closing the month." : null)
          ?? splitDraftError
          ?? (reviewMonthError ? null : "Resolve imported rows before closing this month."),
      );
      setResult(null);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const response = await applyMonthlyReview({
        reviewMonth,
        splitOverride,
      });
      setResult(response);
      setUncloseMessage(null);
      setPreviewVersion((current) => current + 1);
      await monthWorkflow.reload();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Monthly review failed.");
      setResult(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUncloseMonth() {
    const reviewId = monthWorkflow.data?.activeMonthStatus.reviewId;
    if (!reviewId) {
      setSubmitError("This month does not have a saved review to unclose.");
      return;
    }

    setIsUnclosing(true);
    setSubmitError(null);
    setResult(null);
    setBatchResult(null);
    setUncloseMessage(null);

    try {
      const response = await removeMonthlyReview(reviewId);
      setUncloseMessage(
        response.revertedTransactions.length > 0
          ? `Removed ${response.revertedTransactions.length} monthly review allocation ${response.revertedTransactions.length === 1 ? "transaction" : "transactions"} and reopened ${activeMonthLabel}.`
          : `Reopened ${activeMonthLabel}.`,
      );
      setPreviewVersion((current) => current + 1);
      await monthWorkflow.reload();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Month could not be reopened.");
    } finally {
      setIsUnclosing(false);
    }
  }

  async function handleSaveSurplusPreferences() {
    if (Boolean(splitDraftError) || Boolean(missingDestinationDraft)) {
      setSurplusPreferenceError(
        (missingDestinationDraft ? "One or more surplus destinations no longer exists. Update the draft before saving defaults." : null)
          ?? splitDraftError
          ?? "Surplus allocation defaults could not be saved.",
      );
      setSurplusPreferenceMessage(null);
      return;
    }

    setIsSavingSurplusPreferences(true);
    setSurplusPreferenceError(null);
    setSurplusPreferenceMessage(null);

    try {
      await saveSurplusAllocationPreferences(splitOverride);
      setSurplusPreferenceMessage("Saved as the default surplus allocation for future months.");
    } catch (error) {
      setSurplusPreferenceError(error instanceof Error ? error.message : "Surplus allocation defaults could not be saved.");
    } finally {
      setIsSavingSurplusPreferences(false);
    }
  }

  async function handleBatchSubmit() {
    const startError = validateIsoDate(batchStartMonth, "Start date");
    const endError = validateIsoDate(batchEndMonth, "End date");
    const normalizedStartMonth = !startError ? toMonthStart(batchStartMonth) : null;
    const normalizedEndMonth = !endError ? toMonthStart(batchEndMonth) : null;
    const rangeError = normalizedStartMonth && normalizedEndMonth && normalizedStartMonth > normalizedEndMonth
      ? "End date must be in the same month as or after the start date."
      : null;
    const nextErrors = {
      ...fieldErrors,
      batchStartMonth: startError,
      batchEndMonth: endError ?? rangeError,
    };

    setFieldErrors(nextErrors);

    if (startError || endError || rangeError) {
      setSubmitError(null);
      setBatchResult(null);
      return;
    }

    const reviewMonths = buildReviewMonthRange(batchStartMonth, batchEndMonth);

    setIsBatchSubmitting(true);
    setSubmitError(null);

    try {
      const responses = await applyMonthlyReviewsInRange(
        reviewMonths,
        undefined,
      );
      setBatchResult({
        reviewMonths,
        appliedCount: responses.length,
        totalTransactions: responses.reduce(
          (sum, response) => sum + response.appliedTransactions.length,
          0,
        ),
      });
      setResult(responses[responses.length - 1] ?? null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Mass monthly review failed.");
      setBatchResult(null);
    } finally {
      setIsBatchSubmitting(false);
    }
  }

  return (
    <PageShell
      eyebrow="Reports"
      title="Understand what changed."
      description="Explore cash flow, spending and income without introducing a second source of truth."
    >
      {!isCurrentMonth ? (
        <div className="rounded-2xl border px-4 py-3 text-sm text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
          Viewing {activeMonthLabel} - this is a historical snapshot.{" "}
          <button type="button" className="font-medium text-[var(--primary-color)]" onClick={jumpToCurrentMonth}>
            Back to current month
          </button>
        </div>
      ) : null}
      {monthWorkflow.data?.reminderMonth ? <MonthReminderBanner monthKey={monthWorkflow.data.reminderMonth.monthKey} tone="danger" ctaLabel="Close month" /> : null}

      {/* ── Wave C Month Lifecycle ─────────────────────────────────────────── */}
      {lifecycleLoading ? (
        <LoadingState label="Loading month lifecycle…" />
      ) : lifecycleError ? (
        <ErrorState title="Lifecycle unavailable" message={lifecycleError} />
      ) : lifecycle ? (
        <section className="relative overflow-hidden rounded-[22px] border border-[var(--border-color)] bg-gradient-to-br from-[var(--surface-color)] via-[var(--surface-color)] to-[color-mix(in_srgb,var(--primary-color)_4%,var(--surface-color))] p-6 shadow-[0_14px_34px_rgba(17,24,39,.055)]">
          <div className="pointer-events-none absolute -top-[135px] -right-[90px] h-[280px] w-[280px] rounded-full bg-[radial-gradient(circle,rgba(14,159,115,.08),transparent_70%)]" />
          <div className="relative z-[1] flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[10.5px] font-black uppercase tracking-[0.08em] text-[var(--text-muted)]">{activeMonthLabel}</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-[var(--text-strong)]">
                {lifecycle.state === "CLOSED" ? "Month closed" : lifecycle.state === "REVIEWING" ? "Review in progress" : "Ready to review"}
              </h2>
              <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                {lifecycle.state === "CLOSED"
                  ? `Closed ${lifecycle.closedAt ? new Date(lifecycle.closedAt).toLocaleDateString() : ""} · version ${lifecycle.version ?? 1}`
                  : lifecycle.state === "REVIEWING"
                    ? "Close the month when you've reviewed activity, surplus and obligations."
                    : "Begin the review when you're ready to close this period."}
              </p>
            </div>
            <Badge tone={lifecycle.state === "CLOSED" ? "success" : lifecycle.state === "REVIEWING" ? "warning" : "neutral"}>
              {lifecycle.state.toLowerCase()}
            </Badge>
          </div>
          {lifecycleActionError ? <ErrorState title="Action failed" message={lifecycleActionError} /> : null}

          {/* OPEN state */}
          {lifecycle.state === "OPEN" && (
            <div className="space-y-4">
              {closeReadiness && closeReadiness.warnings.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-[var(--text-strong)]">Warnings</p>
                  {closeReadiness.warnings.map((w) => (
                    <div key={w.code} className="rounded-2xl border px-4 py-3 text-sm text-[var(--text-muted)]" style={{ borderColor: "rgba(245,158,11,0.4)", background: "color-mix(in srgb, var(--surface-plain) 90%, rgba(245,158,11,0.1))" }}>
                      {w.message}
                    </div>
                  ))}
                </div>
              )}
              {canClose && (
                <Button type="button" variant="secondary" disabled={isStartingReview} onClick={() => void handleStartReview()}>
                  {isStartingReview ? <LoadingSpinner inline size="sm" label="Starting review…" /> : "Start Review"}
                </Button>
              )}
            </div>
          )}

          {/* REVIEWING state */}
          {lifecycle.state === "REVIEWING" && (
            <div className="space-y-4">
              {closeReadiness && (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                      <p className="text-sm text-[var(--text-muted)]">Transactions</p>
                      <p className="mt-1 text-xl font-semibold text-[var(--text-strong)]">{closeReadiness.summary.totalTransactions}</p>
                      {closeReadiness.summary.unreviewedTransactions > 0 && (
                        <p className="mt-1 text-xs text-amber-600">{closeReadiness.summary.unreviewedTransactions} unreviewed</p>
                      )}
                    </div>
                    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                      <p className="text-sm text-[var(--text-muted)]">Goal contributions</p>
                      <p className="mt-1 text-xl font-semibold text-[var(--text-strong)]"><Money value={closeReadiness.summary.goalContributionsTotal} /></p>
                    </div>
                    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                      <p className="text-sm text-[var(--text-muted)]">Debt payments</p>
                      <p className="mt-1 text-xl font-semibold text-[var(--text-strong)]"><Money value={closeReadiness.summary.debtPaymentsTotal} /></p>
                    </div>
                  </div>
                  {closeReadiness.warnings.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-amber-700">Warnings (not blockers)</p>
                      {closeReadiness.warnings.map((w) => (
                        <div key={w.code} className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(245,158,11,0.4)", background: "color-mix(in srgb, var(--surface-plain) 90%, rgba(245,158,11,0.1))" }}>
                          {w.message}
                        </div>
                      ))}
                    </div>
                  )}
                  {closeReadiness.blockers.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-red-600">Blockers</p>
                      {closeReadiness.blockers.map((b) => (
                        <div key={b.code} className="rounded-2xl border px-4 py-3 text-sm text-red-700" style={{ borderColor: "rgba(239,68,68,0.4)", background: "color-mix(in srgb, var(--surface-plain) 90%, rgba(239,68,68,0.07))" }}>
                          {b.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {canClose && closeReadiness?.canClose !== false && (
                <Button type="button" onClick={() => { setShowCloseConfirm(true); setLifecycleActionError(null); }}>
                  Close {activeMonthLabel}
                </Button>
              )}
            </div>
          )}

          {/* CLOSED state */}
          {lifecycle.state === "CLOSED" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="success">Closed</Badge>
                <span className="text-sm text-[var(--text-muted)]">
                  Closed {lifecycle.closedAt ? new Date(lifecycle.closedAt).toLocaleDateString() : ""} · version {lifecycle.version ?? 1}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-8 rounded-full px-3 py-1 text-xs"
                  onClick={() => setShowCloseSummary((v) => !v)}
                >
                  {showCloseSummary ? "Hide close summary" : "View close summary"}
                </Button>
              </div>

              {/* Close summary from snapshot */}
              {showCloseSummary && lifecycle.snapshot && (
                <div className="space-y-3 rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                  <p className="text-sm font-semibold text-[var(--text-strong)]">Close snapshot · {lifecycle.snapshot.period}</p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <p className="text-xs text-[var(--text-muted)]">Income received</p>
                      <p className="text-base font-semibold text-[var(--text-strong)]"><Money value={lifecycle.snapshot.income.totalReceived} /></p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)]">Total spent</p>
                      <p className="text-base font-semibold text-[var(--text-strong)]"><Money value={lifecycle.snapshot.spending.totalSpent} /></p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)]">Net surplus</p>
                      <p className="text-base font-semibold text-[var(--text-strong)]"><Money value={lifecycle.snapshot.spending.netSurplus} /></p>
                    </div>
                  </div>
                  {lifecycle.snapshot.buffer && (
                    <div className="rounded-[1.25rem] border p-3" style={{ borderColor: "var(--border-color)", background: "var(--surface-color)" }}>
                      <p className="text-xs font-semibold text-[var(--text-strong)]">Buffer at close — {lifecycle.snapshot.buffer.label}</p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3 text-xs text-[var(--text-muted)]">
                        <span>Starting <span className="font-medium text-[var(--text-strong)]"><Money value={lifecycle.snapshot.buffer.allocated} /></span></span>
                        <span>Used <span className="font-medium text-[var(--text-strong)]"><Money value={lifecycle.snapshot.buffer.spent} /></span></span>
                        <span>Remaining <span className="font-medium text-[var(--text-strong)]"><Money value={lifecycle.snapshot.buffer.remaining} /></span></span>
                      </div>
                    </div>
                  )}
                  {lifecycle.snapshot.goals.contributions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-[var(--text-strong)]">Goal contributions · <Money value={lifecycle.snapshot.goals.totalContributions} /></p>
                      <ul className="mt-1 space-y-1">
                        {lifecycle.snapshot.goals.contributions.map((c) => (
                          <li key={c.goalId} className="text-xs text-[var(--text-muted)]">{c.goalName ?? c.goalId} — <Money value={c.amount} /></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {lifecycle.snapshot.debts.payments.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-[var(--text-strong)]">Debt payments · <Money value={lifecycle.snapshot.debts.totalPayments} /></p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">Balance at close: not captured. Historical debt balance semantics apply.</p>
                      <ul className="mt-1 space-y-1">
                        {lifecycle.snapshot.debts.payments.map((p) => (
                          <li key={p.debtId} className="text-xs text-[var(--text-muted)]">{p.debtName ?? p.debtId} — <Money value={p.amount} /></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="text-xs text-[var(--text-muted)]">
                    Transactions: {lifecycle.snapshot.transactions.reviewed} reviewed, {lifecycle.snapshot.transactions.unreviewed} unreviewed of {lifecycle.snapshot.transactions.total} total
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">Captured {new Date(lifecycle.snapshot.capturedAt).toLocaleString()} — immutable.</div>
                </div>
              )}

              {/* Continue to next month */}
              <div className="flex flex-wrap gap-3">
                {(() => {
                  const nextMonth = nextMonthPeriod(activeMonth ?? "");
                  const nextMonthLabel = formatMonthLabel(nextMonth);
                  // Check if next month is in the future by comparing YYYY-MM strings
                  const now = new Date();
                  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
                  const nextMonthIsFuture = nextMonth > currentMonthKey;

                  if (nextMonthIsFuture) {
                    const nextMonthDate = new Date(`${nextMonth}-01T00:00:00.000Z`);
                    const nextMonthDateFormatted = nextMonthDate.toLocaleString("en-US", {
                      month: "long",
                      day: "numeric",
                      timeZone: "UTC"
                    });
                    return (
                      <div className="text-sm text-[var(--text-muted)]">
                        {nextMonthLabel}
                        <br />
                        Available {nextMonthDateFormatted}
                      </div>
                    );
                  }

                  return (
                    <Button
                      type="button"
                      onClick={() => setActiveMonth(nextMonth)}
                    >
                      Continue to {nextMonthLabel}
                    </Button>
                  );
                })()}
                {canReopen && (
                  <Button type="button" variant="secondary" onClick={() => { setShowReopenConfirm(true); setLifecycleActionError(null); }}>
                    Reopen {activeMonthLabel}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Close confirmation dialog */}
          {showCloseConfirm && (
            <div className="mt-4 rounded-2xl border p-4 space-y-3" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
              <p className="text-sm font-semibold text-[var(--text-strong)]">Close {activeMonthLabel}?</p>
              <p className="text-sm text-[var(--text-muted)]">
                RAF will preserve an immutable historical snapshot of this period — income, spending, allocations, buffer, goal contributions, and debt payments captured at this exact moment. The snapshot cannot be modified after closing.
              </p>
              <div className="flex gap-3">
                <Button type="button" disabled={isClosingMonth} onClick={() => void handleCloseMonth()}>
                  {isClosingMonth ? <LoadingSpinner inline size="sm" label="Closing…" /> : `Confirm — close ${activeMonthLabel}`}
                </Button>
                <Button type="button" variant="secondary" disabled={isClosingMonth} onClick={() => setShowCloseConfirm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Reopen confirmation dialog */}
          {showReopenConfirm && (
            <div className="mt-4 rounded-2xl border p-4 space-y-3" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
              <p className="text-sm font-semibold text-[var(--text-strong)]">Reopen {activeMonthLabel}?</p>
              <p className="text-sm text-[var(--text-muted)]">
                The previous close snapshot will be preserved in history. Normal financial operations will become available again. A new close will create a new snapshot version.
              </p>
              <div className="flex gap-3">
                <Button type="button" variant="secondary" disabled={isReopeningMonth} onClick={() => void handleReopenMonth()}>
                  {isReopeningMonth ? <LoadingSpinner inline size="sm" label="Reopening…" /> : `Confirm — reopen ${activeMonthLabel}`}
                </Button>
                <Button type="button" variant="secondary" disabled={isReopeningMonth} onClick={() => setShowReopenConfirm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>
      ) : null}
      {/* ── End Wave C lifecycle ─────────────────────────────────────────────── */}

      {monthWorkflow.data ? (
        <Card title="Month snapshot" subtitle={`${monthWorkflow.data.activeMonthStatus.label} · ${monthWorkflow.data.activeMonthStatus.status.replaceAll("_", " ")}`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: "Income total", value: <Money value={monthWorkflow.data.closeSummary.incomeTotal} /> },
              { label: "Expense total", value: <Money value={monthWorkflow.data.closeSummary.expenseTotal} /> },
              { label: "Debt payments", value: <Money value={monthWorkflow.data.closeSummary.debtPaymentsTotal} /> },
              { label: "Protected & goals", value: <Money value={monthWorkflow.data.closeSummary.protectedContributionsTotal} /> },
              { label: "Surplus / deficit", value: <Money value={monthWorkflow.data.closeSummary.remainingSurplusOrDeficit} /> },
              { label: "Unresolved imports", value: String(monthWorkflow.data.closeSummary.unresolvedImportedTransactions) },
            ].map((kpi) => (
              <div key={kpi.label} className="rounded-xl border border-[var(--border-color)] bg-[var(--surface-elevated)] p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">{kpi.label}</p>
                <p className="mt-2 text-[20px] font-black tracking-tight text-[var(--text-strong)]">{kpi.value}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-[var(--text-muted)]">
            Closing a month uses the current surplus suggestion and keeps carry-forward visible through the next month's reserved balances.
          </p>
        </Card>
      ) : null}
      {!isPreviewLoading && !previewError && preview?.monthlySummary ? (
        <Card title="Month Summary" subtitle="Financial results before and after surplus allocation.">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-[var(--text-muted)]">
                {activeMonthLabel} summary
              </div>
              <Badge tone={summaryStatusTone(preview.monthlySummary.statusLabel)}>
                {preview.monthlySummary.statusLabel}
              </Badge>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                <div className="text-sm font-semibold text-[var(--text-strong)]">Before Surplus Allocation</div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Total Income</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.totalIncome} /></div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Total Allocated</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.totalAllocated} /></div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Total Spent</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.totalSpent} /></div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Month Result</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.monthResult} /></div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                <div className="text-sm font-semibold text-[var(--text-strong)]">After Surplus Allocation</div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Surplus Allocated to Goals</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.surplusAllocatedToGoals} /></div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Surplus Allocated to Debt</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.surplusAllocatedToDebt} /></div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Remaining Surplus</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.remainingSurplus} /></div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Final Month Result</div>
                    <div className="mt-1 text-lg font-semibold text-[var(--text-strong)]"><Money value={preview.monthlySummary.finalMonthResult} /></div>
                  </div>
                </div>
              </div>
            </div>

            {preview.overspendingImpact?.categories?.length ? (
              <div className="rounded-2xl border p-4" style={{ borderColor: "rgba(245, 158, 11, 0.35)", background: "color-mix(in srgb, var(--surface-plain) 88%, rgba(245, 158, 11, 0.12))" }}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-strong)]">Overspending Impact</div>
                    <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                      Overused categories reduce available month surplus. RAF does not silently correct them.
                    </div>
                  </div>
                  <Badge tone="warning">
                    <Money value={preview.overspendingImpact.totalImpact} /> impact
                  </Badge>
                </div>
                <div className="mt-4 space-y-3">
                  {preview.categorySummaries?.map((category) => (
                    <div
                      key={category.bucketId}
                      className="rounded-[1.25rem] border px-4 py-3"
                      style={{
                        borderColor: category.overused ? "rgba(245, 158, 11, 0.35)" : "var(--border-color)",
                        background: category.overused ? "color-mix(in srgb, var(--surface-color) 88%, rgba(245, 158, 11, 0.1))" : "var(--surface-color)",
                      }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold text-[var(--text-strong)]">{category.bucketName}</div>
                            {category.overused ? <Badge tone="warning">Overused</Badge> : null}
                          </div>
                          <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                            Allocated <Money value={category.allocated} />
                            {parseMoneyToCents(category.added) > 0 ? <>{" + Added "}<Money value={category.added} /></> : null}
                            {" · "}
                            Spent <Money value={category.spent} />
                            {" · "}
                            Goals <Money value={category.goalContributions} />
                            {" · "}
                            Available <Money value={category.available} />
                          </div>
                        </div>
                        {category.overused ? (
                          <div className="text-right">
                            <div className="text-[11px] uppercase tracking-[0.14em] text-amber-600">Overage</div>
                            <div className="mt-1 text-base font-semibold text-amber-700"><Money value={category.overageAmount} /></div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border px-4 py-3 text-sm text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                No categories exceeded their monthly allocation this month.
              </div>
            )}
          </div>
        </Card>
      ) : null}
      <section className="grid gap-4">
        <Card title="Close Month" subtitle="Finalize this month when you are ready." className="hidden">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,240px),auto] md:items-end">
              <Input
                label="Review month"
                name="reviewMonth"
                type="date"
                value={reviewMonth}
                error={fieldErrors.reviewMonth}
                onBlur={() => setFieldErrors((current) => ({ ...current, reviewMonth: validateFirstDayOfMonth(reviewMonth, "Review month") }))}
                onChange={(event) => {
                  const nextMonth = event.target.value;
                  setReviewMonth(nextMonth);
                  if (/^\d{4}-\d{2}-\d{2}$/.test(nextMonth)) {
                    setActiveMonth(nextMonth.slice(0, 7));
                  }
                  setFieldErrors((current) => ({ ...current, reviewMonth: null }));
                }}
              />
              {monthWorkflow.data?.activeMonthStatus.status === "closed" ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isUnclosing}
                  onClick={() => void handleUncloseMonth()}
                >
                  {isUnclosing ? <LoadingSpinner inline size="sm" label="Reversing closeout..." /> : "Reverse Closeout"}
                </Button>
              ) : (
                <Button
                  disabled={
                    isSubmitting
                    || isPreviewLoading
                    || monthWorkflow.data?.closeSummary.canClose === false
                    || Boolean(splitDraftError)
                    || Boolean(missingDestinationDraft)
                  }
                  onClick={() => void handleSubmit()}
                  type="button"
                >
                  {isSubmitting ? <LoadingSpinner inline size="sm" label="Closing month..." /> : "Close Month"}
                </Button>
              )}
            </div>
            <div className="rounded-2xl border px-4 py-3 text-sm text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
              {monthWorkflow.data?.activeMonthStatus.status === "closed"
                ? "Month closed."
                : "Uses the current surplus plan."}
            </div>
            {uncloseMessage ? <SuccessNotice title="Month reopened" message={uncloseMessage} /> : null}
          </div>
        </Card>

        <Card title="Surplus Plan" subtitle="Adjust this month’s split, then close the month when it looks right.">
          {isPreviewLoading ? <LoadingState label="Loading surplus recommendation..." /> : null}
          {!isPreviewLoading && previewError ? <ErrorState title="Failed to load monthly review preview" message={previewError} /> : null}
          {surplusPreferenceError ? <ErrorState title="Failed to save surplus defaults" message={surplusPreferenceError} /> : null}
          {surplusPreferenceMessage ? <SuccessNotice title="Surplus defaults updated" message={surplusPreferenceMessage} /> : null}
          {!isPreviewLoading && !previewError && preview ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-2xl p-4" style={{ background: "var(--surface-plain)" }}>
                <div>
                  <p className="text-sm text-[var(--text-muted)]">Surplus available</p>
                  <p className="mt-1 text-2xl font-semibold text-[var(--text-strong)]"><Money value={preview.netSurplus} /></p>
                  <p className="mt-1 text-[12px] text-[var(--text-muted)]">Edit the split if needed. Nothing applies until you close the month.</p>
                </div>
                <Badge tone={alertTone(preview.alertStatus)}>{preview.alertStatus}</Badge>
              </div>
              <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--text-strong)]">Current split</div>
                      <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                        Keep the percentages balanced at 100%. Save as default only if you want to reuse this split next month.
                      </div>
                    </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-8 rounded-full px-3 py-1 text-xs"
                      onClick={() => {
                        setSplitDraftRows(
                          preview.distributions.map((distribution) => ({
                            id: null,
                            slug: distribution.slug,
                            label: distribution.label,
                            splitPercent: fractionToPercentInput(distribution.splitPercent),
                            destinationType: distribution.destinationType ?? "bucket",
                            destinationBucketSlug: distribution.destinationBucketSlug ?? null,
                            destinationGoalId: distribution.destinationGoalId ?? null,
                            destinationDebtId: distribution.destinationDebtId ?? null,
                          })),
                        );
                      }}
                    >
                      Reset
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-8 rounded-full px-3 py-1 text-xs"
                      disabled={isSavingSurplusPreferences || Boolean(splitDraftError) || Boolean(missingDestinationDraft)}
                      onClick={() => void handleSaveSurplusPreferences()}
                    >
                      {isSavingSurplusPreferences ? "Saving default..." : "Save as default"}
                    </Button>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {splitDraftRows.map((distribution) => (
                    <div
                      key={distribution.slug}
                      className="rounded-[1.35rem] border p-4"
                      style={{ borderColor: "var(--border-color)", background: "var(--surface-color)" }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[15px] font-semibold text-[var(--text-strong)]">{distribution.label}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-muted)]">
                            <Badge tone="neutral">{distribution.destinationType === "bucket" ? "Category" : distribution.destinationType === "goal" ? "Goal" : "Debt"}</Badge>
                            <span>
                              {distribution.destinationType === "bucket"
                                   ? "Category destination from your saved default"
                                : distribution.destinationType === "goal"
                                  ? "Goal destination from your saved default"
                                  : "Debt destination from your saved default"}
                            </span>
                          </div>
                        </div>
                        <div className="rounded-full border border-[var(--border-color)] px-3 py-1 text-[12px] font-medium text-[var(--text-muted)]">
                          <Money value={previewDistributions[distribution.slug] ?? "0.00"} />
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 border-t border-[var(--border-color)] pt-4 sm:grid-cols-[190px,1fr] sm:items-end">
                        <label className="block">
                          <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Allocation</span>
                          <div className="flex items-center gap-2">
                            <input
                              className="ui-field h-10"
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              value={distribution.splitPercent}
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setSplitDraftRows((current) => current.map((row) => (
                                  row.slug === distribution.slug
                                    ? { ...row, splitPercent: nextValue }
                                    : row
                                )));
                              }}
                            />
                            <span className="text-sm text-[var(--text-muted)]">%</span>
                          </div>
                        </label>

                        <label className="block">
                          <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Amount</span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-[var(--text-muted)]">$</span>
                            <input
                              className="ui-field h-10"
                              inputMode="decimal"
                              value={previewDistributions[distribution.slug] ?? "0.00"}
                              onChange={(event) => {
                                const value = event.target.value;
                                if (value !== "" && !/^(?:0|[1-9]\d*)(?:\.\d{0,2})?$/.test(value)) {
                                  return;
                                }

                                const numeric = Number(value || "0");
                                const netSurplus = Number(preview.netSurplus || "0");
                                const nextPercent = netSurplus > 0 ? ((numeric / netSurplus) * 100).toFixed(2) : "0.00";
                                setSplitDraftRows((current) => current.map((row) => (
                                  row.slug === distribution.slug
                                    ? { ...row, splitPercent: nextPercent }
                                    : row
                                )));
                              }}
                            />
                          </div>
                          <div className="mt-2 text-[12px] text-[var(--text-muted)]">
                            Type the dollar distribution you want, or adjust the percentage.
                          </div>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-3 py-3 text-sm" style={{ borderColor: "var(--border-color)", background: "var(--surface-color)" }}>
                  <div>
                    <div className="font-semibold text-[var(--text-strong)]">Total allocation {splitDraftTotal.toFixed(2)}%</div>
                    <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                      {missingDestinationDraft
                        ? `Update ${missingDestinationDraft.label} because its saved destination is no longer available.`
                        : splitDraftError ?? "The current split is valid and ready to apply."}
                    </div>
                  </div>
                  <Badge tone={splitDraftError || missingDestinationDraft ? "warning" : "success"}>
                    {splitDraftError || missingDestinationDraft ? "Needs attention" : "Balanced"}
                  </Badge>
                </div>
              </div>
              {preview.targetDebtName ? (
                <p className="text-sm text-[var(--text-muted)]">
                  Debt target: <span className="font-medium text-[var(--text-strong)]">{preview.targetDebtName}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          {!isPreviewLoading && !previewError && !preview ? (
            <EmptyState
              title="No preview available"
              message="The monthly review preview endpoint returned no usable recommendation for this month."
            />
          ) : null}
        </Card>
      </section>

      <Card title="More Tools" subtitle="Batch actions stay available, but out of the main month-close flow.">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
            <div>
              <div title="Mass Apply Review" className="text-sm font-semibold text-[var(--text-strong)]">Mass Apply Review</div>
              <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                Apply the same closeout flow across a date range when you need to catch up several months.
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="min-h-9 rounded-full px-3 py-1.5 text-xs"
              onClick={() => setShowBatchTools((current) => !current)}
            >
              {showBatchTools ? "Hide batch tools" : "Show batch tools"}
            </Button>
          </div>

          {showBatchTools ? (
            <div className="space-y-4 rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
              <div className="grid gap-4 lg:grid-cols-[1fr,1fr,auto]">
                <Input
                  label="Start month"
                  name="batchStartMonth"
                  type="date"
                  value={batchStartMonth}
                  error={fieldErrors.batchStartMonth}
                  onBlur={() => setFieldErrors((current) => ({ ...current, batchStartMonth: validateIsoDate(batchStartMonth, "Start month") }))}
                  onChange={(event) => {
                    setBatchStartMonth(event.target.value);
                    setFieldErrors((current) => ({ ...current, batchStartMonth: null, batchEndMonth: null }));
                  }}
                />
                <Input
                  label="End month"
                  name="batchEndMonth"
                  type="date"
                  value={batchEndMonth}
                  error={fieldErrors.batchEndMonth}
                  onBlur={() => setFieldErrors((current) => ({ ...current, batchEndMonth: validateIsoDate(batchEndMonth, "End month") }))}
                  onChange={(event) => {
                    setBatchEndMonth(event.target.value);
                    setFieldErrors((current) => ({ ...current, batchStartMonth: null, batchEndMonth: null }));
                  }}
                />
                <div className="flex items-end">
                  <Button
                    disabled={isBatchSubmitting || isSubmitting}
                    onClick={() => void handleBatchSubmit()}
                    type="button"
                  >
                    {isBatchSubmitting ? <LoadingSpinner inline size="sm" label="Applying reviews..." /> : "Apply batch review"}
                  </Button>
                </div>
              </div>
              <div className="rounded-2xl border p-4 text-sm text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-color)" }}>
                This applies each month sequentially. If a month already has a saved review, the batch stops there for you to review it.
              </div>
              {batchResult ? (
                <div>
                  <SuccessNotice
                    title="Mass review applied"
                    message={`Applied ${batchResult.appliedCount} month${batchResult.appliedCount === 1 ? "" : "s"} and created ${batchResult.totalTransactions} allocation transaction${batchResult.totalTransactions === 1 ? "" : "s"}.`}
                  />
                  <p className="mt-3 text-sm text-[var(--text-muted)]">
                    Months applied: {batchResult.reviewMonths.join(", ")}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Close Month" subtitle="Finalize this month when you are ready.">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,240px),auto] md:items-end">
            <Input
              label="Review month"
              name="reviewMonth"
              type="date"
              value={reviewMonth}
              error={fieldErrors.reviewMonth}
              onBlur={() => setFieldErrors((current) => ({ ...current, reviewMonth: validateFirstDayOfMonth(reviewMonth, "Review month") }))}
              onChange={(event) => {
                const nextMonth = event.target.value;
                setReviewMonth(nextMonth);
                if (/^\d{4}-\d{2}-\d{2}$/.test(nextMonth)) {
                  setActiveMonth(nextMonth.slice(0, 7));
                }
                setFieldErrors((current) => ({ ...current, reviewMonth: null }));
              }}
            />
            {monthWorkflow.data?.activeMonthStatus.status === "closed" ? (
              <Button
                type="button"
                variant="secondary"
                disabled={isUnclosing}
                onClick={() => void handleUncloseMonth()}
              >
                {isUnclosing ? <LoadingSpinner inline size="sm" label="Reversing closeout..." /> : "Reverse Closeout"}
              </Button>
            ) : (
              <Button
                disabled={
                  isSubmitting
                  || isPreviewLoading
                  || monthWorkflow.data?.closeSummary.canClose === false
                  || Boolean(splitDraftError)
                  || Boolean(missingDestinationDraft)
                }
                onClick={() => void handleSubmit()}
                type="button"
              >
                {isSubmitting ? <LoadingSpinner inline size="sm" label="Closing month..." /> : "Close Month"}
              </Button>
            )}
          </div>
          <div className="rounded-2xl border px-4 py-3 text-sm text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
            {monthWorkflow.data?.activeMonthStatus.status === "closed"
              ? "Month closed."
              : "Uses the current surplus plan."}
          </div>
          {uncloseMessage ? <SuccessNotice title="Month reopened" message={uncloseMessage} /> : null}
        </div>
      </Card>

      {submitError ? <ErrorState title="Failed to apply monthly review" message={submitError} /> : null}
      {result ? (
        <Card title="Review Applied" subtitle={`Review month ${result.review.reviewMonth}`}>
          <SuccessNotice
            title="Monthly review applied"
            message={`RAF saved the review and created ${result.appliedTransactions.length} allocation transaction${result.appliedTransactions.length === 1 ? "" : "s"}.`}
          />
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.7fr,1fr]">
            <div className="rounded-2xl p-4" style={{ background: "var(--surface-plain)" }}>
              <p className="text-sm text-[var(--text-muted)]">Net surplus</p>
              <p className="mt-1 text-2xl font-semibold text-[var(--text-strong)]"><Money value={result.review.netSurplus} /></p>
              <div className="mt-3">
                <Badge tone={alertTone(result.review.alertStatus)}>{result.review.alertStatus}</Badge>
              </div>
            </div>
            <Table headers={["Distribution key", "Amount"]}>
              {Object.entries(result.review.distributions).map(([key, amount]) => (
                <tr key={key}>
                  <td className="px-4 py-3 text-sm font-medium text-[var(--text-strong)]">{key}</td>
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]"><Money value={amount} /></td>
                </tr>
              ))}
            </Table>
          </div>
        </Card>
      ) : null}
    </PageShell>
  );
}
