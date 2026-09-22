import { useEffect, useMemo, useState } from "react";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { getDebts } from "../api/debtsApi";
import { getFixedBills } from "../api/fixedBillsApi";
import { getHouseholdSettings, updateHouseholdSettings } from "../api/householdApi";
import {
  deleteImportReviewRule,
  getImportReviewRules,
  updateImportReviewRule,
} from "../api/importsApi";
import { getGoals } from "../api/goalsApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import {
  buildImportRuleDraft,
  ImportRuleEditor,
  mapRuleDraftToPayload,
} from "../components/imports/ImportRuleEditor";
import { useAppearance } from "../components/layout/AppearanceProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { MoneyInput } from "../components/ui/MoneyInput";
import { useAsyncData } from "../hooks/useAsyncData";
import {
  APPEARANCE_MODE_OPTIONS,
  DEFAULT_APPEARANCE,
  FONT_OPTIONS,
  INTERFACE_SCALE_OPTIONS,
  THEME_OPTIONS,
} from "../lib/appearance";
import type { AppearancePreferences, ThemeColor } from "../lib/appearance";
import type {
  AllocationCategory,
  Debt,
  FixedBill,
  Goal,
  HouseholdSettings,
  ImportReviewRule,
} from "../lib/types";
import { normalizeMoneyInput } from "../lib/validation";

interface ProfileSettingsViewModel {
  categories: AllocationCategory[];
  debts: Debt[];
  fixedBills: FixedBill[];
  goals: Goal[];
  household: HouseholdSettings;
  rules: ImportReviewRule[];
}

export type SettingsContentTab = "preferences" | "savings_floor" | "import_rules";

const themeGroups: Array<{
  mood: string;
  values: ThemeColor[];
  helper: string;
}> = [
  { mood: "Professional", values: ["minimal", "violet"], helper: "Calm contrast for focused daily finance work." },
  { mood: "Balanced", values: ["emerald"], helper: "NOMI's default look with steady contrast and warmth." },
  { mood: "Expressive", values: ["blush"], helper: "A softer accent with a little more personality." },
];

function ruleActionLabel(rule: ImportReviewRule) {
  if (rule.classification_type === "income") return "Add to income deposit";
  if (rule.classification_type === "transaction") return "Approve as transaction";
  if (rule.classification_type === "debt_payment") return "Link to debt payment";
  if (rule.classification_type === "fixed_bill_payment") return "Link to fixed bill";
  if (rule.classification_type === "goal_funding") return "Internal transfer to savings goal";
  if (rule.classification_type === "duplicate") return "Mark duplicate";
  if (rule.classification_type === "transfer") return "Mark transfer";
  return "Ignore";
}

function selectedCardClasses(selected: boolean) {
  return selected
    ? "border-[var(--theme-primary)] shadow-panel"
    : "border-[var(--border-subtle)] hover:-translate-y-0.5 hover:shadow-lift";
}

function selectedCardStyle(selected: boolean) {
  return selected
    ? {
      background: "var(--surface-card)",
      boxShadow: "inset 0 0 0 1px var(--theme-primary), var(--shadow-panel)",
    }
    : {
      background: "var(--surface-card)",
    };
}

