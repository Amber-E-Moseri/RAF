import { useState } from "react";
import { createIncome } from "../../api/incomeApi";
import { ErrorState } from "../feedback/ErrorState";
import { LoadingSpinner } from "../feedback/LoadingSpinner";
import { SuccessNotice } from "../feedback/SuccessNotice";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { MoneyInput } from "../ui/MoneyInput";

interface IncomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface IncomeForm {
  sourceName: string;
  amount: string;
  receivedDate: string;
  notes: string;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): IncomeForm {
  return { sourceName: "", amount: "", receivedDate: todayIso(), notes: "" };
}

export function IncomeModal({ isOpen, onClose, onSuccess }: IncomeModalProps) {
  const [form, setForm] = useState<IncomeForm>(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  if (!isOpen) {
    return null;
  }

  function handleField(field: keyof IncomeForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setSubmitError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.sourceName.trim() || !form.amount || !form.receivedDate) {
      setSubmitError("Source, amount, and date are required.");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await createIncome(
        { sourceName: form.sourceName, amount: form.amount, receivedDate: form.receivedDate, notes: form.notes || undefined },
        crypto.randomUUID(),
      );
      setSucceeded(true);
      onSuccess?.();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to record income. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleAddAnother() {
    setForm(emptyForm());
    setSucceeded(false);
    setSubmitError(null);
  }

  function handleClose() {
    setForm(emptyForm());
    setSucceeded(false);
    setSubmitError(null);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 px-3 py-4 sm:items-center"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        aria-labelledby="income-modal-title"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-5 shadow-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="income-modal-title" className="text-base font-semibold text-[var(--text-strong)]">
            Add Income
          </h2>
          <button
            type="button"
            aria-label="Close add income"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-color)] text-sm font-semibold text-[var(--text-muted)] hover:bg-[var(--surface-plain)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-color)]"
            onClick={handleClose}
          >
            ✕
          </button>
        </div>

        {succeeded ? (
          <div className="mt-4 space-y-4">
            <SuccessNotice title="Income recorded" message="Your income has been logged and allocations have been calculated." />
            <div className="flex flex-wrap gap-2 justify-end">
              <Button type="button" variant="secondary" onClick={handleAddAnother}>
                Add another
              </Button>
              <Button type="button" onClick={handleClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(e) => void handleSubmit(e)}>
            <Input
              label="Source"
              name="sourceName"
              placeholder="e.g. Paycheck, Freelance"
              value={form.sourceName}
              onChange={(e) => handleField("sourceName", e.target.value)}
              required
            />
            <MoneyInput
              label="Amount"
              name="amount"
              value={form.amount}
              onChange={(value) => handleField("amount", value)}
            />
            <Input
              label="Date received"
              name="receivedDate"
              type="date"
              value={form.receivedDate}
              onChange={(e) => handleField("receivedDate", e.target.value)}
              required
            />
            <Input
              label="Notes (optional)"
              name="notes"
              value={form.notes}
              onChange={(e) => handleField("notes", e.target.value)}
            />
            {submitError ? (
              <p className="text-[12px] italic text-rose-500">{submitError}</p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={handleClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <LoadingSpinner /> : "Add income"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
