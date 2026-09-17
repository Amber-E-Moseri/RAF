import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { createGoal, deleteGoal, getGoals, updateGoal } from "../api/goalsApi";
import { getImportedTransactions } from "../api/importsApi";
import { getDashboardReport } from "../api/reportsApi";
import { getTransactions } from "../api/transactionsApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { usePeriod } from "../components/layout/PeriodProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { useAsyncData } from "../hooks/useAsyncData";
import { Money } from "../components/ui/Money";
import {
  getGoalMilestones,
  markGoalCelebrationSeen,
  readGoalAchievements,
  syncGoalAchievements,
  writeGoalAchievements,
} from "../lib/goalAchievements";
import type { AllocationCategory, Goal, GoalProgress, ImportedTransaction, Transaction } from "../lib/types";

interface GoalsViewModel {
  categories: AllocationCategory[];
  goals: Goal[];
  progress: GoalProgress[];
  transactions: Transaction[];
  imports: ImportedTransaction[];
}

interface GoalFormState {
  name: string;
  bucketId: string;
  targetAmount: string;
  targetDate: string;
  notes: string;
  active: boolean;
}

interface GoalActivityItem {
  id: string;
  date: string;
  description: string;
  amount: string;
  direction: "credit" | "debit";
  source: "transaction" | "pdf_import";
}

function goalBucketLabel(goal: Goal, progress: GoalProgress | null, categoryLookup: Map<string, AllocationCategory>) {
  return (
    categoryLookup.get(progress?.bucket_id ?? "")?.label
    ?? categoryLookup.get(goal.bucket_id)?.label
    ?? progress?.bucket_name
    ?? goal.bucket_id
  );
}

const EMPTY_GOAL_FORM: GoalFormState = {
  name: "",
  bucketId: "",
  targetAmount: "",
  targetDate: "",
  notes: "",
  active: true,
};

function mapGoalToForm(goal: Goal): GoalFormState {
  return {
    name: goal.name,
    bucketId: goal.bucket_id,
    targetAmount: goal.target_amount,
    targetDate: goal.target_date ?? "",
    notes: goal.notes ?? "",
    active: goal.active !== false,
  };
}

function toGoalPayload(form: GoalFormState) {
  return {
    bucket_id: form.bucketId,
    name: form.name.trim(),
    target_amount: form.targetAmount.trim(),
    target_date: form.targetDate.trim() ? form.targetDate : null,
    notes: form.notes.trim() ? form.notes.trim() : null,
    active: form.active,
  };
}

function goalStatusTone(progress: GoalProgress | null) {
  if (!progress) {
    return "warning";
  }

  const remaining = Number(progress.remaining_amount);
  if (remaining <= 0) {
    return "success";
  }
  if (progress.progress_percent >= 50) {
    return "neutral";
  }

  return "warning";
}

function goalStatusLabel(progress: GoalProgress | null) {
  if (!progress) {
    return "Nothing saved yet";
  }

  const remaining = Number(progress.remaining_amount);
  if (remaining <= 0) {
    return "Target Reached";
  }
  if (progress.progress_percent >= 50) {
    return "On the way";
  }
  return "Early progress";
}

function nextMilestoneLabel(progress: GoalProgress | null) {
  return getGoalMilestones(progress).find((milestone) => !milestone.completed)?.label ?? "All milestones completed";
}

function goalProgressFill() {
  return "color-mix(in srgb, var(--primary-color) 72%, var(--text-strong))";
}