export function AppearanceSettings({ tab }: { tab: SettingsContentTab }) {
  const { preferences, saveAppearance, togglePrivacyMode } = useAppearance();
  const [draft, setDraft] = useState<AppearancePreferences>(preferences);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [ruleMessage, setRuleMessage] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [openRuleMenuId, setOpenRuleMenuId] = useState<string | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, ReturnType<typeof buildImportRuleDraft>>>({});
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);
  const [savingsFloorDraft, setSavingsFloorDraft] = useState({ enabled: false, amount: "0.00" });
  const [savingsFloorMessage, setSavingsFloorMessage] = useState<string | null>(null);
  const [savingsFloorError, setSavingsFloorError] = useState<string | null>(null);
  const [isSavingFloor, setIsSavingFloor] = useState(false);

  const rulesData = useAsyncData<ProfileSettingsViewModel>(async () => {
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

  useEffect(() => {
    setDraft(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!rulesData.data?.household) return;
    setSavingsFloorDraft({
      enabled: rulesData.data.household.savingsFloorEnabled === true,
      amount: rulesData.data.household.savingsFloor ?? "0.00",
    });
  }, [rulesData.data?.household]);

  const hasChanges = useMemo(() => (
    draft.theme_color !== preferences.theme_color
    || draft.font_family !== preferences.font_family
    || draft.appearance_mode !== preferences.appearance_mode
    || draft.interface_scale !== preferences.interface_scale
  ), [draft, preferences]);

  function updateDraft(next: Partial<AppearancePreferences>) {
    setDraft((current) => ({ ...current, ...next }));
    setSaveMessage(null);
  }

  function handleSave() {
    saveAppearance(draft);
    setSaveMessage("Appearance settings updated.");
  }

  function handleCancel() {
    setDraft(preferences);
    setSaveMessage(null);
  }

  function handleRestoreDefaults() {
    setDraft(DEFAULT_APPEARANCE);
    setSaveMessage(null);
  }

  const hasSavingsFloorChanges = useMemo(() => {
    const household = rulesData.data?.household;
    if (!household) return false;
    const normalizedDraftAmount = (normalizeMoneyInput(savingsFloorDraft.amount) ?? savingsFloorDraft.amount) || "0.00";
    return household.savingsFloorEnabled !== savingsFloorDraft.enabled
      || household.savingsFloor !== normalizedDraftAmount;
  }, [rulesData.data?.household, savingsFloorDraft]);

  async function handleSaveSavingsFloor() {
    const normalizedFloor = normalizeMoneyInput(savingsFloorDraft.amount) ?? "0.00";
    setIsSavingFloor(true);
    setSavingsFloorError(null);
    setSavingsFloorMessage(null);
    try {
      await updateHouseholdSettings({
        savingsFloorEnabled: savingsFloorDraft.enabled,
        savingsFloor: normalizedFloor,
      });
      setSavingsFloorMessage("Savings floor updated.");
      await rulesData.reload();
    } catch (error) {
      setSavingsFloorError(error instanceof Error ? error.message : "Savings floor could not be updated.");
    } finally {
      setIsSavingFloor(false);
    }
  }

  function handleResetSavingsFloor() {
    const household = rulesData.data?.household;
    if (!household) return;
    setSavingsFloorDraft({
      enabled: household.savingsFloorEnabled === true,
      amount: household.savingsFloor,
    });
    setSavingsFloorError(null);
    setSavingsFloorMessage(null);
  }

  function getRuleDraft(rule: ImportReviewRule) {
    return ruleDrafts[rule.id] ?? buildImportRuleDraft(rule);
  }

  function updateRuleDraft(rule: ImportReviewRule, patch: Partial<ReturnType<typeof buildImportRuleDraft>>) {
    setRuleDrafts((current) => ({
      ...current,
      [rule.id]: { ...(current[rule.id] ?? buildImportRuleDraft(rule)), ...patch },
    }));
  }

  async function handleSaveRule(rule: ImportReviewRule) {
    const currentDraft = getRuleDraft(rule);
    setPendingRuleId(rule.id);
    setRuleError(null);
    setRuleMessage(null);
    setOpenRuleMenuId(null);
    try {
      await updateImportReviewRule(rule.id, mapRuleDraftToPayload(currentDraft));
      setEditingRuleId(null);
      setRuleMessage("Import rule updated.");
      await rulesData.reload();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Import rule update failed.");
    } finally {
      setPendingRuleId(null);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    setPendingRuleId(ruleId);
    setRuleError(null);
    setRuleMessage(null);
    setOpenRuleMenuId(null);
    try {
      await deleteImportReviewRule(ruleId);
      setEditingRuleId((current) => current === ruleId ? null : current);
      setRuleMessage("Import rule deleted.");
      await rulesData.reload();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Import rule delete failed.");
    } finally {
      setPendingRuleId(null);
    }
  }

  async function handleRuleModeChange(rule: ImportReviewRule, nextMode: "suggestion" | "reusable_rule", autoApply: boolean) {
    setPendingRuleId(rule.id);
    setRuleError(null);
    setRuleMessage(null);
    setOpenRuleMenuId(null);
    try {
      await updateImportReviewRule(rule.id, {
        rule_type: nextMode,
        auto_apply: nextMode === "reusable_rule" ? autoApply : false,
      });
      setRuleMessage(nextMode === "suggestion" ? "Rule converted to suggestion only." : "Reusable rule updated.");
      await rulesData.reload();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Rule update failed.");
    } finally {
      setPendingRuleId(null);
    }
  }

  if (tab === "preferences") {
    return (
      <div className="space-y-5">
        {saveMessage ? <SuccessNotice title="Appearance updated" message={saveMessage} /> : null}

        <Card
          title="Theme"
          subtitle="Choose a mood that fits how you want NOMI to feel while you review income, allocations, and transactions."
        >
          <div className="grid gap-5 lg:grid-cols-2">
            {themeGroups.map((group, index) => (
              <div
                key={group.mood}
                className={`flex h-full flex-col space-y-3 ${index === 0 ? "lg:col-span-2" : ""}`}
              >
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-secondary)]">{group.mood}</div>
                  <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{group.helper}</p>
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
                        className={`relative h-full min-h-[88px] overflow-hidden rounded-2xl border p-4 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                        style={selectedCardStyle(selected)}
                        onClick={() => updateDraft({ theme_color: option.value })}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="h-10 w-10 shrink-0 rounded-xl border border-white/80 shadow-sm"
                            style={{ background: `linear-gradient(145deg, ${option.swatch}, ${option.accent})` }}
                          />
                          <div>
                            <div className="text-[14px] font-semibold text-[var(--text-primary)]">{option.label}</div>
                            <div className="text-[12px] text-[var(--text-secondary)]">{group.mood}</div>
                          </div>
                          {selected ? (
                            <span className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--theme-primary)] text-white shadow-sm">
                              <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m5 10 3 3 7-7" />
                              </svg>
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Font"
          subtitle="Pick the reading voice you want across NOMI. The preview updates instantly so dense financial data stays easy to judge."
        >
          <div className="grid gap-2">
            {FONT_OPTIONS.map((option) => {
              const selected = draft.font_family === option.value;

              return (
                <button
                  key={option.value}
                  type="button"
                  className={`rounded-xl border p-4 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                  style={{ background: "var(--surface-card)" }}
                  onClick={() => updateDraft({ font_family: option.value })}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div
                        className="text-[15px] font-semibold text-[var(--text-primary)]"
                        style={{ fontFamily: `var(--font-${option.value})` }}
                      >
                        {option.label}
                      </div>
                      <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{option.preview}</p>
                    </div>
                    {selected ? (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--theme-primary)] text-white shadow-sm">
                        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m5 10 3 3 7-7" />
                        </svg>
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <Card title="Display" subtitle="Adjust scale and color mode without changing the structure of the application.">
          <div className="space-y-5">
            <div>
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-secondary)]">Scale</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {INTERFACE_SCALE_OPTIONS.map((option) => {
                  const selected = draft.interface_scale === option.value;
                  const sizeClass = option.value === "small" ? "text-[13px]" : option.value === "medium" ? "text-[15px]" : "text-[18px]";

                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`rounded-xl border p-4 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                      style={{ background: "var(--surface-card)" }}
                      onClick={() => updateDraft({ interface_scale: option.value })}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className={`${sizeClass} font-semibold text-[var(--text-primary)]`}>{option.label}</div>
                        {selected ? (
                          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--theme-primary)] text-white shadow-sm">
                            <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m5 10 3 3 7-7" />
                            </svg>
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-[var(--border-subtle)] pt-5">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-secondary)]">Mode</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {APPEARANCE_MODE_OPTIONS.map((option) => {
                  const selected = draft.appearance_mode === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`rounded-xl border p-4 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                      style={{ background: "var(--surface-card)" }}
                      onClick={() => updateDraft({ appearance_mode: option.value })}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[14px] font-semibold text-[var(--text-primary)]">{option.label}</div>
                        {selected ? (
                          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--theme-primary)] text-white shadow-sm">
                            <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m5 10 3 3 7-7" />
                            </svg>
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>

        <Card title="Privacy" subtitle="Hide all financial amounts when sharing your screen, presenting, or working in public. No data changes — amounts are masked on this device only.">
          <label className="flex cursor-pointer items-center justify-between gap-4">
            <div>
              <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Hide financial amounts</div>
              <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">Stored locally — not synced to other devices.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.privacy_mode}
              onClick={togglePrivacyMode}
              className={`relative h-6 w-[42px] shrink-0 rounded-full transition-colors duration-200 ${preferences.privacy_mode ? "bg-[var(--theme-primary)]" : "bg-[var(--border-strong)]"}`}
            >
              <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-all duration-200 ${preferences.privacy_mode ? "left-[21px]" : "left-[3px]"}`} />
            </button>
          </label>
        </Card>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="button" disabled={!hasChanges} onClick={handleSave}>
            Save appearance
          </Button>
          <Button type="button" variant="secondary" disabled={!hasChanges} onClick={handleCancel}>
            Cancel
          </Button>
          <button
            type="button"
            className="ml-auto text-[12px] font-medium text-rose-700 transition hover:text-rose-800"
            onClick={handleRestoreDefaults}
          >
            Restore defaults
          </button>
        </div>
      </div>
    );
  }

  if (tab === "savings_floor") {
    return (
      <Card
        title="Savings Floor"
        subtitle="Get warned before savings drops below this amount. This is a planning preference, not a required setup step."
      >
        <div className="space-y-5">
          {savingsFloorMessage ? <SuccessNotice title="Savings floor updated" message={savingsFloorMessage} /> : null}
          {savingsFloorError ? <ErrorState title="Savings floor update failed" message={savingsFloorError} /> : null}

          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-[var(--border-subtle)] px-4 py-3" style={{ background: "var(--surface-muted)" }}>
            <div>
              <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Enable savings floor alerts</div>
              <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">Show a warning when savings fall below the threshold.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={savingsFloorDraft.enabled}
              onClick={() => {
                setSavingsFloorDraft((current) => ({ ...current, enabled: !current.enabled }));
                setSavingsFloorError(null);
                setSavingsFloorMessage(null);
              }}
              className={`relative h-6 w-[42px] shrink-0 rounded-full transition-colors duration-200 ${savingsFloorDraft.enabled ? "bg-[var(--theme-primary)]" : "bg-[var(--border-strong)]"}`}
            >
              <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-all duration-200 ${savingsFloorDraft.enabled ? "left-[21px]" : "left-[3px]"}`} />
            </button>
          </label>

          <MoneyInput
            label="Floor amount"
            name="savingsFloor"
            value={savingsFloorDraft.amount}
            onChange={(value) => {
              setSavingsFloorDraft((current) => ({ ...current, amount: value }));
              setSavingsFloorError(null);
              setSavingsFloorMessage(null);
            }}
            placeholder="500.00"
          />

          <div className="flex flex-wrap gap-3 pt-1">
            <Button type="button" onClick={handleSaveSavingsFloor} disabled={isSavingFloor || !hasSavingsFloorChanges}>
              {isSavingFloor ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={handleResetSavingsFloor} disabled={isSavingFloor || !hasSavingsFloorChanges}>
              Cancel
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      {rulesData.isLoading ? <LoadingState label="Loading import rules…" /> : null}
      {!rulesData.isLoading && rulesData.error ? (
        <ErrorState title="Failed to load import rules" message={rulesData.error} onRetry={() => void rulesData.reload()} />
      ) : null}
      {ruleError ? <ErrorState title="Rule action failed" message={ruleError} /> : null}
      {ruleMessage ? <SuccessNotice title="Import rules updated" message={ruleMessage} /> : null}

      {!rulesData.isLoading && !rulesData.error && rulesData.data ? (
        <Card
          title="Import Rules"
          subtitle="Suggestions stay review-only. Reusable rules can have auto-apply enabled or disabled at any time."
        >
          {rulesData.data.rules.length ? (
            <div className="space-y-2">
              {rulesData.data.rules.map((rule) => {
                const isPending = pendingRuleId === rule.id;
                const categoryLabel = rule.category_id
                  ? (rulesData.data?.categories.find((item) => item.id === rule.category_id)?.label ?? rule.category_id)
                  : null;

                return (
                  <div
                    key={rule.id}
                    className="group relative rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 transition duration-150 hover:bg-[var(--surface-muted)]"
                  >
                    <div className="space-y-3">
                      <div className="min-w-0 space-y-1">
                        <div className="truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                          {rule.match_type === "contains" ? `Description contains "${rule.match_value}"` : `Description equals "${rule.match_value}"`}
                        </div>
                        <div className="truncate text-[12px] leading-5 text-[var(--text-secondary)]">
                          {ruleActionLabel(rule)}{categoryLabel ? ` — ${categoryLabel}` : ""}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={rule.rule_type === "reusable_rule" ? "neutral" : "warning"} className="h-5 whitespace-nowrap px-2 text-[10.5px]">
                            {rule.rule_type === "reusable_rule" ? "Reusable" : "Suggestion Only"}
                          </Badge>
                          {rule.rule_type === "reusable_rule" ? (
                            <Badge tone={rule.auto_apply ? "success" : "neutral"} className="h-5 whitespace-nowrap px-2 text-[10.5px]">
                              {rule.auto_apply ? "Auto-Apply ON" : "Auto-Apply OFF"}
                            </Badge>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="text-[12px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                            onClick={() => {
                              setOpenRuleMenuId(null);
                              setEditingRuleId(rule.id);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-7 items-center justify-center rounded-full border border-[var(--border-subtle)] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                            onClick={() => setOpenRuleMenuId((current) => current === rule.id ? null : rule.id)}
                          >
                            More
                          </button>
                        </div>
                      </div>
                    </div>

                    {openRuleMenuId === rule.id ? (
                      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] pt-3">
                        {rule.rule_type === "reusable_rule" && rule.auto_apply ? (
                          <button
                            type="button"
                            className="text-[12px] font-medium text-[var(--text-primary)] transition hover:text-[var(--theme-primary)]"
                            disabled={isPending}
                            onClick={() => void handleRuleModeChange(rule, "reusable_rule", false)}
                          >
                            Disable Auto-Apply
                          </button>
                        ) : null}
                        {rule.rule_type === "reusable_rule" && !rule.auto_apply ? (
                          <button
                            type="button"
                            className="text-[12px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                            disabled={isPending}
                            onClick={() => void handleRuleModeChange(rule, "reusable_rule", true)}
                          >
                            Enable Auto-Apply
                          </button>
                        ) : null}
                        {rule.rule_type !== "suggestion" ? (
                          <button
                            type="button"
                            className="text-[12px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                            disabled={isPending}
                            onClick={() => void handleRuleModeChange(rule, "suggestion", false)}
                          >
                            Convert to Suggestion
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="text-[12px] font-medium text-rose-600 transition hover:text-rose-700"
                          disabled={isPending}
                          onClick={() => void handleDeleteRule(rule.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No import rules saved"
              message="Use transaction review to save suggestions or reusable rules, then manage them here."
            />
          )}
        </Card>
      ) : null}

      {!rulesData.isLoading && !rulesData.error && rulesData.data && editingRuleId ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
          <div
            className="w-full max-w-3xl rounded-[1.75rem] border border-[var(--border-subtle)] p-5 shadow-[0_28px_70px_rgba(15,23,42,0.28)]"
            style={{ background: "var(--surface-card)" }}
          >
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
              <div>
                <h3 className="text-[15px] font-bold text-[var(--text-primary)]">Edit Rule</h3>
                <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                  Update the match condition, rule outcome, and auto-apply behavior.
                </p>
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[var(--text-secondary)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                onClick={() => setEditingRuleId(null)}
                aria-label="Close"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="m5 5 10 10M15 5 5 15" />
                </svg>
              </button>
            </div>

            {(() => {
              const rule = rulesData.data.rules.find((item) => item.id === editingRuleId);
              if (!rule) return null;
              return (
                <ImportRuleEditor
                  categories={rulesData.data.categories}
                  debts={rulesData.data.debts}
                  fixedBills={rulesData.data.fixedBills}
                  goals={rulesData.data.goals}
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
  );
}
