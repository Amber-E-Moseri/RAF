import { useMemo, useState } from "react";
import { z } from "zod";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { createDebt } from "../api/debtsApi";
import { createFixedBill } from "../api/fixedBillsApi";
import { createGoal } from "../api/goalsApi";
import { createIncome } from "../api/incomeApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { PageShell } from "../components/layout/PageShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { MoneyInput } from "../components/ui/MoneyInput";
import { useAsyncData } from "../hooks/useAsyncData";
import { Money } from "../components/ui/Money";
import type { AllocationCategory } from "../lib/types";

const stepOrder = ["income", "expenses", "debts", "goals", "review"] as const;
type StepKey = (typeof stepOrder)[number];

const moneySchema = z.string().trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, "must be a valid amount with up to 2 decimals")
  .refine((value) => Number(value) > 0, "must be greater than 0");
const isoDateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a valid ISO date");

const incomeRowSchema = z.object({
  sourceName: z.string().trim().min(1, "is required"),
  amount: moneySchema,
  receivedDate: isoDateSchema,
});
const fixedBillRowSchema = z.object({
  name: z.string().trim().min(1, "is required"),
  categorySlug: z.string().trim().min(1, "is required"),
  expectedAmount: moneySchema,
  dueDayOfMonth: z.number().int().min(1).max(31),
});
const debtRowSchema = z.object({
  name: z.string().trim().min(1, "is required"),
  startingBalance: moneySchema,
  apr: z.number().min(0).max(100),
  minimumPayment: moneySchema,
  monthlyPayment: moneySchema,
});
const goalRowSchema = z.object({
  bucketId: z.string().trim().min(1, "is required"),
  name: z.string().trim().min(1, "is required"),
  targetAmount: moneySchema,
  targetDate: z.union([isoDateSchema, z.literal("")]).optional().default(""),
});

type IncomeDraft = { sourceName: string; amount: string; receivedDate: string };
type FixedBillDraft = { name: string; categorySlug: string; expectedAmount: string; dueDayOfMonth: number };
type DebtDraft = { name: string; startingBalance: string; apr: string; minimumPayment: string; monthlyPayment: string };
type GoalDraft = { bucketId: string; name: string; targetAmount: string; targetDate: string };

const todayIso = new Date().toISOString().slice(0, 10);

