import { useEffect, useMemo, useState } from "react";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { ApiError } from "../api/client";
import { getGoals } from "../api/goalsApi";
import { getMonthlyReviews } from "../api/monthlyReviewApi";
import { getDashboardReport } from "../api/reportsApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { PageShell } from "../components/layout/PageShell";
import { useAuth } from "../context/AuthContext";
import { usePeriod } from "../components/layout/PeriodProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { useAsyncData } from "../hooks/useAsyncData";
import {
  countCompletedGoalMilestones,
  getGoalAchievementBadges,
  getGoalsAchievedCount,
  getGoalMilestones,
  readGoalAchievements,
  syncGoalAchievements,
  writeGoalAchievements,
} from "../lib/goalAchievements";
import { Money } from "../components/ui/Money";
import type { AllocationCategory, Goal, GoalProgress } from "../lib/types";

interface ProfileViewModel {
  categories: AllocationCategory[];
  allocationCount: number;
  activeAllocationCount: number;
  goalCount: number;
  monthlyReviewCount: number;
  goals: Goal[];
  goalProgress: GoalProgress[];
}

interface CompletedGoalSummary {
  goal: Goal;
  progress: GoalProgress;
  completedAt: string;
  categoryLabel: string;
  milestonesCompleted: number;
  badges: Array<{ label: string; tone: "success" | "neutral" }>;
}

const VISIBLE_ACHIEVEMENTS_LIMIT = 5;

function resolveGoalCategoryLabel(goal: Goal, progress: GoalProgress | null, categoryLookup: Map<string, string>) {
  return (
    categoryLookup.get(progress?.bucket_id ?? "")
    ?? categoryLookup.get(goal.bucket_id)
    ?? progress?.bucket_name
    ?? goal.bucket_id
  );
}

