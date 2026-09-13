import { useState } from "react";
import type { FormEvent } from "react";

import { getAllocationCategories } from "../../api/allocationCategoriesApi";
import { ApiError } from "../../api/client";
import { createIncome } from "../../api/incomeApi";
import { ErrorState } from "../feedback/ErrorState";
import { LoadingSpinner } from "../feedback/LoadingSpinner";
import { LoadingState } from "../feedback/LoadingState";
import { SuccessNotice } from "../feedback/SuccessNotice";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { MoneyInput } from "../ui/MoneyInput";
import { useAsyncData } from "../../hooks/useAsyncData";
import { normalizeMoneyInput, validateIsoDate, validatePositiveMoney, validateRequiredText } from "../../lib/validation";
import type { IncomeCreateResponse } from "../../lib/types";

const initialForm = {
  sourceName: "",
  amount: "",
  receivedDate: "",
  notes: "",
};

export function IncomeModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [form, setForm] = useState(initialForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<IncomeCreateResponse | null>(null);

  const { isLoading: categoriesLoading } = useAsyncData(async () => {
    try { return await getAllocationCategories(); } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }, []);

  function reset() {
    setForm(initialForm);
    setFieldErrors({});
    setError(null);
    setSuccess(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function validate() {
    const next = {
      sourceName: validateRequiredText(form.sourceName, "Source name"),
      amount: validatePositiveMoney(form.amount, "Amount"),
      receivedDate: validateIsoDate(form.receivedDate, "Received date"),
    };
    setFieldErrors(next);
    return !Object.values(next).some(Boolean);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate()) { setError(null); setSuccess(null); return; }
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await createIncome(
        {
          sourceName: form.sourceName.trim(),
          amount: normalizeMoneyInput(form.amount) ?? form.amount,
          receivedDate: form.receivedDate,
          notes: form.notes.trim() || undefined,
        },
        crypto.randomUUID(),
      );
      setSuccess(response);
      setForm(initialForm);
      onSuccess?.();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Income could not be created.");
      setSuccess(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
      <div
        className="w-full max-w-lg rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-[0_28px_70px_rgba(15,23,42,0.28)]"
        style={{ background: "var(--surface-color)" }}
      >
        <div className="mb-4 flex items-start justify-between gap-4 border-b border-[var(--border-color)] pb-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-strong)]">Add Income</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Record a deposit. RAF splits it using your active category percentages.</p>
          </div>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-color)] text-base text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]"
            aria-label="Close"
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        {success ? (
          <div className="space-y-4">
            <SuccessNotice title="Deposit recorded" message="Income has been recorded and allocated." />
            <div className="flex gap-3">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setSuccess(null)}>Add another</Button>
              <Button type="button" className="flex-1" onClick={handleClose}>Done</Button>
            </div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
            {categoriesLoading ? <LoadingState label="Loading categories..." /> : null}
            {error ? <ErrorState title="Failed to record income" message={error} /> : null}

            <Input
              label="Source name"
              name="sourceName"
              placeholder="Payroll"
              required
              error={fieldErrors.sourceName}
              value={form.sourceName}
              onBlur={() => setFieldErrors((c) => ({ ...c, sourceName: validateRequiredText(form.sourceName, "Source name") }))}
              onChange={(e) => { setForm((c) => ({ ...c, sourceName: e.target.value })); setFieldErrors((c) => ({ ...c, sourceName: null })); }}
            />
            <MoneyInput
              label="Amount"
              name="amount"
              placeholder="5000.00"
              error={fieldErrors.amount}
              disabled={isSubmitting}
              value={form.amount}
              onBlur={() => setFieldErrors((c) => ({ ...c, amount: validatePositiveMoney(form.amount, "Amount") }))}
              onChange={(value) => { setForm((c) => ({ ...c, amount: value })); setFieldErrors((c) => ({ ...c, amount: null })); }}
            />
            <Input
              label="Received date"
              name="receivedDate"
              type="date"
              required
              error={fieldErrors.receivedDate}
              value={form.receivedDate}
              onBlur={() => setFieldErrors((c) => ({ ...c, receivedDate: validateIsoDate(form.receivedDate, "Received date") }))}
              onChange={(e) => { setForm((c) => ({ ...c, receivedDate: e.target.value })); setFieldErrors((c) => ({ ...c, receivedDate: null })); }}
            />
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Notes</span>
              <textarea
                className="ui-field min-h-20 resize-y"
                name="notes"
                placeholder="Optional context for this deposit"
                value={form.notes}
                onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))}
              />
            </label>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting ? <LoadingSpinner inline size="sm" label="Recording..." /> : "Create income"}
              </Button>
              <Button type="button" variant="secondary" disabled={isSubmitting} onClick={handleClose}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