export function Goals() {
  const { activeMonthLabel, activeRange } = usePeriod();
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState<GoalFormState>(EMPTY_GOAL_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [expandedRecentActivity, setExpandedRecentActivity] = useState<Record<string, boolean>>({});
  const [celebratingGoalIds, setCelebratingGoalIds] = useState<Record<string, boolean>>({});
  const [goalCelebrationMessages, setGoalCelebrationMessages] = useState<Record<string, boolean>>({});
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const hasSyncedGoalState = useRef(false);

  const goalsData = useAsyncData<GoalsViewModel>(async () => {
    const [categories, goalsResponse, dashboard, transactions, imports] = await Promise.all([
      getAllocationCategories(),
      getGoals(),
      getDashboardReport({ from: activeRange.from, to: activeRange.to }),
      getTransactions({ from: activeRange.from, to: activeRange.to, limit: 100 }),
      getImportedTransactions(),
    ]);

    return {
      categories: categories.filter((category) => category.isActive !== false),
      goals: goalsResponse.items,
      progress: dashboard.goal_progress,
      transactions: transactions.items,
      imports: imports.items,
    };
  }, [activeRange.from, activeRange.to]);

  const categoryLookup = useMemo(
    () => new Map((goalsData.data?.categories ?? []).map((category) => [category.id, category])),
    [goalsData.data?.categories],
  );

  const progressLookup = useMemo(
    () => new Map((goalsData.data?.progress ?? []).map((progress) => [progress.goal_id, progress])),
    [goalsData.data?.progress],
  );

  const activeGoals = useMemo(
    () => (goalsData.data?.goals ?? []).filter((goal) => goal.active !== false),
    [goalsData.data?.goals],
  );

  const archivedGoals = useMemo(
    () => (goalsData.data?.goals ?? []).filter((goal) => goal.active === false),
    [goalsData.data?.goals],
  );

  const recentActivityByGoalId = useMemo(() => {
    const grouped = new Map<string, GoalActivityItem[]>();
    const importedTransactionIds = new Set(
      (goalsData.data?.imports ?? [])
        .map((item) => item.linked_transaction_id)
        .filter((value): value is string => Boolean(value)),
    );

    for (const transaction of goalsData.data?.transactions ?? []) {
      if (!transaction.linkedGoalId) {
        continue;
      }

      const current = grouped.get(transaction.linkedGoalId) ?? [];
      current.push({
        id: transaction.id,
        date: transaction.transactionDate,
        description: transaction.description,
        amount: transaction.amount,
        direction: transaction.direction,
        source: importedTransactionIds.has(transaction.id) ? "pdf_import" : "transaction",
      });
      grouped.set(transaction.linkedGoalId, current);
    }

    for (const importedRow of goalsData.data?.imports ?? []) {
      if (importedRow.linked_goal_id == null || importedRow.status === "ignored") {
        continue;
      }

      const current = grouped.get(importedRow.linked_goal_id) ?? [];
      if (!importedRow.linked_transaction_id || !current.some((item) => item.id === importedRow.linked_transaction_id)) {
        current.push({
          id: importedRow.id,
          date: importedRow.date,
          description: importedRow.description,
          amount: importedRow.amount,
          direction: Number(importedRow.amount) >= 0 ? "credit" : "debit",
          source: "pdf_import",
        });
        grouped.set(importedRow.linked_goal_id, current);
      }
    }

    for (const [goalId, items] of grouped.entries()) {
      grouped.set(goalId, [...items].sort((left, right) => (
        right.date.localeCompare(left.date) || right.id.localeCompare(left.id)
      )));
    }

    return grouped;
  }, [activeGoals, goalsData.data?.imports, goalsData.data?.transactions]);

  const goalPaceLookup = useMemo(() => {
    const fromDate = new Date(activeRange.from);
    const toDate = new Date(activeRange.to);
    const diffMonths = Math.max(1, (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    const lookup = new Map<string, number>();
    for (const goal of activeGoals) {
      const totalCredits = (goalsData.data?.transactions ?? [])
        .filter((t) => t.linkedGoalId === goal.id && t.direction === "credit")
        .reduce((sum, t) => sum + Number(t.amount), 0);
      if (totalCredits > 0) {
        lookup.set(goal.id, totalCredits / diffMonths);
      }
    }
    return lookup;
  }, [activeGoals, goalsData.data?.transactions, activeRange.from, activeRange.to]);

  const canSubmit = form.name.trim() && form.bucketId && form.targetAmount.trim();

  useEffect(() => {
    if (!editingGoalId && !form.bucketId && goalsData.data?.categories.length) {
      setForm((current) => ({
        ...current,
        bucketId: current.bucketId || goalsData.data?.categories[0]?.id || current.bucketId,
      }));
    }
  }, [editingGoalId, form.bucketId, goalsData.data?.categories]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyPreference = () => setPrefersReducedMotion(mediaQuery.matches);
    applyPreference();
    mediaQuery.addEventListener?.("change", applyPreference);

    return () => {
      mediaQuery.removeEventListener?.("change", applyPreference);
    };
  }, []);

  useEffect(() => {
    if (!goalsData.data) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const storedAchievements = readGoalAchievements();
    const { state: syncedAchievements } = syncGoalAchievements(goalsData.data.progress, storedAchievements);

    if (!hasSyncedGoalState.current) {
      hasSyncedGoalState.current = true;
      writeGoalAchievements(syncedAchievements);
      return undefined;
    }

    const unseenGoalIds = activeGoals
      .map((goal) => goal.id)
      .filter((goalId) => syncedAchievements[goalId]?.celebration_unseen === true);

    if (unseenGoalIds.length) {
      setGoalCelebrationMessages((current) => ({
        ...current,
        ...Object.fromEntries(unseenGoalIds.map((goalId) => [goalId, true])),
      }));
    }

    const nextAchievementState = unseenGoalIds.reduce(
      (state, goalId) => markGoalCelebrationSeen(goalId, state),
      syncedAchievements,
    );
    writeGoalAchievements(nextAchievementState);

    if (unseenGoalIds.length && !prefersReducedMotion) {
      setCelebratingGoalIds((current) => ({
        ...current,
        ...Object.fromEntries(unseenGoalIds.map((goalId) => [goalId, true])),
      }));

      const timeoutId = window.setTimeout(() => {
        setCelebratingGoalIds((current) => {
          const next = { ...current };
          unseenGoalIds.forEach((goalId) => {
            delete next[goalId];
          });
          return next;
        });
      }, 1400);

      const messageTimeoutId = window.setTimeout(() => {
        setGoalCelebrationMessages((current) => {
          const next = { ...current };
          unseenGoalIds.forEach((goalId) => {
            delete next[goalId];
          });
          return next;
        });
      }, 2200);

      return () => {
        window.clearTimeout(timeoutId);
        window.clearTimeout(messageTimeoutId);
      };
    }

    return undefined;
  }, [activeGoals, goalsData.data, prefersReducedMotion, progressLookup]);

  function resetForm() {
    setEditingGoalId(null);
    setShowCreateForm(false);
    setForm({
      ...EMPTY_GOAL_FORM,
      bucketId: goalsData.data?.categories[0]?.id ?? "",
    });
    setSaveError(null);
  }

  function startEdit(goal: Goal) {
    setEditingGoalId(goal.id);
    setShowCreateForm(false);
    setForm(mapGoalToForm(goal));
    setSaveError(null);
    setSaveMessage(null);
  }

  function toggleRecentActivity(goalId: string) {
    setExpandedRecentActivity((current) => ({
      ...current,
      [goalId]: !current[goalId],
    }));
  }

  const selectedGoal = activeGoals.find((goal) => goal.id === selectedGoalId) ?? null;
  const selectedGoalProgress = selectedGoal ? (progressLookup.get(selectedGoal.id) ?? null) : null;
  const selectedGoalMilestones = getGoalMilestones(selectedGoalProgress);
  const selectedGoalRecentTransactions = selectedGoal ? (recentActivityByGoalId.get(selectedGoal.id) ?? []) : [];
  const selectedGoalAvgMonthly = selectedGoal ? (goalPaceLookup.get(selectedGoal.id) ?? 0) : 0;
  const selectedGoalRemaining = selectedGoalProgress ? Math.max(0, Number(selectedGoalProgress.remaining_amount)) : 0;
  const selectedGoalProjectedMonths = selectedGoalAvgMonthly > 0 && selectedGoalRemaining > 0
    ? Math.ceil(selectedGoalRemaining / selectedGoalAvgMonthly)
    : null;

  async function handleSubmit() {
    if (!canSubmit) {
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      if (editingGoalId) {
        await updateGoal(editingGoalId, toGoalPayload(form));
        setSaveMessage("Goal updated.");
      } else {
        await createGoal(toGoalPayload(form));
        setSaveMessage("Goal created.");
      }
      resetForm();
      await goalsData.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Goal changes could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleArchive(goalId: string) {
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      await deleteGoal(goalId);
      setSaveMessage("Goal archived.");
      if (editingGoalId === goalId) {
        resetForm();
      }
      await goalsData.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Goal could not be archived.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUnarchive(goalId: string) {
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      await updateGoal(goalId, { active: true });
      setSaveMessage("Goal restored.");
      await goalsData.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Goal could not be restored.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(goalId: string) {
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      await deleteGoal(goalId);
      setSaveMessage("Goal deleted.");
      if (editingGoalId === goalId) {
        resetForm();
      }
      await goalsData.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Goal could not be deleted.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <PageShell
      eyebrow="Goals"
      title="Fund what matters next."
      description="Track progress, target dates and milestones without silently redirecting your money."
      actions={
        <Button type="button" onClick={() => { resetForm(); setShowCreateForm(true); }}>
          New goal
        </Button>
      }
    >
      {goalsData.isLoading ? <LoadingState label="Loading goals..." /> : null}
      {!goalsData.isLoading && goalsData.error ? (
        <ErrorState
          title="Failed to load goals"
          message={goalsData.error}
          onRetry={() => void goalsData.reload()}
        />
      ) : null}
      {saveError ? <ErrorState title="Goal update failed" message={saveError} /> : null}
      {saveMessage ? <SuccessNotice title="Goals updated" message={saveMessage} /> : null}

      {!goalsData.isLoading && !goalsData.error && goalsData.data ? (
        <>
          <section className="grid gap-4 grid-cols-3">
            <Card>
              <p className="text-[10px] font-[750] uppercase text-[var(--text-muted)]">Goal targets</p>
              <p className="mt-[5px] text-[25px] font-[900] leading-[1.05] tracking-[-0.045em] text-[var(--text-strong)]"><Money value={String(activeGoals.reduce((sum, g) => sum + Number(g.target_amount || "0"), 0).toFixed(2))} /></p>
              <p className="mt-[5px] text-[10px] text-[var(--text-muted)]">Includes transaction-linked funding</p>
            </Card>
            <Card>
              <p className="text-[10px] font-[750] uppercase text-[var(--text-muted)]">Funded</p>
              <p className="mt-[5px] text-[25px] font-[900] leading-[1.05] tracking-[-0.045em] text-[var(--text-strong)]"><Money value={String(activeGoals.reduce((sum, g) => sum + Number(progressLookup.get(g.id)?.current_amount || "0"), 0).toFixed(2))} /></p>
              <p className="mt-[5px] text-[10px] text-[var(--text-muted)]">Includes transaction-linked funding</p>
            </Card>
            <Card>
              <p className="text-[10px] font-[750] uppercase text-[var(--text-muted)]">Active goals</p>
              <p className="mt-[5px] text-[25px] font-[900] leading-[1.05] tracking-[-0.045em] text-[var(--text-strong)]">{activeGoals.length}</p>
            </Card>
          </section>

          <section className="grid gap-[14px] md:grid-cols-3">
            {activeGoals.length ? (
              activeGoals.map((goal) => {
                const progress = progressLookup.get(goal.id) ?? null;
                const progressPercent = Math.max(0, Math.min(progress?.progress_percent ?? 0, 100));
                const isReached = (progress?.progress_percent ?? 0) >= 100;
                const isCelebrating = celebratingGoalIds[goal.id] === true;
                const showCelebrationMessage = goalCelebrationMessages[goal.id] === true;
                const cardRemaining = Math.max(0, Number(progress?.remaining_amount ?? "0"));
                const recentFunding = recentActivityByGoalId.get(goal.id)?.slice(0, 3) ?? [];
                const milestones = getGoalMilestones(progress);
                const nextMilestone = milestones.find((m) => !m.completed);

                return (
                  <div
                    key={goal.id}
                    className={`relative overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 shadow-[var(--shadow-sm)] ${isReached ? "goal-reached-card" : ""}`}
                  >
                    {isCelebrating ? (
                      <div className="goal-celebration" aria-hidden="true">
                        {Array.from({ length: 10 }).map((_, index) => (
                          <span
                            key={index}
                            className="goal-burst"
                            style={{
                              "--goal-angle": `${index * 36}deg`,
                              "--goal-delay": `${index * 0.03}s`,
                            } as CSSProperties}
                          />
                        ))}
                      </div>
                    ) : null}
                    {showCelebrationMessage ? (
                      <div className="mb-3 rounded-xl border border-[var(--badge-success-ring)] bg-[var(--badge-success-bg)] px-3 py-2 text-xs text-[var(--badge-success-text)]">
                        Goal Reached! {goal.name} target achieved.
                      </div>
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-[12px] font-[900] text-[var(--text-strong)]">{goal.name}</h3>
                        <p className="mt-[3px] text-[9.5px] text-[var(--text-muted)]">
                          Target {goal.target_date ?? "not set"} · milestones optional
                        </p>
                      </div>
                      <Badge tone={goalStatusTone(progress)}>{goalStatusLabel(progress)}</Badge>
                    </div>
                    <p className="mt-[15px] text-[22px] font-[900] tracking-[-0.04em] text-[var(--text-strong)]">
                      <Money value={progress?.current_amount ?? "0.00"} />
                      <span className="text-[12px] font-normal text-[var(--text-muted)]"> / <Money value={goal.target_amount} /></span>
                    </p>
                    <div className="mt-[5px]">
                      <div className="h-[7px] overflow-hidden rounded-full bg-[#eef1ef]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${progressPercent}%`, background: "linear-gradient(90deg, #22b783, var(--primary-color))" }}
                        />
                      </div>
                      <p className="mt-[7px] text-[9.5px] text-[var(--text-muted)]">
                        {progressPercent.toFixed(0)}% funded
                        {nextMilestone ? ` · ${nextMilestone.label} to next milestone` : ""}
                      </p>
                    </div>
                    {recentFunding.length > 0 ? (
                      <div className="mt-[13px] border-t border-[var(--border-color)] pt-[10px]">
                        <p className="text-[8.5px] font-[900] uppercase tracking-[0.07em] text-[var(--text-muted)]">Recent funding</p>
                        {recentFunding.map((tx) => (
                          <div key={tx.id} className="flex items-center justify-between gap-3 py-[7px] text-[9.5px]">
                            <span className="text-[var(--text-muted)]">{tx.date.slice(5)} · {tx.description}</span>
                            <b className="text-[var(--text-strong)]">+<Money value={tx.amount} /></b>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-[14px] flex gap-[7px]">
                      <Button type="button" className="rounded-[8px] px-[9px] py-[6px] text-[10px] font-[900] min-h-0" onClick={() => setSelectedGoalId(goal.id)}>
                        Add funding
                      </Button>
                      <Button type="button" variant="secondary" className="rounded-[8px] px-[9px] py-[6px] text-[10px] font-[900] min-h-0" onClick={() => setSelectedGoalId(goal.id)}>
                        Link transaction
                      </Button>
                      <Button type="button" variant="secondary" className="rounded-[8px] px-[9px] py-[6px] text-[10px] font-[900] min-h-0" onClick={() => startEdit(goal)}>
                        {goal.active !== false ? "Pause" : "Resume"}
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : goalsData.data.categories.length ? (
              <div className="md:col-span-3">
                <EmptyState
                  title="No goals yet"
                  message="Create a goal to track progress toward a savings target."
                />
              </div>
            ) : (
              <div className="md:col-span-3">
                <EmptyState
                  title="Set up allocation first"
                  message="Goals are linked to categories, so add at least one active category before creating a goal."
                />
              </div>
            )}
          </section>

          {editingGoalId || showCreateForm || !activeGoals.length ? (
            <Card
              title={editingGoalId ? "Edit Goal" : "Create Goal"}
              subtitle={editingGoalId
                ? "Update the target, linked category, or notes for this goal."
                : "Create a simple savings target linked to one planning category."}
            >
              {goalsData.data.categories.length ? (
                <div className="space-y-4">
                  <Input
                    label="Goal name"
                    value={form.name}
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Vacation Fund"
                  />

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-strong)]">Linked category</span>
                    <select
                      className="ui-field"
                      value={form.bucketId}
                      onChange={(event) => setForm((current) => ({ ...current, bucketId: event.target.value }))}
                    >
                      <option value="" disabled>Select a category</option>
                      {goalsData.data.categories.map((category) => (
                        <option key={category.id} value={category.id}>{category.label}</option>
                      ))}
                    </select>
                  </label>

                  <Input
                    label="Target amount"
                    value={form.targetAmount}
                    onChange={(event) => setForm((current) => ({ ...current, targetAmount: event.target.value }))}
                    placeholder="2500.00"
                    inputMode="decimal"
                  />

                  <Input
                    label="Target date"
                    type="date"
                    value={form.targetDate}
                    onChange={(event) => setForm((current) => ({ ...current, targetDate: event.target.value }))}
                  />

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-strong)]">Notes</span>
                    <textarea
                      className="ui-field min-h-28 resize-y"
                      value={form.notes}
                      onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                      placeholder="Optional planning note or reminder."
                    />
                  </label>

                  <label className="flex items-center justify-between rounded-2xl border border-[var(--border-color)] px-4 py-3 text-sm text-[var(--text-strong)]" style={{ background: "var(--surface-plain)" }}>
                    <span>Keep this goal active</span>
                    <input
                      type="checkbox"
                      checked={form.active}
                      onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))}
                    />
                  </label>

                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={resetForm}>
                      {editingGoalId ? "Cancel" : "Clear"}
                    </Button>
                    <Button type="button" disabled={!canSubmit || isSaving} onClick={() => void handleSubmit()}>
                      {isSaving ? "Saving..." : editingGoalId ? "Save Goal" : "Create Goal"}
                    </Button>
                  </div>
                </div>
              ) : (
                <EmptyState
                  title="No active categories available"
                  message="Goals can be created after categories are configured."
                />
              )}
            </Card>
          ) : null}

          {archivedGoals.length ? (
            <Card title="Archived Goals" subtitle="Archived goals stay visible for reference but are no longer part of active planning.">
              <div className="space-y-3">
                {archivedGoals.map((goal) => {
                  const progress = progressLookup.get(goal.id) ?? null;
                  return (
                    <div key={goal.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-color)] px-4 py-3" style={{ background: "var(--surface-plain)" }}>
                      <div>
                        <div className="font-medium text-[var(--text-strong)]">{goal.name}</div>
                        <div className="mt-1 text-sm text-[var(--text-muted)]">
                          {goalBucketLabel(goal, progress, categoryLookup)} · Target <Money value={goal.target_amount} />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">Archived</Badge>
                        <Button type="button" variant="ghost" className="min-h-8 rounded-full px-3 py-1 text-xs" disabled={isSaving} onClick={() => void handleUnarchive(goal.id)}>
                          Unarchive
                        </Button>
                        <Button type="button" variant="ghost" className="min-h-8 rounded-full px-3 py-1 text-xs text-rose-600 hover:bg-rose-50" disabled={isSaving} onClick={() => void handleDelete(goal.id)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {selectedGoal && selectedGoalProgress ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
          <div
            className="w-full max-w-3xl rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-xl"
            style={{ background: "var(--surface-color)" }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-[var(--text-strong)]">{selectedGoal.name}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">
                    {goalBucketLabel(selectedGoal, selectedGoalProgress, categoryLookup)}
                  </Badge>
                  <Badge tone={goalStatusTone(selectedGoalProgress)}>{goalStatusLabel(selectedGoalProgress)}</Badge>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="min-h-9 min-w-9 rounded-full px-0 text-[var(--text-muted)] hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]"
                aria-label="Close goal details"
                onClick={() => setSelectedGoalId(null)}
              >
                X
              </Button>
            </div>

            <div className="mt-5 grid gap-4 grid-cols-1 sm:grid-cols-3">
              <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Target amount</div>
                <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]">{<Money value={selectedGoal.target_amount} />}</div>
              </div>
              <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Paid so far</div>
                <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]">
                  {<Money value={selectedGoalProgress.current_amount} />}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Still needed</div>
                <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]">
                  <Money value={String(selectedGoalRemaining.toFixed(2))} />
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
              <div className="flex items-center justify-between gap-3 text-sm text-[var(--text-muted)]">
                <span>Progress</span>
                <span>{Math.max(0, Math.min(selectedGoalProgress.progress_percent, 100)).toFixed(0)}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full" style={{ background: "var(--surface-elevated)" }}>
                <div
                  className="h-full rounded-full transition-[width] duration-200"
                  style={{
                    width: `${Math.max(0, Math.min(selectedGoalProgress.progress_percent, 100))}%`,
                    background: goalProgressFill(),
                  }}
                />
              </div>
              <p className="mt-3 text-sm italic text-[var(--text-muted)]">
                Next milestone: {nextMilestoneLabel(selectedGoalProgress)}
              </p>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
              <div className="text-sm font-semibold text-[var(--text-strong)]">Milestones</div>
              <div className="mt-3 space-y-2">
                {selectedGoalMilestones.map((milestone) => (
                  <div
                    key={milestone.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2"
                    style={{
                      background: milestone.completed ? "var(--badge-success-bg)" : "var(--surface-color)",
                      borderColor: milestone.completed ? "var(--badge-success-ring)" : "var(--border-color)",
                    }}
                  >
                    <div className={`text-sm ${milestone.completed ? "text-[var(--badge-success-text)]" : "text-[var(--text-muted)]"}`}>
                      {milestone.label}
                    </div>
                    <div className={`text-sm font-semibold ${milestone.completed ? "text-[var(--badge-success-text)]" : "text-[var(--text-muted)]"}`}>
                      {milestone.completed ? "âœ“" : "â—‹"}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {selectedGoalAvgMonthly > 0 ? (
              <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                <div className="text-sm font-semibold text-[var(--text-strong)]">Pace</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Avg / month (this period)</div>
                    <div className="mt-1 text-base font-semibold text-[var(--text-strong)]"><Money value={selectedGoalAvgMonthly.toFixed(2)} /></div>
                  </div>
                  {selectedGoalProjectedMonths !== null ? (
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Est. at this pace</div>
                      <div className="mt-1 text-base font-semibold text-[var(--text-strong)]">~{selectedGoalProjectedMonths} month{selectedGoalProjectedMonths === 1 ? "" : "s"}</div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="mt-4 rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => selectedGoal && toggleRecentActivity(selectedGoal.id)}
              >
                <div>
                  <div className="text-sm font-semibold text-[var(--text-strong)]">Recent transactions</div>
                  <div className="mt-1 text-xs italic text-[var(--text-muted)]">All linked transactions (this period)</div>
                </div>
                <div className="text-sm text-[var(--text-muted)]">
                  {expandedRecentActivity[selectedGoal.id] ? "Hide" : "Show"} {selectedGoalRecentTransactions.length ? `(${selectedGoalRecentTransactions.length})` : ""}
                </div>
              </button>
              {expandedRecentActivity[selectedGoal.id] ? (
                selectedGoalRecentTransactions.length ? (
                  <div className="mt-3 space-y-2">
                    {selectedGoalRecentTransactions.map((transaction) => (
                      <div
                        key={transaction.id}
                        className="flex items-start justify-between gap-3 border-b border-[var(--border-color)] pb-2 last:border-b-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[var(--text-strong)]">{transaction.description}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                            <span>{transaction.date}</span>
                            {transaction.source === "pdf_import" ? <span>PDF import</span> : null}
                          </div>
                        </div>
                        <div className={`shrink-0 text-sm font-semibold ${transaction.direction === "credit" ? "text-emerald-700" : "text-rose-700"}`}>
                          {transaction.direction === "credit" ? "+" : "-"}
                          {<Money value={transaction.amount} />}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-[var(--text-muted)]">No goal-linked transactions for {activeMonthLabel}.</p>
                )
              ) : null}
            </div>

            {selectedGoal.notes ? (
              <p className="mt-4 text-sm italic text-[var(--text-muted)]">{selectedGoal.notes}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
