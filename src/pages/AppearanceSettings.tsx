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
import { PageShell } from "../components/layout/PageShell";
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

type SettingsTab = "preferences" | "savings_floor" | "import_rules";

const settingsTabs: Array<{ id: SettingsTab; label: string; description: string }> = [
  {
    id: "preferences",
    label: "Preferences",
    description: "Theme, typography, and scale for this device.",
  },
  {
    id: "savings_floor",
    label: "Savings Floor",
    description: "Warning threshold for protected savings.",
  },
  {
    id: "import_rules",
    label: "Import Rules",
    description: "Suggestions, reusable rules, and auto-apply controls.",
  },
];

const themeGroups: Array<{
  mood: string;
  values: ThemeColor[];
  helper: string;
}> = [
  { mood: "Professional", values: ["minimal", "violet"], helper: "Calm contrast for focused daily finance work." },
  { mood: "Balanced", values: ["emerald"], helper: "RAF's default look with steady contrast and warmth." },
  { mood: "Expressive", values: ["blush"], helper: "A softer accent with a little more personality." },
];

function ruleActionLabel(rule: ImportReviewRule) {
  if (rule.classification_type === "income") {
    return "Add to income deposit";
  }
  if (rule.classification_type === "transaction") {
    return "Approve as transaction";
  }
  if (rule.classification_type === "debt_payment") {
    return "Link to debt payment";
  }
  if (rule.classification_type === "fixed_bill_payment") {
    return "Link to fixed bill";
  }
  if (rule.classification_type === "goal_funding") {
    return "Internal transfer to savings goal";
  }
  if (rule.classification_type === "duplicate") {
    return "Mark duplicate";
  }
  if (rule.classification_type === "transfer") {
    return "Mark transfer";
  }
  return "Ignore";
}

function selectedCardClasses(selected: boolean) {
  return selected
    ? "border-[var(--primary-color)] bg-[var(--surface-plain)] shadow-panel"
    : "border-[var(--border-color)] hover:-translate-y-0.5 hover:shadow-lift";
}

function selectedCardStyle(selected: boolean) {
  return selected
    ? {
      background: "var(--surface-plain)",
      boxShadow: "inset 0 0 0 1px var(--primary-color), var(--shadow-panel)",
    }
    : {
      background: "var(--surface-plain)",
    };
}

