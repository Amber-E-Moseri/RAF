import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { ApiError } from "../api/client";
import { revokeInvitation, listMembers, listPendingInvitations, listWorkspaceActivity } from "../api/collaborationApi";
import type { WorkspaceInvitation } from "../api/collaborationApi";
import { getDebts } from "../api/debtsApi";
import { getFixedBills } from "../api/fixedBillsApi";
import { getGoals } from "../api/goalsApi";
import { getHouseholdSettings, updateHouseholdSettings } from "../api/householdApi";
import {
  deleteImportReviewRule,
  getImportReviewRules,
  updateImportReviewRule,
} from "../api/importsApi";
import { getMonthlyReviews } from "../api/monthlyReviewApi";
import { getDashboardReport } from "../api/reportsApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import {
  buildImportRuleDraft,
  ImportRuleEditor,
  mapRuleDraftToPayload,
} from "../components/imports/ImportRuleEditor";
import { useAppearance } from "../components/layout/AppearanceProvider";
import { PageShell } from "../components/layout/PageShell";
import { usePeriod } from "../components/layout/PeriodProvider";
import { ActivityFeed } from "../components/workspace/ActivityFeed";
import { InviteModal } from "../components/workspace/InviteModal";
import { MemberRow } from "../components/workspace/MemberRow";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Money } from "../components/ui/Money";
import { MoneyInput } from "../components/ui/MoneyInput";
import { useAsyncData } from "../hooks/useAsyncData";
import { useAuth } from "../context/AuthContext";
import { usePermission } from "../hooks/usePermission";
import {
  APPEARANCE_MODE_OPTIONS,
  DEFAULT_APPEARANCE,
  FONT_OPTIONS,
  INTERFACE_SCALE_OPTIONS,
  THEME_OPTIONS,
} from "../lib/appearance";
import type { AppearancePreferences, ThemeColor } from "../lib/appearance";
import {
  countCompletedGoalMilestones,
  getGoalAchievementBadges,
  getGoalsAchievedCount,
  getGoalMilestones,
  readGoalAchievements,
  syncGoalAchievements,
  writeGoalAchievements,
} from "../lib/goalAchievements";
import type {
  AllocationCategory,
  Debt,
  FixedBill,
  Goal,
  GoalProgress,
  HouseholdSettings,
  ImportReviewRule,
} from "../lib/types";
import { normalizeMoneyInput } from "../lib/validation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsTab = "profile" | "household" | "appearance" | "financial" | "import_rules";

const VALID_TABS: SettingsTab[] = ["profile", "household", "appearance", "financial", "import_rules"];

interface ProfileViewModel {
  categories: AllocationCategory[];
  allocationCount: number;
  activeAllocationCount: number;
  goalCount: number;
  monthlyReviewCount: number;
  goals: Goal[];
  goalProgress: GoalProgress[];
}

interface AppearanceViewModel {
  categories: AllocationCategory[];
  debts: Debt[];
  fixedBills: FixedBill[];
  goals: Goal[];
  household: HouseholdSettings;
  rules: ImportReviewRule[];
}