export function Profile() {
  const { session } = useAuth();
  const { activeRange } = usePeriod();
  const { data, error, isLoading, reload } = useAsyncData<ProfileViewModel>(async () => {
    const currentYear = new Date().getFullYear();
    const [categories, goalsResponse, monthlyReviewsResponse, dashboard] = await Promise.all([
      getAllocationCategories().catch((requestError) => {
        if (requestError instanceof ApiError && requestError.status === 404) {
          return [];
        }

        throw requestError;
      }),
      getGoals(),
      getMonthlyReviews({
        from: `${currentYear}-01-01`,
        to: `${currentYear}-12-01`,
      }),
      getDashboardReport({ from: activeRange.from, to: activeRange.to }),
    ]);

    return {
      categories,
      allocationCount: categories.length,
      activeAllocationCount: categories.filter((item) => item.isActive !== false).length,
      goalCount: goalsResponse.items.length,
      monthlyReviewCount: monthlyReviewsResponse.items.length,
      goals: goalsResponse.items,
      goalProgress: dashboard.goal_progress,
    };
  }, [activeRange.from, activeRange.to]);

  const [goalAchievementState, setGoalAchievementState] = useState(() => readGoalAchievements());
  const [selectedAchievementGoalId, setSelectedAchievementGoalId] = useState<string | null>(null);
  const [showAllAchievements, setShowAllAchievements] = useState(false);

  useEffect(() => {
    if (!data) {
      return;
    }

    const { state } = syncGoalAchievements(data.goalProgress, readGoalAchievements());
    writeGoalAchievements(state);
    setGoalAchievementState(state);
  }, [data]);

  const goalsAchievedCount = data ? getGoalsAchievedCount(data.goals, goalAchievementState) : 0;
  const goalAchievementBadges = data ? getGoalAchievementBadges(data.goals, goalAchievementState) : [];
  const completedGoals = useMemo<CompletedGoalSummary[]>(() => {
    if (!data) {
      return [];
    }

    const categoryLookup = new Map(data.categories.map((category) => [category.id, category.label]));
    const progressLookup = new Map(data.goalProgress.map((progress) => [progress.goal_id, progress]));
    const completedEntries = Object.entries(goalAchievementState)
      .filter(([goalId]) => data.goals.some((goal) => goal.id === goalId))
      .map(([goalId, achievement]) => {
        const goal = data.goals.find((item) => item.id === goalId);
        const progress = progressLookup.get(goalId);

        if (!goal || !progress || progress.progress_percent < 100) {
          return null;
        }

        const goalBadges: Array<{ label: string; tone: "success" | "neutral" }> = [];
        const earliestCompletedGoalId = Object.entries(goalAchievementState)
          .sort((left, right) => left[1].completed_at.localeCompare(right[1].completed_at))[0]?.[0];

        if (goalId === earliestCompletedGoalId) {
          goalBadges.push({ label: "First Goal Completed", tone: "success" });
        }

        if (!goalBadges.length) {
          goalBadges.push({ label: "Target Reached", tone: "success" });
        }

        return {
          goal,
          progress,
          completedAt: achievement.completed_at,
          categoryLabel: resolveGoalCategoryLabel(goal, progress, categoryLookup),
          milestonesCompleted: countCompletedGoalMilestones(progress),
          badges: goalBadges,
        };
      })
      .filter((item): item is CompletedGoalSummary => item !== null)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));

    return completedEntries;
  }, [data, goalAchievementState]);
  const completedMilestonesCount = completedGoals.reduce((total, item) => total + item.milestonesCompleted, 0);
  const visibleCompletedGoals = showAllAchievements
    ? completedGoals
    : completedGoals.slice(0, VISIBLE_ACHIEVEMENTS_LIMIT);
  const selectedAchievement = completedGoals.find((item) => item.goal.id === selectedAchievementGoalId) ?? null;

  return (
    <PageShell
      eyebrow="Profile"
      title="Profile"
      description="Account summary."
    >
      {isLoading ? <LoadingState label="Loading profile overview..." /> : null}
      {!isLoading && error ? (
        <ErrorState
          title="Failed to load profile"
          message={error}
          onRetry={() => void reload()}
        />
      ) : null}
      {!isLoading && !error && data ? (
        <section className="grid gap-4">
          <Card title="Account" subtitle="Signed-in user and workspace details.">
            <div className="flex flex-wrap items-start gap-4">
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-bold"
                style={{ background: "var(--primary-color)", color: "var(--primary-contrast)" }}
                aria-hidden="true"
              >
                {(session?.email?.[0] ?? "?").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--text-strong)]">{session?.email ?? "—"}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">Signed-in account</p>
              </div>
              {session?.remiTier && (
                <Badge tone={session.remiTier === "paid" ? "success" : "neutral"}>
                  {session.remiTier === "paid" ? "Paid plan" : "Free plan"}
                </Badge>
              )}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Active workspace</p>
                <p className="mt-2 text-sm font-semibold text-[var(--text-strong)]">{session?.workspaceName ?? "—"}</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">ID: {session?.workspaceId ? `…${session.workspaceId.slice(-8)}` : "—"}</p>
              </div>
              <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Workspaces</p>
                {session?.workspaces?.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {session.workspaces.map((ws) => (
                      <li key={ws.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate font-medium text-[var(--text-strong)]">{ws.name}</span>
                        <Badge tone={ws.status === "active" ? "success" : "neutral"}>{ws.role}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-[var(--text-muted)]">{session?.workspaceName ?? "—"}</p>
                )}
              </div>
            </div>
          </Card>

          <section className="grid gap-4 md:grid-cols-3">
            <Card title="Monthly Reviews" subtitle="This calendar year.">
              <p className="text-2xl font-bold tracking-tight text-[var(--text-strong)]">{data.monthlyReviewCount}</p>
              <p className="mt-2 text-sm text-[var(--text-muted)]">Saved monthly reviews</p>
            </Card>
            <Card title="Categories" subtitle="Allocation budget setup.">
              <p className="text-2xl font-bold tracking-tight text-[var(--text-strong)]">{data.activeAllocationCount}</p>
              <p className="mt-2 text-sm text-[var(--text-muted)]">{data.allocationCount} total · {data.activeAllocationCount} active</p>
            </Card>
            <Card title="Goals" subtitle="Savings and targets.">
              <p className="text-2xl font-bold tracking-tight text-[var(--text-strong)]">{data.goalCount}</p>
              <p className="mt-2 text-sm text-[var(--text-muted)]">Goals currently tracked</p>
            </Card>
          </section>

          <Card
            title="Goals Achieved"
            subtitle="Completed goal milestones and unlocked achievements."
            actions={completedGoals.length > VISIBLE_ACHIEVEMENTS_LIMIT ? (
              <Button type="button" variant="ghost" onClick={() => setShowAllAchievements((current) => !current)}>
                {showAllAchievements ? "Show recent only" : "View all achievements -&gt;"}
              </Button>
            ) : undefined}
          >
            {completedGoals.length ? (
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Goals achieved</div>
                    <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--text-strong)]">{goalsAchievedCount}</div>
                  </div>
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Achievements unlocked</div>
                    <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--text-strong)]">{goalAchievementBadges.length}</div>
                  </div>
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Milestones completed</div>
                    <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--text-strong)]">{completedMilestonesCount}</div>
                  </div>
                </div>

                <div className="space-y-2">
                  {visibleCompletedGoals.map((item) => (
                    <button
                      key={item.goal.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-4 rounded-2xl border border-[var(--border-color)] px-4 py-3 text-left transition hover:shadow-sm"
                      style={{ background: "var(--surface-plain)" }}
                      onClick={() => setSelectedAchievementGoalId(item.goal.id)}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--text-strong)]">{item.goal.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                          <span>{item.categoryLabel}</span>
                          {item.badges.map((badge) => (
                            <Badge key={`${item.goal.id}-${badge.label}`} tone={badge.tone}>{badge.label}</Badge>
                          ))}
                          <Badge tone="success">Target Reached</Badge>
                          {item.goal.active === false ? <Badge tone="neutral">Archived</Badge> : null}
                          <span>{new Date(item.completedAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-sm text-[var(--text-muted)]">View</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState
                title="No goals achieved yet"
                message="Complete a savings goal to unlock your first achievement."
              />
            )}
          </Card>

          {selectedAchievement ? (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
              <div
                className="w-full max-w-2xl rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-xl"
                style={{ background: "var(--surface-color)" }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-lg font-semibold text-[var(--text-strong)]">{selectedAchievement.goal.name}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{selectedAchievement.categoryLabel}</Badge>
                      <Badge tone="success">Target Reached</Badge>
                      {selectedAchievement.goal.active === false ? <Badge tone="neutral">Archived</Badge> : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-9 min-w-9 rounded-full px-0 text-[var(--text-muted)] hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]"
                    aria-label="Close achievement details"
                    onClick={() => setSelectedAchievementGoalId(null)}
                  >
                    X
                  </Button>
                </div>

                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Target amount</div>
                    <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]">{<Money value={selectedAchievement.goal.target_amount} />}</div>
                  </div>
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Progress achieved</div>
                    <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]">
                      {<Money value={selectedAchievement.progress.current_amount} />} / {<Money value={selectedAchievement.goal.target_amount} />}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Milestone breakdown</div>
                    <div className="mt-2 space-y-2">
                      {getGoalMilestones(selectedAchievement.progress).map((milestone) => (
                        <div key={milestone.id} className="flex items-center justify-between gap-3 text-sm">
                          <span className={milestone.completed ? "text-[var(--text-strong)]" : "text-[var(--text-muted)]"}>
                            {milestone.label}
                          </span>
                          <span className={milestone.completed ? "text-emerald-600" : "text-[var(--text-muted)]"}>
                            {milestone.completed ? "✓" : "○"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Completed on</div>
                    <div className="mt-2 text-sm text-[var(--text-strong)]">{new Date(selectedAchievement.completedAt).toLocaleDateString()}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {!isLoading && !error && !data ? (
        <EmptyState
          title="No profile data yet"
          message="Profile details and planning summaries will appear here as more account data becomes available."
        />
      ) : null}
    </PageShell>
  );
}