export function AppearanceSettings() {
  const { preferences, saveAppearance, togglePrivacyMode } = useAppearance();
  const [activeTab, setActiveTab] = useState<SettingsTab>("preferences");
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
    if (!rulesData.data?.household) {
      return;
    }

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

  const activeTheme = useMemo(
    () => THEME_OPTIONS.find((option) => option.value === draft.theme_color) ?? THEME_OPTIONS[0],
    [draft.theme_color],
  );
  const activeFont = useMemo(
    () => FONT_OPTIONS.find((option) => option.value === draft.font_family) ?? FONT_OPTIONS[0],
    [draft.font_family],
  );
  const activeScale = useMemo(
    () => INTERFACE_SCALE_OPTIONS.find((option) => option.value === draft.interface_scale) ?? INTERFACE_SCALE_OPTIONS[1],
    [draft.interface_scale],
  );
  const activeMode = useMemo(
    () => APPEARANCE_MODE_OPTIONS.find((option) => option.value === draft.appearance_mode) ?? APPEARANCE_MODE_OPTIONS[0],
    [draft.appearance_mode],
  );

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
    if (!household) {
      return false;
    }

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
    if (!household) {
      return;
    }

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
      [rule.id]: {
        ...(current[rule.id] ?? buildImportRuleDraft(rule)),
        ...patch,
      },
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

  return (
    <PageShell
      eyebrow="Settings"
      title="Make RAF feel like yours."
      description="Appearance, privacy and notification preferences live here. Financial semantics are not changed by presentation settings."
    >
      <section className="grid gap-6 xl:grid-cols-2">
        <Card>
          <div className="card-title text-sm font-semibold text-[var(--text-strong)]">Appearance &amp; privacy</div>
          <div className="mt-4 divide-y divide-[var(--border-color)]">
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-sm font-medium text-[var(--text-strong)]">Privacy mode</div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">Mask financial amounts on screen</div>
              </div>
              <button
                type="button"
                onClick={togglePrivacyMode}
                className={`relative h-6 w-[42px] shrink-0 rounded-full transition ${preferences.privacy_mode ? "bg-[var(--primary-color)]" : "bg-[#d6dbe0]"}`}
              >
                <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition ${preferences.privacy_mode ? "left-[21px]" : "left-[3px]"}`} />
              </button>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-sm font-medium text-[var(--text-strong)]">Compact density</div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">Tighter spacing across pages</div>
              </div>
              <button
                type="button"
                onClick={() => void saveAppearance({ ...draft, interface_scale: draft.interface_scale === "small" ? "medium" : "small" })}
                className={`relative h-6 w-[42px] shrink-0 rounded-full transition ${draft.interface_scale === "small" ? "bg-[var(--primary-color)]" : "bg-[#d6dbe0]"}`}
              >
                <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition ${draft.interface_scale === "small" ? "left-[21px]" : "left-[3px]"}`} />
              </button>
            </div>
          </div>
        </Card>
        <Card>
          <div className="card-title text-sm font-semibold text-[var(--text-strong)]">Notifications</div>
          <div className="mt-4 divide-y divide-[var(--border-color)]">
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-sm font-medium text-[var(--text-strong)]">Financial attention reminders</div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">Get alerted about items that need review</div>
              </div>
              <span className="text-xs text-[var(--text-muted)]">Coming soon</span>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="text-sm font-medium text-[var(--text-strong)]">Monthly close reminder</div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">Reminder to close each month</div>
              </div>
              <span className="text-xs text-[var(--text-muted)]">Coming soon</span>
            </div>
          </div>
        </Card>
      </section>

      <section className="space-y-6">
        <div className="flex gap-2 border-b border-[var(--border-color)]">
          {settingsTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`border-b-2 px-3 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em] transition ${activeTab === tab.id ? "border-[var(--primary-color)] text-[var(--primary-color)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]"}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="space-y-6">
          {activeTab === "preferences" ? (
            <>
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
                      <div
                        key={group.mood}
                        className={`flex h-full flex-col space-y-3 ${index === 0 ? "lg:col-span-2" : ""}`}
                      >
                        <div>
                          <div className="text-sm font-semibold text-[var(--text-strong)]">{group.mood}</div>
                          <p className="mt-1 text-[12px] italic text-[var(--text-muted)]">{group.helper}</p>
                        </div>
                        <div className={`grid flex-1 gap-3 ${group.values.length > 1 ? "md:grid-cols-2" : ""}`}>
                          {group.values.map((themeValue) => {
                            const option = THEME_OPTIONS.find((item) => item.value === themeValue);
                            if (!option) {
                              return null;
                            }
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
                                    <span
                                      className="h-12 w-12 shrink-0 rounded-2xl border border-white/80 shadow-sm"
                                      style={{ background: `linear-gradient(145deg, ${option.swatch}, ${option.accent})` }}
                                    />
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
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">
                      Pick the reading voice you want across RAF. The preview updates instantly so dense financial data stays easy to judge.
                    </p>
                  </div>

                  <div className="grid gap-3">
                    {FONT_OPTIONS.map((option) => {
                      const selected = draft.font_family === option.value;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                          style={{ background: selected ? undefined : "var(--surface-plain)" }}
                          onClick={() => updateDraft({ font_family: option.value })}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div
                                className="text-lg font-semibold text-[var(--text-strong)]"
                                style={{ fontFamily: `var(--font-${option.value})` }}
                              >
                                {option.label}
                              </div>
                              <p className="mt-1 text-[13px] italic leading-6 text-[var(--text-muted)]">
                                {option.preview}
                              </p>
                            </div>
                            {selected ? (
                              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary-color)] text-[var(--primary-contrast)] shadow-sm">
                                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              </Card>

              <Card title="Interface Scale">
                <div className="space-y-5">
                  <div className="border-b border-[var(--border-color)] pb-6">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Scale</div>
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">
                      Adjust how compact or spacious the interface feels without changing the structure of the application.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    {INTERFACE_SCALE_OPTIONS.map((option) => {
                      const selected = draft.interface_scale === option.value;
                      const sizeClass = option.value === "small"
                        ? "text-base"
                        : option.value === "medium"
                          ? "text-lg"
                          : "text-xl";

                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                          style={{ background: selected ? undefined : "var(--surface-plain)" }}
                          onClick={() => updateDraft({ interface_scale: option.value })}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className={`${sizeClass} font-semibold text-[var(--text-strong)]`}>
                              {option.label}
                            </div>
                            {selected ? (
                              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary-color)] text-[var(--primary-contrast)] shadow-sm">
                                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="m5 10 3 3 7-7" />
                                </svg>
                              </span>
                            ) : null}
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
                          <button
                            key={option.value}
                            type="button"
                            className={`rounded-[1.5rem] border p-5 text-left transition duration-200 ${selectedCardClasses(selected)}`}
                            style={{ background: selected ? undefined : "var(--surface-plain)" }}
                            onClick={() => updateDraft({ appearance_mode: option.value })}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-base font-semibold text-[var(--text-strong)]">{option.label}</div>
                              {selected ? (
                                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary-color)] text-[var(--primary-contrast)] shadow-sm">
                                  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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


              <Card title="Privacy Mode">
                <div className="space-y-5">
                  <div className="border-b border-[var(--border-color)] pb-5">
                    <div className="text-[17px] font-semibold text-[var(--text-strong)]">Privacy Mode</div>
                    <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">
                      Hide all financial amounts when sharing your screen, presenting, or working in public. No data changes — amounts are masked on this device only and restore automatically when toggled off.
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-[var(--border-color)] px-4 py-4" style={{ background: "var(--surface-plain)" }}>
                    <label className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-[var(--text-strong)]">Hide financial amounts</div>
                        <div className="mt-1 text-[12px] italic text-[var(--text-muted)]">Masks all dollar values shown in RAF. Stored locally — not synced to other devices.</div>
                      </div>
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-[var(--border-color)] text-[var(--primary-color)]"
                        checked={preferences.privacy_mode}
                        aria-label="Hide financial amounts"
                        onChange={togglePrivacyMode}
                      />
                    </label>
                  </div>
                </div>
              </Card>
              <div className="pt-1">
                <Card title="Apply Appearance Changes">
                  <div className="space-y-4">
                    <p className="text-[13px] leading-6 text-[var(--text-muted)]">
                      Saving will update your appearance across RAF. Cancel keeps your current look. Restoring defaults resets everything to the RAF preset.
                    </p>
                    <div className="flex flex-col gap-3">
                      <Button type="button" className="w-full" disabled={!hasChanges} onClick={handleSave}>
                        Save Appearance
                      </Button>
                      <Button type="button" variant="secondary" className="w-full" disabled={!hasChanges} onClick={handleCancel}>
                        Cancel
                      </Button>
                    </div>
                    <div className="pt-1">
                      <button
                        type="button"
                        className="text-sm font-medium text-rose-700 transition hover:text-rose-800"
                        onClick={handleRestoreDefaults}
                      >
                        Restore defaults
                      </button>
                    </div>
                  </div>
                </Card>
              </div>
            </>
          ) : activeTab === "savings_floor" ? (
            <Card title="Savings Floor">
              <div className="space-y-5">
                <div className="border-b border-[var(--border-color)] pb-5">
                  <div className="text-[17px] font-semibold text-[var(--text-strong)]">Savings Floor</div>
                  <p className="mt-2 max-w-2xl text-[13px] italic leading-6 text-[var(--text-muted)]">
                    Get warned before savings drops below this amount.
                  </p>
                </div>

                {savingsFloorMessage ? <SuccessNotice title="Savings floor updated" message={savingsFloorMessage} /> : null}
                {savingsFloorError ? (
                  <ErrorState
                    title="Savings floor update failed"
                    message={savingsFloorError}
                  />
                ) : null}

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
                      onChange={(event) => {
                        setSavingsFloorDraft((current) => ({ ...current, enabled: event.target.checked }));
                        setSavingsFloorError(null);
                        setSavingsFloorMessage(null);
                      }}
                    />
                  </label>
                </div>

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

                <div className="flex flex-wrap gap-3">
                  <Button type="button" onClick={handleSaveSavingsFloor} disabled={isSavingFloor || !hasSavingsFloorChanges}>
                    {isSavingFloor ? "Saving floor..." : "Save Savings Floor"}
                  </Button>
                  <Button type="button" variant="secondary" onClick={handleResetSavingsFloor} disabled={isSavingFloor || !hasSavingsFloorChanges}>
                    Cancel
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <>
              {rulesData.isLoading ? <LoadingState label="Loading import rules..." /> : null}
              {!rulesData.isLoading && rulesData.error ? <ErrorState title="Failed to load import rules" message={rulesData.error} onRetry={() => void rulesData.reload()} /> : null}
              {ruleError ? <ErrorState title="Rule action failed" message={ruleError} /> : null}
              {ruleMessage ? <SuccessNotice title="Import rules updated" message={ruleMessage} /> : null}
              {!rulesData.isLoading && !rulesData.error && rulesData.data ? (
                <Card title="Import Rules" subtitle="Suggestions stay review-only. Reusable rules can have auto-apply enabled or disabled at any time.">
                  {rulesData.data?.rules.length ? (
                    <div className="space-y-2">
                      {rulesData.data.rules.map((rule) => {
                        const isPending = pendingRuleId === rule.id;
                        const categoryLabel = rule.category_id
                          ? (rulesData.data?.categories.find((item) => item.id === rule.category_id)?.label ?? rule.category_id)
                          : null;
                        return (
                          <div
                            key={rule.id}
                            className="group relative rounded-xl border border-[var(--border-color)] bg-[var(--surface-color)] px-4 py-3 transition duration-150 hover:bg-[color:color-mix(in_srgb,var(--surface-plain)_82%,var(--surface-color))]"
                          >
                            <div className="space-y-3">
                              <div className="min-w-0 space-y-1">
                                <div className="truncate text-sm font-semibold leading-5 text-[var(--text-strong)]">
                                  {rule.match_type === "contains" ? `Description contains "${rule.match_value}"` : `Description equals "${rule.match_value}"`}
                                </div>
                                <div className="truncate text-[13px] leading-5 text-[var(--text-muted)]">
                                  {ruleActionLabel(rule)}
                                  {categoryLabel ? ` - ${categoryLabel}` : ""}
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
                                  <button
                                    type="button"
                                    className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                                    onClick={() => {
                                      setOpenRuleMenuId(null);
                                      setEditingRuleId(rule.id);
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="inline-flex h-8 items-center justify-center rounded-full border border-[var(--border-color)] px-3 text-[12px] font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]"
                                    onClick={() => setOpenRuleMenuId((current) => current === rule.id ? null : rule.id)}
                                  >
                                    More
                                  </button>
                                </div>
                              </div>
                            </div>

                            {openRuleMenuId === rule.id ? (
                              <div
                                className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-color)] pt-3"
                              >
                                {rule.rule_type === "reusable_rule" && rule.auto_apply ? (
                                  <button
                                    type="button"
                                    className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-strong)] transition hover:text-[color:color-mix(in_srgb,var(--primary-color)_82%,var(--text-strong))]"
                                    disabled={isPending}
                                    onClick={() => void handleRuleModeChange(rule, "reusable_rule", false)}
                                  >
                                    Disable Auto-Apply
                                  </button>
                                ) : null}
                                {rule.rule_type === "reusable_rule" && !rule.auto_apply ? (
                                  <button
                                    type="button"
                                    className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                                    disabled={isPending}
                                    onClick={() => void handleRuleModeChange(rule, "reusable_rule", true)}
                                  >
                                    Enable Auto-Apply
                                  </button>
                                ) : null}
                                {rule.rule_type !== "suggestion" ? (
                                  <button
                                    type="button"
                                    className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                                    disabled={isPending}
                                    onClick={() => void handleRuleModeChange(rule, "suggestion", false)}
                                  >
                                    Convert to Suggestion
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="inline-flex items-center whitespace-nowrap text-[12px] font-medium text-[color:color-mix(in_srgb,#c2410c_78%,var(--text-muted))] transition hover:text-[#ef4444]"
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
                    className="w-full max-w-3xl rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-[0_28px_70px_rgba(15,23,42,0.28)]"
                    style={{ background: "var(--surface-color)" }}
                  >
                    <div className="mb-4 flex items-start justify-between gap-4 border-b border-[var(--border-color)] pb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-[var(--text-strong)]">Edit Rule</h3>
                        <p className="mt-1 text-sm text-[var(--text-muted)]">
                          Update the match condition, rule outcome, and auto-apply behavior without leaving Settings.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-color)] text-base text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]"
                        onClick={() => setEditingRuleId(null)}
                      >
                        X
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
          )}
        </div>
      </section>
    </PageShell>
  );
}