interface CompletedGoalSummary {
  goal: Goal;
  progress: GoalProgress;
  completedAt: string;
  categoryLabel: string;
  milestonesCompleted: number;
  badges: Array<{ label: string; tone: "success" | "neutral" }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISIBLE_ACHIEVEMENTS_LIMIT = 5;

const themeGroups: Array<{ mood: string; values: ThemeColor[]; helper: string }> = [
  { mood: "Professional", values: ["minimal", "violet"], helper: "Calm contrast for focused daily finance work." },
  { mood: "Balanced", values: ["emerald"], helper: "RAF's default look with steady contrast and warmth." },
  { mood: "Expressive", values: ["blush"], helper: "A softer accent with a little more personality." },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function resolveGoalCategoryLabel(goal: Goal, progress: GoalProgress | null, lookup: Map<string, string>) {
  return (
    lookup.get(progress?.bucket_id ?? "")
    ?? lookup.get(goal.bucket_id)
    ?? progress?.bucket_name
    ?? goal.bucket_id
  );
}

function ruleActionLabel(rule: ImportReviewRule) {
  switch (rule.classification_type) {
    case "income": return "Add to income deposit";
    case "transaction": return "Approve as transaction";
    case "debt_payment": return "Link to debt payment";
    case "fixed_bill_payment": return "Link to fixed bill";
    case "goal_funding": return "Internal transfer to savings goal";
    case "duplicate": return "Mark duplicate";
    case "transfer": return "Mark transfer";
    default: return "Ignore";
  }
}

function selectedCardClasses(selected: boolean) {
  return selected
    ? "border-[var(--primary-color)] bg-[var(--surface-plain)] shadow-panel"
    : "border-[var(--border-color)] hover:-translate-y-0.5 hover:shadow-lift";
}

function selectedCardStyle(selected: boolean) {
  return selected
    ? { background: "var(--surface-plain)", boxShadow: "inset 0 0 0 1px var(--primary-color), var(--shadow-panel)" }
    : { background: "var(--surface-plain)" };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PendingInvitationRow({
  invitation,
  canManage,
  onRevoked,
}: {
  invitation: WorkspaceInvitation;
  canManage: boolean;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleRevoke() {
    setBusy(true);
    try {
      await revokeInvitation(invitation.workspaceId, invitation.id);
      onRevoked();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[var(--border-subtle)] text-[var(--text-secondary)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
          <circle cx="12" cy="8" r="4" />
          <path d="M6 20a6 6 0 0 1 12 0" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">{invitation.email}</p>
        <p className="text-[11px] text-[var(--text-secondary)]">
          Invited as {invitation.role} · expires {formatExpiry(invitation.expiresAt)}
        </p>
      </div>
      {canManage ? (
        <button
          type="button"
          className="ui-button-ghost text-[11px] text-[var(--text-secondary)]"
          disabled={busy}
          onClick={() => void handleRevoke()}
        >
          Revoke
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab") as SettingsTab | null;
  const activeTab: SettingsTab = rawTab && VALID_TABS.includes(rawTab) ? rawTab : "profile";

  function setTab(tab: SettingsTab) {
    setSearchParams({ tab }, { replace: true });
  }

  // ---- Appearance ----
  const { preferences, saveAppearance, togglePrivacyMode } = useAppearance();
  const [draft, setDraft] = useState<AppearancePreferences>(preferences);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => { setDraft(preferences); }, [preferences]);

  const hasChanges = useMemo(
    () => (
      draft.theme_color !== preferences.theme_color
      || draft.font_family !== preferences.font_family
      || draft.appearance_mode !== preferences.appearance_mode
      || draft.interface_scale !== preferences.interface_scale
    ),
    [draft, preferences],
  );

  const activeTheme = useMemo(
    () => THEME_OPTIONS.find((o) => o.value === draft.theme_color) ?? THEME_OPTIONS[0],
    [draft.theme_color],
  );
  const activeFont = useMemo(
    () => FONT_OPTIONS.find((o) => o.value === draft.font_family) ?? FONT_OPTIONS[0],
    [draft.font_family],
  );
  const activeScale = useMemo(
    () => INTERFACE_SCALE_OPTIONS.find((o) => o.value === draft.interface_scale) ?? INTERFACE_SCALE_OPTIONS[1],
    [draft.interface_scale],
  );
  const activeMode = useMemo(
    () => APPEARANCE_MODE_OPTIONS.find((o) => o.value === draft.appearance_mode) ?? APPEARANCE_MODE_OPTIONS[0],
    [draft.appearance_mode],
  );

  function updateDraft(next: Partial<AppearancePreferences>) {
    setDraft((c) => ({ ...c, ...next }));
    setSaveMessage(null);
  }

  function handleSave() { saveAppearance(draft); setSaveMessage("Appearance settings updated."); }
  function handleCancel() { setDraft(preferences); setSaveMessage(null); }
  function handleRestoreDefaults() { setDraft(DEFAULT_APPEARANCE); setSaveMessage(null); }

  // ---- Financial / Import Rules shared data ----
  const appearanceData = useAsyncData<AppearanceViewModel>(async () => {
    const household = await getHouseholdSettings();
    const [categories, debtsResponse, fixedBillsResponse, goalsResponse, rulesResponse] = await Promise.all([
      getAllocationCategories(),
      getDebts(),
      getFixedBills(),
      getGoals(),
      getImportReviewRules(),
    ]);
    return {
      categories,
      debts: debtsResponse.items,
      fixedBills: fixedBillsResponse.items,
      goals: goalsResponse.items,
      household,
      rules: rulesResponse.items,
    };
  }, []);

  // ---- Financial (Savings Floor) ----
  const [savingsFloorDraft, setSavingsFloorDraft] = useState({ enabled: false, amount: "0.00" });
  const [savingsFloorMessage, setSavingsFloorMessage] = useState<string | null>(null);
  const [savingsFloorError, setSavingsFloorError] = useState<string | null>(null);
  const [isSavingFloor, setIsSavingFloor] = useState(false);

  useEffect(() => {
    if (!appearanceData.data?.household) return;
    setSavingsFloorDraft({
      enabled: appearanceData.data.household.savingsFloorEnabled === true,
      amount: appearanceData.data.household.savingsFloor ?? "0.00",
    });
  }, [appearanceData.data?.household]);

  const hasSavingsFloorChanges = useMemo(() => {
    const h = appearanceData.data?.household;
    if (!h) return false;
    const normalized = (normalizeMoneyInput(savingsFloorDraft.amount) ?? savingsFloorDraft.amount) || "0.00";
    return h.savingsFloorEnabled !== savingsFloorDraft.enabled || h.savingsFloor !== normalized;
  }, [appearanceData.data?.household, savingsFloorDraft]);

  async function handleSaveSavingsFloor() {
    const normalizedFloor = normalizeMoneyInput(savingsFloorDraft.amount) ?? "0.00";
    setIsSavingFloor(true);
    setSavingsFloorError(null);
    setSavingsFloorMessage(null);
    try {
      await updateHouseholdSettings({ savingsFloorEnabled: savingsFloorDraft.enabled, savingsFloor: normalizedFloor });
      setSavingsFloorMessage("Savings floor updated.");
      await appearanceData.reload();
    } catch (error) {
      setSavingsFloorError(error instanceof Error ? error.message : "Savings floor could not be updated.");
    } finally {
      setIsSavingFloor(false);
    }
  }

  function handleResetSavingsFloor() {
    const h = appearanceData.data?.household;
    if (!h) return;
    setSavingsFloorDraft({ enabled: h.savingsFloorEnabled === true, amount: h.savingsFloor });
    setSavingsFloorError(null);
    setSavingsFloorMessage(null);
  }

  // ---- Import Rules ----
  const [ruleMessage, setRuleMessage] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [openRuleMenuId, setOpenRuleMenuId] = useState<string | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, ReturnType<typeof buildImportRuleDraft>>>({});
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);

  function getRuleDraft(rule: ImportReviewRule) { return ruleDrafts[rule.id] ?? buildImportRuleDraft(rule); }
  function updateRuleDraft(rule: ImportReviewRule, patch: Partial<ReturnType<typeof buildImportRuleDraft>>) {
    setRuleDrafts((c) => ({ ...c, [rule.id]: { ...(c[rule.id] ?? buildImportRuleDraft(rule)), ...patch } }));
  }

  async function handleSaveRule(rule: ImportReviewRule) {
    setPendingRuleId(rule.id); setRuleError(null); setRuleMessage(null); setOpenRuleMenuId(null);
    try {
      await updateImportReviewRule(rule.id, mapRuleDraftToPayload(getRuleDraft(rule)));
      setEditingRuleId(null); setRuleMessage("Import rule updated.");
      await appearanceData.reload();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Import rule update failed.");
    } finally { setPendingRuleId(null); }
  }

  async function handleDeleteRule(ruleId: string) {
    setPendingRuleId(ruleId); setRuleError(null); setRuleMessage(null); setOpenRuleMenuId(null);
    try {
      await deleteImportReviewRule(ruleId);
      setEditingRuleId((c) => c === ruleId ? null : c);
      setRuleMessage("Import rule deleted.");
      await appearanceData.reload();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Import rule delete failed.");
    } finally { setPendingRuleId(null); }
  }

  async function handleRuleModeChange(rule: ImportReviewRule, nextMode: "suggestion" | "reusable_rule", autoApply: boolean) {
    setPendingRuleId(rule.id); setRuleError(null); setRuleMessage(null); setOpenRuleMenuId(null);
    try {
      await updateImportReviewRule(rule.id, { rule_type: nextMode, auto_apply: nextMode === "reusable_rule" ? autoApply : false });
      setRuleMessage(nextMode === "suggestion" ? "Rule converted to suggestion only." : "Reusable rule updated.");
      await appearanceData.reload();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Rule update failed.");
    } finally { setPendingRuleId(null); }
  }

  // ---- Profile ----
  const { activeRange } = usePeriod();
  const profileData = useAsyncData<ProfileViewModel>(async () => {
    const currentYear = new Date().getFullYear();
    const [categories, goalsResponse, monthlyReviewsResponse, dashboard] = await Promise.all([
      getAllocationCategories().catch((err) => {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }),
      getGoals(),
      getMonthlyReviews({ from: `${currentYear}-01-01`, to: `${currentYear}-12-01` }),
      getDashboardReport({ from: activeRange.from, to: activeRange.to }),
    ]);
    return {
      categories,
      allocationCount: categories.length,
      activeAllocationCount: categories.filter((c) => c.isActive !== false).length,
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
    if (!profileData.data) return;
    const { state } = syncGoalAchievements(profileData.data.goalProgress, readGoalAchievements());
    writeGoalAchievements(state);
    setGoalAchievementState(state);
  }, [profileData.data]);

  const goalsAchievedCount = profileData.data ? getGoalsAchievedCount(profileData.data.goals, goalAchievementState) : 0;
  const goalAchievementBadges = profileData.data ? getGoalAchievementBadges(profileData.data.goals, goalAchievementState) : [];

  const completedGoals = useMemo<CompletedGoalSummary[]>(() => {
    if (!profileData.data) return [];
    const catLookup = new Map(profileData.data.categories.map((c) => [c.id, c.label]));
    const progressLookup = new Map(profileData.data.goalProgress.map((p) => [p.goal_id, p]));
    const earliestCompletedId = Object.entries(goalAchievementState)
      .sort((a, b) => a[1].completed_at.localeCompare(b[1].completed_at))[0]?.[0];

    return Object.entries(goalAchievementState)
      .filter(([goalId]) => profileData.data!.goals.some((g) => g.id === goalId))
      .map(([goalId, achievement]) => {
        const goal = profileData.data!.goals.find((g) => g.id === goalId);
        const progress = progressLookup.get(goalId);
        if (!goal || !progress || progress.progress_percent < 100) return null;
        const badges: Array<{ label: string; tone: "success" | "neutral" }> = goalId === earliestCompletedId
          ? [{ label: "First Goal Completed", tone: "success" }]
          : [{ label: "Target Reached", tone: "success" }];
        return {
          goal, progress,
          completedAt: achievement.completed_at,
          categoryLabel: resolveGoalCategoryLabel(goal, progress, catLookup),
          milestonesCompleted: countCompletedGoalMilestones(progress),
          badges,
        };
      })
      .filter((item): item is CompletedGoalSummary => item !== null)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }, [profileData.data, goalAchievementState]);

  const completedMilestonesCount = completedGoals.reduce((t, i) => t + i.milestonesCompleted, 0);
  const visibleCompletedGoals = showAllAchievements ? completedGoals : completedGoals.slice(0, VISIBLE_ACHIEVEMENTS_LIMIT);
  const selectedAchievement = completedGoals.find((i) => i.goal.id === selectedAchievementGoalId) ?? null;

  // ---- Household ----
  const { session } = useAuth();
  const workspaceId = session?.workspaceId ?? session?.householdId ?? "";
  const canManage = usePermission("members:manage");
  const [showInvite, setShowInvite] = useState(false);
  const [householdTab, setHouseholdTab] = useState<"members" | "activity">("members");

  const membersData = useAsyncData(() => listMembers(workspaceId), [workspaceId]);
  const invitationsData = useAsyncData(() => listPendingInvitations(workspaceId), [workspaceId]);
  const activityData = useAsyncData(() => listWorkspaceActivity(workspaceId, { limit: 50 }), [workspaceId]);

  const memberList = membersData.data ?? [];
  const pendingList = invitationsData.data ?? [];
  const activityList = activityData.data ?? [];
  const isPersonalWorkspace = session?.workspaces?.find((w) => w.id === workspaceId)?.type === "personal";

  function handleHouseholdUpdated() {
    void membersData.reload();
    void invitationsData.reload();
    void activityData.reload();
  }

  function handleInviteSent() {
    setShowInvite(false);
    void invitationsData.reload();
    void activityData.reload();
  }

  // ---------------------------------------------------------------------------
  // Tab navigation data
  // ---------------------------------------------------------------------------

  const settingsTabs: Array<{ id: SettingsTab; label: string; description: string }> = [
    { id: "profile", label: "Profile", description: "Account summary and goal achievements." },
    { id: "household", label: "Household", description: "Stewards, invitations, and activity." },
    { id: "appearance", label: "Appearance", description: "Theme, typography, and scale for this device." },
    { id: "financial", label: "Financial", description: "Savings floor warning threshold." },
    { id: "import_rules", label: "Import Rules", description: "Suggestions, reusable rules, and auto-apply controls." },
  ];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <PageShell
      eyebrow="Settings"
      title="Settings"
      description="Profile, household, appearance, and import configuration."
    >
      <section className="grid gap-7 xl:grid-cols-[minmax(180px,20%),minmax(0,1fr)]">
        {/* Left nav */}
        <aside className="xl:sticky xl:top-6 xl:self-start">
          <Card title="Settings" subtitle="Choose what you want to adjust.">
            <div className="space-y-2">
              {settingsTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition duration-200 ${selectedCardClasses(activeTab === tab.id)}`}
                  onClick={() => setTab(tab.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--text-strong)]">{tab.label}</div>
                      <div className="mt-1 text-[12px] italic leading-5 text-[var(--text-muted)]">{tab.description}</div>
                    </div>
                    {activeTab === tab.id ? <Badge tone="success">Active</Badge> : null}
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </aside>

        {/* Tab content */}
        <div className="min-w-0 space-y-6">

          {/* ---- Profile tab ---- */}
          {activeTab === "profile" ? (
            <>
              {profileData.isLoading ? <LoadingState label="Loading profile..." /> : null}
              {!profileData.isLoading && profileData.error ? (
                <ErrorState title="Failed to load profile" message={profileData.error} onRetry={() => void profileData.reload()} />
              ) : null}
              {!profileData.isLoading && !profileData.error && profileData.data ? (
                <div className="space-y-4">
                  <Card title="User Information" subtitle="Account details and household context.">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold text-[var(--text-strong)]">Jane Doe</h2>
                        <p className="mt-1 text-sm text-[var(--text-muted)]">Local RAF profile placeholder</p>
                      </div>
                      <Badge tone="neutral">Profile placeholder</Badge>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Household</p>
                        <p className="mt-2 text-sm font-medium text-[var(--text-strong)]">Local RAF Household</p>
                        <p className="mt-1 text-sm text-[var(--text-muted)]">Household and account details will appear here when available.</p>
                      </div>
                      <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Account</p>
                        <p className="mt-2 text-sm font-medium text-[var(--text-strong)]">Google-auth account placeholder</p>
                        <p className="mt-1 text-sm text-[var(--text-muted)]">Connected user details are not available yet.</p>
                      </div>
                    </div>
                  </Card>

                  <div className="grid gap-4 md:grid-cols-3">
                    <Card title="Monthly Reviews" subtitle="Planning summary.">
                      <p className="text-2xl font-bold tracking-tight text-[var(--text-strong)]">{profileData.data.monthlyReviewCount}</p>
                      <p className="mt-2 text-sm text-[var(--text-muted)]">Saved monthly reviews this year</p>
                    </Card>
                    <Card title="Categories" subtitle="Allocation setup.">
                      <p className="text-2xl font-bold tracking-tight text-[var(--text-strong)]">{profileData.data.activeAllocationCount}</p>
                      <p className="mt-2 text-sm text-[var(--text-muted)]">{profileData.data.allocationCount} total categories configured</p>
                    </Card>
                    <Card title="Goals" subtitle="Goal planning.">
                      <p className="text-2xl font-bold tracking-tight text-[var(--text-strong)]">{profileData.data.goalCount}</p>
                      <p className="mt-2 text-sm text-[var(--text-muted)]">Active and planned goals tracked</p>
                    </Card>
                  </div>

                  <Card
                    title="Goals Achieved"
                    subtitle="Completed goal milestones and unlocked achievements."
                    actions={completedGoals.length > VISIBLE_ACHIEVEMENTS_LIMIT ? (
                      <Button type="button" variant="ghost" onClick={() => setShowAllAchievements((c) => !c)}>
                        {showAllAchievements ? "Show recent only" : "View all achievements →"}
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
                      <EmptyState title="No goals achieved yet" message="Complete a savings goal to unlock your first achievement." />
                    )}
                  </Card>
                </div>
              ) : null}
              {!profileData.isLoading && !profileData.error && !profileData.data ? (
                <EmptyState title="No profile data yet" message="Profile details will appear here as more account data becomes available." />
              ) : null}

              {selectedAchievement ? (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
                  <div className="w-full max-w-2xl rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-xl" style={{ background: "var(--surface-color)" }}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-lg font-semibold text-[var(--text-strong)]">{selectedAchievement.goal.name}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge tone="neutral">{selectedAchievement.categoryLabel}</Badge>
                          <Badge tone="success">Target Reached</Badge>
                          {selectedAchievement.goal.active === false ? <Badge tone="neutral">Archived</Badge> : null}
                        </div>
                      </div>
                      <Button type="button" variant="ghost" className="min-h-9 min-w-9 rounded-full px-0 text-[var(--text-muted)]" aria-label="Close" onClick={() => setSelectedAchievementGoalId(null)}>X</Button>
                    </div>
                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                      <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Target amount</div>
                        <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]"><Money value={selectedAchievement.goal.target_amount} /></div>
                      </div>
                      <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Progress achieved</div>
                        <div className="mt-2 text-lg font-semibold text-[var(--text-strong)]">
                          <Money value={selectedAchievement.progress.current_amount} /> / <Money value={selectedAchievement.goal.target_amount} />
                        </div>
                      </div>
                      <div className="rounded-2xl border border-[var(--border-color)] p-4" style={{ background: "var(--surface-plain)" }}>
                        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">Milestone breakdown</div>
                        <div className="mt-2 space-y-2">
                          {getGoalMilestones(selectedAchievement.progress).map((milestone) => (
                            <div key={milestone.id} className="flex items-center justify-between gap-3 text-sm">
                              <span className={milestone.completed ? "text-[var(--text-strong)]" : "text-[var(--text-muted)]"}>{milestone.label}</span>
                              <span className={milestone.completed ? "text-emerald-600" : "text-[var(--text-muted)]"}>{milestone.completed ? "✓" : "○"}</span>
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
            </>
          ) : null}

          {/* ---- Household tab ---- */}
          {activeTab === "household" ? (
            <div className="space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-[17px] font-semibold text-[var(--text-strong)]">
                    {session?.workspaceName ?? session?.householdName ?? "Your household"}
                  </h2>
                  {memberList.length > 0 ? (
                    <p className="mt-1 text-sm text-[var(--text-muted)]">{memberList.length} steward{memberList.length === 1 ? "" : "s"}</p>
                  ) : null}
                </div>
                {canManage && !isPersonalWorkspace ? (
                  <button type="button" className="ui-button-primary" onClick={() => setShowInvite(true)}>Invite someone</button>
                ) : null}
              </div>

              <div className="flex gap-1 border-b border-[var(--border-subtle)]">
                {(["members", "activity"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setHouseholdTab(tab)}
                    className={`px-4 py-2 text-[13px] font-semibold capitalize transition-colors ${
                      householdTab === tab
                        ? "border-b-2 border-[var(--brand-primary)] text-[var(--brand-primary)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {householdTab === "members" ? (
                <div className="space-y-3">
                  {membersData.isLoading ? (
                    <div className="space-y-2">
                      {[1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-[var(--surface-raised)]" />)}
                    </div>
                  ) : (
                    memberList.map((m) => (
                      <MemberRow
                        key={m.userId}
                        member={m}
                        workspaceId={workspaceId}
                        isCurrentUser={m.userId === session?.userId}
                        isPersonalWorkspace={isPersonalWorkspace ?? false}
                        onUpdated={handleHouseholdUpdated}
                      />
                    ))
                  )}
                  {pendingList.length > 0 ? (
                    <div className="pt-2">
                      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-secondary)]">Pending invitations</h3>
                      <div className="space-y-2">
                        {pendingList.map((inv) => (
                          <PendingInvitationRow
                            key={inv.id}
                            invitation={inv}
                            canManage={canManage}
                            onRevoked={() => void invitationsData.reload()}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {membersData.error ? <p className="text-[13px] text-[var(--text-danger,#ef4444)]">{membersData.error}</p> : null}
                </div>
              ) : (
                <ActivityFeed entries={activityList} isLoading={activityData.isLoading} />
              )}

              {showInvite ? (
                <InviteModal workspaceId={workspaceId} onSent={handleInviteSent} onClose={() => setShowInvite(false)} />
              ) : null}
            </div>
          ) : null}

          {/* ---- Appearance tab ---- */}
          {activeTab === "appearance" ? (
            <div className="space-y-6">
              {saveMessage ? <SuccessNotice title="Appearance updated" message={saveMessage} /> : null}

              <Card title="Theme">
                <div className="space-y-6">
                  <div className="border-b border-[var(--border-color)] pb-6">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Theme</div>
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">
                      Choose a mood that fits how you want RAF to feel while you review income, allocations, and transactions.
                    </p>
                  </div>
                  <div className="grid gap-5 lg:grid-cols-2">
                    {themeGroups.map((group, index) => (
                      <div key={group.mood} className={`flex h-full flex-col space-y-3 ${index === 0 ? "lg:col-span-2" : ""}`}>
                        <div>
                          <div className="text-sm font-semibold text-[var(--text-strong)]">{group.mood}</div>
                          <p className="mt-1 text-[12px] italic text-[var(--text-muted)]">{group.helper}</p>
                        </div>
                        <div className={`grid flex-1 gap-3 ${group.values.length > 1 ? "md:grid-cols-2" : ""}`}>
                          {group.values.map((themeValue) => {
                            const option = THEME_OPTIONS.find((item) => item.value === themeValue);
                            if (!option) return null;
                            const selected = draft.theme_color === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className={`relative h-full min-h-[108px] overflow-hidden rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                                style={selectedCardStyle(selected)}
                                onClick={() => updateDraft({ theme_color: option.value })}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-start gap-4">
                                    <span className="h-12 w-12 shrink-0 rounded-2xl border border-white/80 shadow-sm" style={{ background: `linear-gradient(145deg, ${option.swatch}, ${option.accent})` }} />
                                    <div>
                                      <div className="text-base font-semibold text-[var(--text-strong)]">{option.label}</div>
                                      <div className="mt-1 text-[13px] italic text-[var(--text-muted)]">{group.mood} theme</div>
                                    </div>
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card title="Font Family">
                <div className="space-y-5">
                  <div className="border-b border-[var(--border-color)] pb-6">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Font family</div>
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">Pick the reading voice you want across RAF.</p>
                  </div>
                  <div className="grid gap-3">
                    {FONT_OPTIONS.map((option) => {
                      const selected = draft.font_family === option.value;
                      return (
                        <button key={option.value} type="button" className={`rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`} style={{ background: selected ? undefined : "var(--surface-plain)" }} onClick={() => updateDraft({ font_family: option.value })}>
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="text-lg font-semibold text-[var(--text-strong)]" style={{ fontFamily: `var(--font-${option.value})` }}>{option.label}</div>
                              <p className="mt-1 text-[13px] italic leading-6 text-[var(--text-muted)]">{option.preview}</p>
                            </div>
                            {selected ? <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary-color)] text-[var(--primary-contrast)] shadow-sm"><svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 10 3 3 7-7" /></svg></span> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Card>

              <Card title="Interface Scale">
                <div className="space-y-5">
                  <div className="border-b border-[var(--border-color)] pb-6">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Scale</div>
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">Adjust how compact or spacious the interface feels.</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {INTERFACE_SCALE_OPTIONS.map((option) => {
                      const selected = draft.interface_scale === option.value;
                      const sizeClass = option.value === "small" ? "text-base" : option.value === "medium" ? "text-lg" : "text-xl";
                      return (
                        <button key={option.value} type="button" className={`rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`} style={{ background: selected ? undefined : "var(--surface-plain)" }} onClick={() => updateDraft({ interface_scale: option.value })}>
                          <div className="flex items-center justify-between gap-3">
                            <div className={`${sizeClass} font-semibold text-[var(--text-strong)]`}>{option.label}</div>
                            {selected ? <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary-color)] text-[var(--primary-contrast)] shadow-sm"><svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 10 3 3 7-7" /></svg></span> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="border-t border-[var(--border-color)] pt-6">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Mode</div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {APPEARANCE_MODE_OPTIONS.map((option) => {
                        const selected = draft.appearance_mode === option.value;
                        return (
                          <button key={option.value} type="button" className={`rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`} style={{ background: selected ? undefined : "var(--surface-plain)" }} onClick={() => updateDraft({ appearance_mode: option.value })}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-base font-semibold text-[var(--text-strong)]">{option.label}</div>
                              {selected ? <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary-color)] text-[var(--primary-contrast)] shadow-sm"><svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 10 3 3 7-7" /></svg></span> : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </Card>

              <Card title="Privacy Mode">
                <div className="space-y-5">
                  <div className="border-b border-[var(--border-color)] pb-5">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Privacy Mode</div>
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">
                      Hide all financial amounts when sharing your screen. No data changes — amounts are masked on this device only.
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-[var(--border-color)] px-4 py-4" style={{ background: "var(--surface-plain)" }}>
                    <label className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-[var(--text-strong)]">Hide financial amounts</div>
                        <div className="mt-1 text-[12px] italic text-[var(--text-muted)]">Masks all dollar values shown in RAF. Stored locally — not synced to other devices.</div>
                      </div>
                      <input type="checkbox" className="mt-1 h-4 w-4 rounded border-[var(--border-color)] text-[var(--primary-color)]" checked={preferences.privacy_mode} aria-label="Hide financial amounts" onChange={togglePrivacyMode} />
                    </label>
                  </div>
                </div>
              </Card>

              <Card title="Apply Appearance Changes">
                <div className="space-y-4">
                  <p className="text-[13px] leading-6 text-[var(--text-muted)]">Saving will update your appearance across RAF. Cancel keeps your current look. Restoring defaults resets everything to the RAF preset.</p>
                  <div className="flex flex-col gap-3">
                    <Button type="button" className="w-full" disabled={!hasChanges} onClick={handleSave}>Save Appearance</Button>
                    <Button type="button" variant="secondary" className="w-full" disabled={!hasChanges} onClick={handleCancel}>Cancel</Button>
                  </div>
                  <div className="pt-1">
                    <button type="button" className="text-sm font-medium text-rose-700 transition hover:text-rose-800" onClick={handleRestoreDefaults}>Restore defaults</button>
                  </div>
                </div>
              </Card>

              {/* Live Preview (inline for appearance tab) */}
              <Card title="Live Preview">
                <div className="space-y-4 rounded-[1.75rem] border border-[var(--border-color)] bg-[var(--surface-elevated)] p-5" data-theme={draft.theme_color} data-font={draft.font_family} data-mode={draft.appearance_mode} data-scale={draft.interface_scale}>
                  <div className="space-y-3 border-b border-[var(--border-color)] pb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{`Theme: ${activeTheme.label}`}</Badge>
                      <Badge tone="neutral">{`Font: ${activeFont.label}`}</Badge>
                      <Badge tone="neutral">{`Size: ${activeScale.label}`}</Badge>
                      <Badge tone="neutral">{`Mode: ${activeMode.label}`}</Badge>
                    </div>
                    <div>
                      <div className="text-[18px] font-semibold text-[var(--text-strong)]">Live Preview</div>
                      <p className="mt-1 text-[13px] italic leading-5 text-[var(--text-muted)]">This preview mirrors the kinds of cards, balances, and transaction rows you see across RAF.</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="rounded-[1.5rem] border border-[var(--border-color)] bg-[var(--surface-color)] p-4 shadow-panel">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[12px] font-medium text-[var(--text-muted)]">Accent action</div>
                          <div className="mt-1 text-sm font-semibold text-[var(--text-strong)]">Record deposit</div>
                        </div>
                        <button type="button" className="inline-flex rounded-full bg-[var(--primary-color)] px-3.5 py-2 text-sm font-semibold text-[var(--primary-contrast)] shadow-sm">Record deposit</button>
                      </div>
                    </div>
                    <div className="rounded-[1.5rem] border border-[var(--border-color)] bg-[var(--surface-color)] p-4 shadow-panel">
                      <div className="text-[12px] font-medium text-[var(--text-muted)]">Financial data surface</div>
                      <div className="mt-3 flex items-end justify-between gap-4">
                        <div>
                          <div className="text-sm text-[var(--text-muted)]">Buffer balance</div>
                          <div className="mt-1.5 text-[1.75rem] font-semibold tracking-tight text-[var(--text-strong)]">$2,930.28</div>
                        </div>
                        <Badge tone="success">Healthy</Badge>
                      </div>
                    </div>
                    <div className="rounded-[1.5rem] border border-[var(--border-color)] bg-[var(--surface-color)] p-4 shadow-panel">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-[var(--text-muted)]">Transaction example</div>
                          <div className="mt-2.5 space-y-0.5">
                            <div className="text-xs text-[var(--text-muted)]">Mar 7</div>
                            <div className="text-sm font-semibold text-[var(--text-strong)]">Gas Station</div>
                            <div className="text-xs text-[var(--text-muted)]">Personal Spending</div>
                          </div>
                        </div>
                        <div className="text-right"><div className="text-base font-semibold text-[var(--text-strong)]">-$45.00</div></div>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          ) : null}

          {/* ---- Financial tab ---- */}
          {activeTab === "financial" ? (
            <Card title="Savings Floor">
              <div className="space-y-5">
                <div className="border-b border-[var(--border-color)] pb-5">
                  <div className="text-[17px] font-semibold text-[var(--text-strong)]">Savings Floor</div>
                  <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">Get warned before savings drops below this amount.</p>
                </div>
                {savingsFloorMessage ? <SuccessNotice title="Savings floor updated" message={savingsFloorMessage} /> : null}
                {savingsFloorError ? <ErrorState title="Savings floor update failed" message={savingsFloorError} /> : null}
                <div className="rounded-[1.5rem] border border-[var(--border-color)] px-4 py-4" style={{ background: "var(--surface-plain)" }}>
                  <label className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-[var(--text-strong)]">Enable savings floor alerts</div>
                      <div className="mt-1 text-[12px] italic text-[var(--text-muted)]">This is a user preference for planning, not a required setup step.</div>
                    </div>
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-[var(--border-color)] text-[var(--primary-color)]"
                      checked={savingsFloorDraft.enabled}
                      onChange={(e) => { setSavingsFloorDraft((c) => ({ ...c, enabled: e.target.checked })); setSavingsFloorError(null); setSavingsFloorMessage(null); }}
                    />
                  </label>
                </div>
                <MoneyInput
                  label="Floor amount"
                  name="savingsFloor"
                  value={savingsFloorDraft.amount}
                  onChange={(value) => { setSavingsFloorDraft((c) => ({ ...c, amount: value })); setSavingsFloorError(null); setSavingsFloorMessage(null); }}
                  placeholder="500.00"
                />
                <div className="flex flex-wrap gap-3">
                  <Button type="button" onClick={() => void handleSaveSavingsFloor()} disabled={isSavingFloor || !hasSavingsFloorChanges}>
                    {isSavingFloor ? "Saving floor..." : "Save Savings Floor"}
                  </Button>
                  <Button type="button" variant="secondary" onClick={handleResetSavingsFloor} disabled={isSavingFloor || !hasSavingsFloorChanges}>Cancel</Button>
                </div>
              </div>
            </Card>
          ) : null}

          {/* ---- Import Rules tab ---- */}
          {activeTab === "import_rules" ? (
            <>
              {appearanceData.isLoading ? <LoadingState label="Loading import rules..." /> : null}
              {!appearanceData.isLoading && appearanceData.error ? <ErrorState title="Failed to load import rules" message={appearanceData.error} onRetry={() => void appearanceData.reload()} /> : null}
              {ruleError ? <ErrorState title="Rule action failed" message={ruleError} /> : null}
              {ruleMessage ? <SuccessNotice title="Import rules updated" message={ruleMessage} /> : null}
              {!appearanceData.isLoading && !appearanceData.error && appearanceData.data ? (
                <Card title="Import Rules" subtitle="Suggestions stay review-only. Reusable rules can have auto-apply enabled or disabled at any time.">
                  {appearanceData.data.rules.length ? (
                    <div className="space-y-2">
                      {appearanceData.data.rules.map((rule) => {
                        const isPending = pendingRuleId === rule.id;
                        const categoryLabel = rule.category_id
                          ? (appearanceData.data!.categories.find((c) => c.id === rule.category_id)?.label ?? rule.category_id)
                          : null;
                        return (
                          <div key={rule.id} className="group relative rounded-xl border border-[var(--border-color)] bg-[var(--surface-color)] px-4 py-3 transition duration-150 hover:bg-[color:color-mix(in_srgb,var(--surface-plain)_82%,var(--surface-color))]">
                            <div className="space-y-3">
                              <div className="min-w-0 space-y-1">
                                <div className="truncate text-sm font-semibold leading-5 text-[var(--text-strong)]">
                                  {rule.match_type === "contains" ? `Description contains "${rule.match_value}"` : `Description equals "${rule.match_value}"`}
                                </div>
                                <div className="truncate text-[13px] leading-5 text-[var(--text-muted)]">
                                  {ruleActionLabel(rule)}{categoryLabel ? ` - ${categoryLabel}` : ""}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge tone={rule.rule_type === "reusable_rule" ? "neutral" : "warning"} className="h-6 whitespace-nowrap px-2.5 text-[11px]">
                                    {rule.rule_type === "reusable_rule" ? "Reusable" : "Suggestion Only"}
                                  </Badge>
                                  {rule.rule_type === "reusable_rule" ? (
                                    <Badge tone={rule.auto_apply ? "success" : "neutral"} className="h-6 whitespace-nowrap px-2.5 text-[11px]">
                                      {rule.auto_apply ? "Auto-Apply ON" : "Auto-Apply OFF"}
                                    </Badge>
                                  ) : null}
                                </div>
                                <div className="flex items-center gap-2.5">
                                  <button type="button" className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-muted)] transition hover:text-[var(--text-strong)]" onClick={() => { setOpenRuleMenuId(null); setEditingRuleId(rule.id); }}>Edit</button>
                                  <button type="button" className="inline-flex h-8 items-center justify-center rounded-full border border-[var(--border-color)] px-3 text-[12px] font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]" onClick={() => setOpenRuleMenuId((c) => c === rule.id ? null : rule.id)}>More</button>
                                </div>
                              </div>
                            </div>
                            {openRuleMenuId === rule.id ? (
                              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-color)] pt-3">
                                {rule.rule_type === "reusable_rule" && rule.auto_apply ? (
                                  <button type="button" className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-strong)] transition" disabled={isPending} onClick={() => void handleRuleModeChange(rule, "reusable_rule", false)}>Disable Auto-Apply</button>
                                ) : null}
                                {rule.rule_type === "reusable_rule" && !rule.auto_apply ? (
                                  <button type="button" className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-muted)] transition hover:text-[var(--text-strong)]" disabled={isPending} onClick={() => void handleRuleModeChange(rule, "reusable_rule", true)}>Enable Auto-Apply</button>
                                ) : null}
                                {rule.rule_type !== "suggestion" ? (
                                  <button type="button" className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-muted)] transition hover:text-[var(--text-strong)]" disabled={isPending} onClick={() => void handleRuleModeChange(rule, "suggestion", false)}>Convert to Suggestion</button>
                                ) : null}
                                <button type="button" className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[color:color-mix(in_srgb,#c2410c_78%,var(--text-muted))] transition hover:text-[#ef4444]" disabled={isPending} onClick={() => void handleDeleteRule(rule.id)}>Delete</button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState title="No import rules saved" message="Use transaction review to save suggestions or reusable rules, then manage them here." />
                  )}
                </Card>
              ) : null}
              {!appearanceData.isLoading && !appearanceData.error && appearanceData.data && editingRuleId ? (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
                  <div className="w-full max-w-3xl rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-[0_28px_70px_rgba(15,23,42,0.28)]" style={{ background: "var(--surface-color)" }}>
                    <div className="mb-4 flex items-start justify-between gap-4 border-b border-[var(--border-color)] pb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-[var(--text-strong)]">Edit Rule</h3>
                        <p className="mt-1 text-sm text-[var(--text-muted)]">Update the match condition, rule outcome, and auto-apply behavior without leaving Settings.</p>
                      </div>
                      <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-color)] text-base text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]" onClick={() => setEditingRuleId(null)}>X</button>
                    </div>
                    {(() => {
                      const rule = appearanceData.data!.rules.find((r) => r.id === editingRuleId);
                      if (!rule) return null;
                      return (
                        <ImportRuleEditor
                          categories={appearanceData.data!.categories}
                          debts={appearanceData.data!.debts}
                          fixedBills={appearanceData.data!.fixedBills}
                          goals={appearanceData.data!.goals}
                          draft={getRuleDraft(rule)}
                          isSaving={pendingRuleId === rule.id}
                          saveLabel="Save rule"
                          onChange={(patch) => updateRuleDraft(rule, patch)}
                          onCancel={() => setEditingRuleId(null)}
                          onSave={() => void handleSaveRule(rule)}
                        />
                      );
                    })()}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

        </div>
      </section>
    </PageShell>
  );
}
