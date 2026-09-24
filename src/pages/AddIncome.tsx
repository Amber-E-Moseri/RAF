import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { ApiError } from "../api/client";
import { createIncome } from "../api/incomeApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingSpinner } from "../components/feedback/LoadingSpinner";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { MoneyInput } from "../components/ui/MoneyInput";
import { Table } from "../components/ui/Table";
import { useAsyncData } from "../hooks/useAsyncData";
import { formatIsoDate } from "../lib/format";
import { Money } from "../components/ui/Money";
import { normalizeMoneyInput, validateIsoDate, validatePositiveMoney, validateRequiredText } from "../lib/validation";
import type { AllocationCategory, IncomeCreateResponse } from "../lib/types";

const initialForm = {
  sourceName: "",
  amount: "",
  receivedDate: "",
  notes: "",
};

export function AddIncome() {
  const [form, setForm] = useState(initialForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<IncomeCreateResponse | null>(null);
  const { data: categories, error: categoriesError, isLoading: categoriesLoading, reload: reloadCategories } = useAsyncData<AllocationCategory[]>(async () => {
    try {
      return await getAllocationCategories();
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 404) {
        return [];
      }

      throw loadError;
    }
  }, []);

  function validateForm() {
    const nextErrors = {
      sourceName: validateRequiredText(form.sourceName, "Source name"),
      amount: validatePositiveMoney(form.amount, "Amount"),
      receivedDate: validateIsoDate(form.receivedDate, "Received date"),
    };

    setFieldErrors(nextErrors);
    return !Object.values(nextErrors).some(Boolean);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateForm()) {
      setError(null);
      setSuccess(null);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const normalizedAmount = normalizeMoneyInput(form.amount);
      const response = await createIncome(
        {
          sourceName: form.sourceName.trim(),
          amount: normalizedAmount ?? form.amount,
          receivedDate: form.receivedDate,
          notes: form.notes.trim() || undefined,
        },
        crypto.randomUUID(),
      );

      setSuccess(response);
      setForm(initialForm);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Income could not be created.");
      setSuccess(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <PageShell
      eyebrow="Income"
      title="Add Income"
      description="Record income and see how NOMI splits it."
      actions={<Link className="text-sm font-semibold text-raf-moss" to="/dashboard">Back to Dashboard</Link>}
    >
      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <Card title="New Deposit" subtitle="Record income when it actually arrives.">
          <form className="space-y-4" onSubmit={handleSubmit}>
            <Input
              label="Source name"
              name="sourceName"
              placeholder="Payroll"
              required
              error={fieldErrors.sourceName}
              value={form.sourceName}
              onBlur={() => setFieldErrors((current) => ({ ...current, sourceName: validateRequiredText(form.sourceName, "Source name") }))}
              onChange={(event) => {
                setForm((current) => ({ ...current, sourceName: event.target.value }));
                setFieldErrors((current) => ({ ...current, sourceName: null }));
              }}
            />
            <MoneyInput
              label="Amount"
              name="amount"
              placeholder="5000.00"
              error={fieldErrors.amount}
              disabled={isSubmitting}
              value={form.amount}
              onBlur={() => setFieldErrors((current) => ({ ...current, amount: validatePositiveMoney(form.amount, "Amount") }))}
              onChange={(value) => {
                setForm((current) => ({ ...current, amount: value }));
                setFieldErrors((current) => ({ ...current, amount: null }));
              }}
            />
            <Input
              label="Received date"
              name="receivedDate"
              type="date"
              required
              error={fieldErrors.receivedDate}
              value={form.receivedDate}
              onBlur={() => setFieldErrors((current) => ({ ...current, receivedDate: validateIsoDate(form.receivedDate, "Received date") }))}
              onChange={(event) => {
                setForm((current) => ({ ...current, receivedDate: event.target.value }));
                setFieldErrors((current) => ({ ...current, receivedDate: null }));
              }}
            />
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Notes</span>
              <textarea
                className="ui-field min-h-28 resize-y"
                name="notes"
                placeholder="Optional context for this deposit"
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting ? <LoadingSpinner inline size="sm" label="Recording deposit..." /> : "Create income"}
              </Button>
              <Button
                disabled={isSubmitting}
                type="button"
                variant="secondary"
                onClick={() => {
                  setForm(initialForm);
                  setError(null);
                  setSuccess(null);
                }}
              >
                Reset
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-6">
          <Card
            title={success ? "Current Allocation Preferences + Deposit Allocation" : "Current Allocation Preferences"}
            subtitle={success ? "This deposit was split using the active percentages saved for its received date." : "Your current active percentages."}
          >
            {success ? (
              <div className="mb-4">
                <SuccessNotice
                  title="Deposit recorded"
                  message="Allocated amounts below show the saved split for this deposit."
                />
              </div>
            ) : null}
            {categoriesLoading ? <LoadingState label="Loading allocation preferences..." /> : null}
            {!categoriesLoading && categoriesError ? <ErrorState title="Failed to load allocation preferences" message={categoriesError} onRetry={() => void reloadCategories()} /> : null}
            {!categoriesLoading && !categoriesError && categories?.length ? (
              <Table headers={success ? ["Category", "Percentage", "Allocated Amount", "Status"] : ["Category", "Percentage", "Status"]}>
                {categories.map((category) => {
                  const allocation = success?.allocations.find((item) => item.slug === category.slug);
                  return (
                  <tr key={category.id}>
                    <td className="px-4 py-3 text-sm font-medium text-[var(--text-strong)]">{category.label}</td>
                    <td className="px-4 py-3 text-sm text-[var(--text-muted)]">{(Number(category.allocationPercent) * 100).toFixed(2)}%</td>
                    {success ? (
                      <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                        {allocation ? <Money value={allocation.amount} /> : "Not allocated in this deposit"}
                      </td>
                    ) : null}
                    <td className="px-4 py-3 text-sm text-[var(--text-muted)]">{category.isActive ? "Active" : "Inactive"}</td>
                  </tr>
                  );
                })}
              </Table>
            ) : null}
            {!categoriesLoading && !categoriesError && !categories?.length ? (
              <EmptyState
                title="Categories unavailable"
                message="Set up categories before recording deposits that need an allocation split."
              />
            ) : null}
          </Card>
          {error ? <ErrorState title="Failed to record income" message={error} /> : null}
          {success ? (
            <Card title="Next step" subtitle="Income is recorded — now track where it goes.">
              <div className="space-y-3">
                <Link
                  to="/transactions"
                  className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border-color)] px-4 py-3 transition hover:bg-[var(--surface-elevated)]"
                >
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-strong)]">Record transactions</div>
                    <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">Log spending so your allocations stay accurate.</div>
                  </div>
                  <span className="shrink-0 text-[var(--primary-color)]">→</span>
                </Link>
                <Link
                  to="/monthly-review"
                  className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border-color)] px-4 py-3 transition hover:bg-[var(--surface-elevated)]"
                >
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-strong)]">Monthly Review</div>
                    <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">Close the month and distribute surplus when ready.</div>
                  </div>
                  <span className="shrink-0 text-[var(--primary-color)]">→</span>
                </Link>
              </div>
            </Card>
          ) : (
            <Card title="What happens next" subtitle="NOMI allocates each deposit from your saved category plan.">
              <ul className="space-y-3 text-sm text-[var(--text-muted)]">
                <li>NOMI records the deposit for the selected date.</li>
                <li>NOMI creates a saved allocation snapshot automatically.</li>
                <li>NOMI uses the active percentages saved for the deposit date, with any rounding cent routed to Buffer when it is active.</li>
                <li>The allocation shown here is the saved result for this deposit.</li>
                <li>Use today&apos;s date in ISO format, for example {formatIsoDate(new Date().toISOString())}.</li>
              </ul>
            </Card>
          )}
        </div>
      </section>
    </PageShell>
  );
}