export function PlanWizard() {
  const {
    data: categories,
    error: categoriesError,
    isLoading: categoriesLoading,
    reload: reloadCategories,
  } = useAsyncData<AllocationCategory[]>(async () => getAllocationCategories(), []);
  const [activeStep, setActiveStep] = useState(0);
  const [incomeRows, setIncomeRows] = useState<IncomeDraft[]>([
    { sourceName: "", amount: "", receivedDate: todayIso },
  ]);
  const [fixedBillRows, setFixedBillRows] = useState<FixedBillDraft[]>([
    { name: "", categorySlug: "fixed_bills", expectedAmount: "", dueDayOfMonth: 1 },
  ]);
  const [debtRows, setDebtRows] = useState<DebtDraft[]>([
    { name: "", startingBalance: "", apr: "0", minimumPayment: "", monthlyPayment: "" },
  ]);
  const [goalRows, setGoalRows] = useState<GoalDraft[]>([
    { bucketId: "", name: "", targetAmount: "", targetDate: "" },
  ]);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const totalSteps = stepOrder.length;
  const progress = Math.round(((activeStep + 1) / totalSteps) * 100);
  const section = stepOrder[activeStep];

  const activeCategories = useMemo(
    () => (categories ?? []).filter((category) => category.isActive !== false),
    [categories],
  );
  const goalBucketOptions = useMemo(
    () => activeCategories.map((category) => ({ id: category.id, label: category.label })),
    [activeCategories],
  );

  const totals = useMemo(() => {
    const incomeTotal = incomeRows.reduce((sum, row) => sum + Number(row.amount || "0"), 0);
    const fixedTotal = fixedBillRows.reduce((sum, row) => sum + Number(row.expectedAmount || "0"), 0);
    const debtsTotal = debtRows.reduce((sum, row) => sum + Number(row.monthlyPayment || "0"), 0);
    const goalsTotal = goalRows.reduce((sum, row) => sum + Number(row.targetAmount || "0"), 0);
    return {
      incomeTotal,
      fixedTotal,
      debtsTotal,
      goalsTotal,
      netAfterCommitments: incomeTotal - fixedTotal - debtsTotal,
    };
  }, [incomeRows, fixedBillRows, debtRows, goalRows]);

  function validateStep(step: StepKey) {
    if (step === "income") {
      const parsed = z.array(incomeRowSchema).safeParse(incomeRows);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return `Income ${issue.path.join(".")} ${issue.message}`.trim();
      }
      return null;
    }

    if (step === "expenses") {
      const parsed = z.array(fixedBillRowSchema).safeParse(fixedBillRows);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return `Fixed bill ${issue.path.join(".")} ${issue.message}`.trim();
      }
      return null;
    }

    if (step === "debts") {
      const parsed = z.array(
        debtRowSchema.extend({
          apr: z.string().trim().transform((value) => Number(value)),
        }),
      ).safeParse(debtRows);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return `Debt ${issue.path.join(".")} ${issue.message}`.trim();
      }
      return null;
    }

    if (step === "goals") {
      const parsed = z.array(goalRowSchema).safeParse(goalRows);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return `Goal ${issue.path.join(".")} ${issue.message}`.trim();
      }
      return null;
    }

    return null;
  }

  async function handleSubmit() {
    const firstValidationError = stepOrder
      .map((step) => validateStep(step))
      .find((error) => error != null) ?? null;
    if (firstValidationError) {
      setSubmitError(firstValidationError);
      setSubmitSuccess(null);
      return;
    }

    setSubmitError(null);
    setSubmitSuccess(null);
    setIsSubmitting(true);

    try {
      for (const [index, row] of incomeRows.entries()) {
        await createIncome(
          {
            sourceName: row.sourceName.trim(),
            amount: Number(row.amount).toFixed(2),
            receivedDate: row.receivedDate,
          },
          `wizard-income-${Date.now()}-${index}`,
        );
      }

      for (const row of fixedBillRows) {
        await createFixedBill({
          name: row.name.trim(),
          category_slug: row.categorySlug,
          expected_amount: Number(row.expectedAmount).toFixed(2),
          due_day_of_month: row.dueDayOfMonth,
          active: true,
        });
      }

      for (const row of debtRows) {
        await createDebt({
          name: row.name.trim(),
          startingBalance: Number(row.startingBalance).toFixed(2),
          apr: Number(row.apr || "0"),
          minimumPayment: Number(row.minimumPayment).toFixed(2),
          monthlyPayment: Number(row.monthlyPayment).toFixed(2),
        });
      }

      const fallbackBucketId = goalBucketOptions.find((option) => option.label.toLowerCase().includes("savings"))?.id
        ?? goalBucketOptions[0]?.id
        ?? null;
      for (const row of goalRows) {
        await createGoal({
          bucket_id: row.bucketId || fallbackBucketId || "",
          name: row.name.trim(),
          target_amount: Number(row.targetAmount).toFixed(2),
          target_date: row.targetDate || null,
        });
      }

      setSubmitSuccess("Plan setup saved. Your income, fixed bills, debts, and goals are now persisted.");
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Wizard submission failed.");
      setSubmitSuccess(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  const nextStep = () => {
    const validationError = validateStep(section);
    if (validationError) {
      setStepError(validationError);
      return;
    }
    setStepError(null);
    setActiveStep((current) => Math.min(totalSteps - 1, current + 1));
  };

  const prevStep = () => {
    setStepError(null);
    setActiveStep((current) => Math.max(0, current - 1));
  };

  if (categoriesLoading) {
    return (
      <PageShell eyebrow="Plan wizard" title="Create your monthly plan">
        <LoadingState label="Loading categories..." />
      </PageShell>
    );
  }

  if (categoriesError || !categories) {
    return (
      <PageShell eyebrow="Plan wizard" title="Create your monthly plan">
        <ErrorState title="Failed to load wizard setup" message={categoriesError ?? "Unable to load categories."} onRetry={() => void reloadCategories()} />
      </PageShell>
    );
  }

  return (
    <PageShell eyebrow="Plan wizard" title="Create your monthly plan">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
            <span>Step {activeStep + 1} of {totalSteps}</span>
            <span>{section.replace("-", " ")}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-[var(--surface-elevated)]">
            <div className="h-2 rounded-full bg-[var(--primary-color)] transition-all duration-200" style={{ width: `${progress}%` }} />
          </div>
          <div className="grid grid-cols-5 gap-2">
            {stepOrder.map((step, index) => (
              <button
                key={step}
                type="button"
                className={`min-h-11 rounded-xl border px-2 text-[12px] font-semibold capitalize ${
                  index === activeStep
                    ? "border-[var(--primary-color)] bg-[var(--primary-soft)] text-[var(--primary-color-strong)]"
                    : "border-[var(--border-color)] bg-[var(--surface-color)] text-[var(--text-muted)]"
                }`}
                onClick={() => setActiveStep(index)}
              >
                {step.replace("-", " ")}
              </button>
            ))}
          </div>
        </div>

        {section === "income" && (
          <div className="space-y-4 rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-[var(--text-strong)]">Income</h3>
            <p className="text-sm text-[var(--text-muted)]">Add each expected deposit for this month.</p>
            {incomeRows.map((row, index) => (
              <div key={`income-${index}`} className="grid gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3 sm:grid-cols-3">
                <Input label="Source" value={row.sourceName} onChange={(event) => setIncomeRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, sourceName: event.target.value } : item)))} />
                <MoneyInput label="Amount" name={`income-amount-${index}`} value={row.amount} onChange={(value) => setIncomeRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, amount: value } : item)))} />
                <Input label="Received date" type="date" value={row.receivedDate} onChange={(event) => setIncomeRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, receivedDate: event.target.value } : item)))} />
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setIncomeRows((current) => [...current, { sourceName: "", amount: "", receivedDate: todayIso }])}>
              Add another income
            </Button>
          </div>
        )}

        {section === "expenses" && (
          <div className="space-y-4 rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-[var(--text-strong)]">Fixed expenses</h3>
            <p className="text-sm text-[var(--text-muted)]">Track recurring bills so your monthly baseline stays clear.</p>
            {fixedBillRows.map((row, index) => (
              <div key={`bill-${index}`} className="grid gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3 sm:grid-cols-2">
                <Input label="Bill name" value={row.name} onChange={(event) => setFixedBillRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, name: event.target.value } : item)))} />
                <MoneyInput label="Expected amount" name={`bill-amount-${index}`} value={row.expectedAmount} onChange={(value) => setFixedBillRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, expectedAmount: value } : item)))} />
                <label className="block">
                  <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-strong)]">Category</span>
                  <select
                    className="ui-field"
                    value={row.categorySlug}
                    onChange={(event) => setFixedBillRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, categorySlug: event.target.value } : item)))}
                  >
                    {activeCategories.map((category) => (
                      <option key={category.slug} value={category.slug}>{category.label}</option>
                    ))}
                  </select>
                </label>
                <Input
                  label="Due day"
                  type="number"
                  min={1}
                  max={31}
                  value={row.dueDayOfMonth}
                  onChange={(event) => setFixedBillRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, dueDayOfMonth: Number(event.target.value || "1") } : item)))}
                />
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setFixedBillRows((current) => [...current, { name: "", categorySlug: "fixed_bills", expectedAmount: "", dueDayOfMonth: 1 }])}>
              Add another fixed bill
            </Button>
          </div>
        )}

        {section === "debts" && (
          <div className="space-y-4 rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-[var(--text-strong)]">Debts</h3>
            <p className="text-sm text-[var(--text-muted)]">Set balances and payments so debt progress is accurate.</p>
            {debtRows.map((row, index) => (
              <div key={`debt-${index}`} className="grid gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3 sm:grid-cols-2">
                <Input label="Debt name" value={row.name} onChange={(event) => setDebtRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, name: event.target.value } : item)))} />
                <Input label="APR %" type="number" min={0} max={100} step="0.01" value={row.apr} onChange={(event) => setDebtRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, apr: event.target.value } : item)))} />
                <MoneyInput label="Starting balance" name={`debt-balance-${index}`} value={row.startingBalance} onChange={(value) => setDebtRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, startingBalance: value } : item)))} />
                <MoneyInput label="Minimum payment" name={`debt-min-${index}`} value={row.minimumPayment} onChange={(value) => setDebtRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, minimumPayment: value } : item)))} />
                <MoneyInput label="Planned monthly payment" name={`debt-monthly-${index}`} value={row.monthlyPayment} onChange={(value) => setDebtRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, monthlyPayment: value } : item)))} />
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setDebtRows((current) => [...current, { name: "", startingBalance: "", apr: "0", minimumPayment: "", monthlyPayment: "" }])}>
              Add another debt
            </Button>
          </div>
        )}

        {section === "goals" && (
          <div className="space-y-4 rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-[var(--text-strong)]">Goals</h3>
            <p className="text-sm text-[var(--text-muted)]">Define what each category is funding next.</p>
            {goalRows.map((row, index) => (
              <div key={`goal-${index}`} className="grid gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3 sm:grid-cols-2">
                <Input label="Goal name" value={row.name} onChange={(event) => setGoalRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, name: event.target.value } : item)))} />
                <MoneyInput label="Target amount" name={`goal-target-${index}`} value={row.targetAmount} onChange={(value) => setGoalRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, targetAmount: value } : item)))} />
                <label className="block">
                  <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-strong)]">Category</span>
                  <select
                    className="ui-field"
                    value={row.bucketId}
                    onChange={(event) => setGoalRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, bucketId: event.target.value } : item)))}
                  >
                    <option value="">Select category</option>
                    {goalBucketOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <Input label="Target date (optional)" type="date" value={row.targetDate} onChange={(event) => setGoalRows((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, targetDate: event.target.value } : item)))} />
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setGoalRows((current) => [...current, { bucketId: "", name: "", targetAmount: "", targetDate: "" }])}>
              Add another goal
            </Button>
          </div>
        )}

        {section === "review" && (
          <div className="space-y-4 rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-[var(--text-strong)]">Review and save</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Income</div>
                <div className="mt-1 text-xl font-semibold text-[var(--text-strong)]">{<Money value={totals.incomeTotal.toFixed(2)} />}</div>
              </div>
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Fixed bills</div>
                <div className="mt-1 text-xl font-semibold text-[var(--text-strong)]">{<Money value={totals.fixedTotal.toFixed(2)} />}</div>
              </div>
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Debt payments</div>
                <div className="mt-1 text-xl font-semibold text-[var(--text-strong)]">{<Money value={totals.debtsTotal.toFixed(2)} />}</div>
              </div>
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Goals target total</div>
                <div className="mt-1 text-xl font-semibold text-[var(--text-strong)]">{<Money value={totals.goalsTotal.toFixed(2)} />}</div>
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-3">
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Net after fixed commitments</div>
              <div className="mt-1 text-2xl font-semibold text-[var(--text-strong)]">{<Money value={totals.netAfterCommitments.toFixed(2)} />}</div>
            </div>

            {submitError ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{submitError}</p> : null}
            {submitSuccess ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{submitSuccess}</p> : null}
            <Button type="button" disabled={isSubmitting} onClick={() => void handleSubmit()}>
              {isSubmitting ? "Saving plan..." : "Save plan setup"}
            </Button>
          </div>
        )}

        {stepError ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{stepError}</p> : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" disabled={activeStep === 0} onClick={prevStep}>Back</Button>
          {activeStep < totalSteps - 1 ? <Button type="button" onClick={nextStep}>Next</Button> : null}
        </div>
      </div>
    </PageShell>
  );
}
