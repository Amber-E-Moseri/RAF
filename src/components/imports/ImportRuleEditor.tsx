import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import type {
  AllocationCategory,
  Debt,
  FixedBill,
  Goal,
  ImportClassificationPayload,
  ImportReviewRule,
  ImportReviewSuggestion,
  ImportReviewRuleUpdatePayload,
} from "../../lib/types";

export interface ImportRuleDraft {
  matchValue: string;
  matchType: "contains" | "exact";
  classificationType: ImportClassificationPayload["classification_type"];
  categoryId: string;
  debtId: string;
  fixedBillId: string;
  goalId: string;
  ruleType: "suggestion" | "reusable_rule";
  autoApply: boolean;
}

export function buildImportRuleDraft(rule: ImportReviewRule | ImportReviewSuggestion): ImportRuleDraft {
  return {
    matchValue: rule.match_value ?? "",
    matchType: rule.match_type ?? "contains",
    classificationType: rule.classification_type as ImportClassificationPayload["classification_type"],
    categoryId: rule.category_id ?? "",
    debtId: rule.linked_debt_id ?? "",
    fixedBillId: rule.linked_fixed_bill_id ?? "",
    goalId: rule.linked_goal_id ?? "",
    ruleType: rule.rule_type ?? "suggestion",
    autoApply: rule.auto_apply,
  };
}

interface ImportRuleEditorProps {
  categories: AllocationCategory[];
  debts: Debt[];
  fixedBills: FixedBill[];
  goals: Goal[];
  draft: ImportRuleDraft;
  isSaving?: boolean;
  saveLabel?: string;
  allowAutoApplyToggle?: boolean;
  onChange: (patch: Partial<ImportRuleDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
}

function requiresCategorySelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "transaction";
}

function requiresDebtSelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "debt_payment";
}

function requiresFixedBillSelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "fixed_bill_payment";
}

function requiresGoalSelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "goal_funding";
}

export function mapRuleDraftToPayload(draft: ImportRuleDraft): ImportReviewRuleUpdatePayload {
  return {
    match_value: draft.matchValue.trim(),
    match_type: draft.matchType,
    classification_type: draft.classificationType,
    category_id: requiresCategorySelection(draft.classificationType) ? draft.categoryId || null : null,
    debt_id: requiresDebtSelection(draft.classificationType) ? draft.debtId || null : null,
    fixed_bill_id: requiresFixedBillSelection(draft.classificationType) ? draft.fixedBillId || null : null,
    goal_id: requiresGoalSelection(draft.classificationType) ? draft.goalId || null : null,
    rule_type: draft.ruleType,
    auto_apply: draft.ruleType === "reusable_rule" ? draft.autoApply : false,
  };
}

export function ImportRuleEditor({
  categories,
  debts,
  fixedBills,
  goals,
  draft,
  isSaving = false,
  saveLabel = "Save",
  allowAutoApplyToggle = true,
  onChange,
  onCancel,
  onSave,
}: ImportRuleEditorProps) {
  const canLinkFixedBill = fixedBills.length > 0;

  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Match condition"
          name="matchValue"
          placeholder="spotify"
          value={draft.matchValue}
          onChange={(event) => onChange({ matchValue: event.target.value })}
        />

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-raf-ink">Match type</span>
          <select
            className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
            value={draft.matchType}
            onChange={(event) => onChange({ matchType: event.target.value as "contains" | "exact" })}
          >
            <option value="contains">Description contains</option>
            <option value="exact">Description equals</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-raf-ink">Review action</span>
          <select
            className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
            value={draft.classificationType}
            onChange={(event) => onChange({
              classificationType: event.target.value as ImportClassificationPayload["classification_type"],
              categoryId: "",
              debtId: "",
              fixedBillId: "",
              goalId: "",
            })}
          >
            <option value="income">Add to income deposit</option>
            <option value="transaction">Approve as transaction</option>
            <option value="debt_payment">Link to debt payment</option>
            {canLinkFixedBill ? <option value="fixed_bill_payment">Link to fixed bill</option> : null}
            <option value="goal_funding">Internal transfer -&gt; savings goal</option>
            <option value="duplicate">Mark duplicate</option>
            <option value="transfer">Mark transfer</option>
            <option value="ignore">Ignore</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-raf-ink">Rule type</span>
          <select
            className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
            value={draft.ruleType}
            onChange={(event) => onChange({
              ruleType: event.target.value as "suggestion" | "reusable_rule",
              autoApply: event.target.value === "reusable_rule" ? true : false,
            })}
          >
            <option value="suggestion">Suggestion only</option>
            <option value="reusable_rule">Reusable rule</option>
          </select>
        </label>

        {requiresCategorySelection(draft.classificationType) ? (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-raf-ink">Category assignment</span>
            <select
              className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
              value={draft.categoryId}
              onChange={(event) => onChange({ categoryId: event.target.value })}
            >
              <option value="">Select category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        {requiresDebtSelection(draft.classificationType) ? (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-raf-ink">Debt</span>
            <select
              className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
              value={draft.debtId}
              onChange={(event) => onChange({ debtId: event.target.value })}
            >
              <option value="">Select debt</option>
              {debts.map((debt) => (
                <option key={debt.id} value={debt.id}>{debt.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {requiresFixedBillSelection(draft.classificationType) ? (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-raf-ink">Fixed bill</span>
            <select
              className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
              value={draft.fixedBillId}
              onChange={(event) => onChange({ fixedBillId: event.target.value })}
            >
              <option value="">Select fixed bill</option>
              {fixedBills.map((bill) => (
                <option key={bill.id} value={bill.id}>{bill.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {requiresGoalSelection(draft.classificationType) ? (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-raf-ink">Savings goal</span>
            <select
              className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
              value={draft.goalId}
              onChange={(event) => onChange({ goalId: event.target.value })}
            >
              <option value="">Select goal</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {allowAutoApplyToggle ? (
          <label className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700 md:col-span-2">
            <input
              type="checkbox"
              className="mt-1 size-4 rounded border-stone-300 text-raf-moss"
              checked={draft.autoApply}
              disabled={draft.ruleType !== "reusable_rule"}
              onChange={(event) => onChange({ autoApply: event.target.checked })}
            />
            <span>
              <span className="block font-medium text-raf-ink">Auto-apply</span>
              <span className="mt-1 block text-stone-500">Visible and reversible. Turn this off to convert the rule back to suggestion behavior.</span>
            </span>
          </label>
        ) : draft.ruleType === "reusable_rule" ? (
          <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700 md:col-span-2">
            <span className="block font-medium text-raf-ink">Auto-apply enabled</span>
            <span className="mt-1 block text-stone-500">Reusable rules auto-apply right away. To disable that later, use Settings.</span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="button" disabled={isSaving || !draft.matchValue.trim()} onClick={onSave}>{saveLabel}</Button>
      </div>
    </div>
  );
}
