import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearTransactionSplits,
  getTransactionSplits,
  setTransactionSplits,
} from "../../api/transactionsApi";
import type { AllocationCategory, Transaction, TransactionSplit, TransactionSplitDraft } from "../../lib/types";
import { normalizeMoneyInput } from "../../lib/validation";
import { Money } from "../ui/Money";
import { Button } from "../ui/Button";

interface SplitTransactionEditorProps {
  transaction: Transaction;
  categories: AllocationCategory[];
  parentCategoryLabel: string;
  onSaved: () => Promise<void> | void;
  onCleared: () => Promise<void> | void;
}

interface SplitDraftRow {
  localId: string;
  categoryId: string;
  amount: string;
  description: string;
}

interface SplitValidation {
  isValid: boolean;
  totalCents: number;
  remainingCents: number;
  rowErrors: Record<string, string>;
  summary: string;
  tone: "valid" | "incomplete" | "invalid";
}

function moneyToCents(value: string | number | null | undefined) {
  const normalized = typeof value === "string" ? normalizeMoneyInput(value) : normalizeMoneyInput(String(value ?? ""));
  if (!normalized) {
    return null;
  }

  const [whole, fraction = "00"] = normalized.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function centsToMoney(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function makeRow(overrides: Partial<SplitDraftRow> = {}): SplitDraftRow {
  const randomId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  return {
    localId: randomId,
    categoryId: "",
    amount: "",
    description: "",
    ...overrides,
  };
}

export function buildInitialSplitRows(transaction: Transaction, existingSplits: TransactionSplit[]): SplitDraftRow[] {
  if (existingSplits.length) {
    return existingSplits.map((split) => makeRow({
      categoryId: split.categoryId ?? "",
      amount: split.amount,
      description: split.description ?? "",
    }));
  }

  return [
    makeRow({
      categoryId: transaction.categoryId ?? "",
      amount: transaction.amount,
      description: transaction.description,
    }),
  ];
}

export function validateSplitRows(transaction: Transaction, rows: SplitDraftRow[]): SplitValidation {
  const parentCents = moneyToCents(transaction.amount) ?? 0;
  const rowErrors: Record<string, string> = {};
  let totalCents = 0;

  if (transaction.direction !== "debit") {
    return {
      isValid: false,
      totalCents: 0,
      remainingCents: parentCents,
      rowErrors,
      summary: "Only debit transactions can be split.",
      tone: "invalid",
    };
  }

  rows.forEach((row) => {
    const cents = moneyToCents(row.amount);
    if (cents == null || cents <= 0) {
      rowErrors[row.localId] = "Enter an amount greater than $0.";
      return;
    }
    totalCents += cents;
  });

  if (rows.length < 2) {
    return {
      isValid: false,
      totalCents,
      remainingCents: parentCents - totalCents,
      rowErrors,
      summary: "Add at least one more split.",
      tone: "incomplete",
    };
  }

  if (Object.keys(rowErrors).length > 0) {
    return {
      isValid: false,
      totalCents,
      remainingCents: parentCents - totalCents,
      rowErrors,
      summary: "Every split amount must be greater than $0.",
      tone: "invalid",
    };
  }

  const remainingCents = parentCents - totalCents;
  if (remainingCents > 0) {
    return {
      isValid: false,
      totalCents,
      remainingCents,
      rowErrors,
      summary: "Split amounts are below the transaction total.",
      tone: "incomplete",
    };
  }

  if (remainingCents < 0) {
    return {
      isValid: false,
      totalCents,
      remainingCents,
      rowErrors,
      summary: "Split amounts are above the transaction total.",
      tone: "invalid",
    };
  }

  return {
    isValid: true,
    totalCents,
    remainingCents: 0,
    rowErrors,
    summary: "Split amounts match the transaction total.",
    tone: "valid",
  };
}

function validationToneClass(tone: SplitValidation["tone"]) {
  if (tone === "valid") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (tone === "invalid") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function toPayload(rows: SplitDraftRow[]): TransactionSplitDraft[] {
  return rows.map((row) => ({
    categoryId: row.categoryId || null,
    amount: normalizeMoneyInput(row.amount) ?? row.amount,
    description: row.description.trim(),
  }));
}

export function SplitTransactionEditor({
  transaction,
  categories,
  parentCategoryLabel,
  onSaved,
  onCleared,
}: SplitTransactionEditorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [existingSplits, setExistingSplits] = useState<TransactionSplit[]>([]);
  const [rows, setRows] = useState<SplitDraftRow[]>(() => buildInitialSplitRows(transaction, []));
  const latestRowRef = useRef<HTMLSelectElement | null>(null);

  const validation = useMemo(() => validateSplitRows(transaction, rows), [rows, transaction]);
  const canClear = existingSplits.length > 0;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setApiError(null);

    getTransactionSplits(transaction.id)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setExistingSplits(response.splits);
        setRows(buildInitialSplitRows(transaction, response.splits));
      })
      .catch((error) => {
        if (!cancelled) {
          setApiError(error instanceof Error ? error.message : "Transaction splits could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, transaction]);

  if (transaction.direction !== "debit") {
    return null;
  }

  function updateRow(localId: string, patch: Partial<SplitDraftRow>) {
    setRows((current) => current.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [...current, makeRow()]);
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => latestRowRef.current?.focus());
    }
  }

  function removeRow(localId: string) {
    setRows((current) => current.filter((row) => row.localId !== localId));
  }

  function cancelEdit() {
    setIsOpen(false);
    setApiError(null);
    setRows(buildInitialSplitRows(transaction, existingSplits));
  }

  async function saveSplits() {
    if (!validation.isValid) {
      return;
    }

    setIsSaving(true);
    setApiError(null);
    try {
      const response = await setTransactionSplits(transaction.id, toPayload(rows));
      setExistingSplits(response.splits);
      setRows(buildInitialSplitRows(transaction, response.splits));
      await onSaved();
      setIsOpen(false);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Transaction splits could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function clearSplits() {
    setIsSaving(true);
    setApiError(null);
    try {
      await clearTransactionSplits(transaction.id);
      setExistingSplits([]);
      setRows(buildInitialSplitRows(transaction, []));
      await onCleared();
      setIsOpen(false);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Transaction splits could not be cleared.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="mt-5 border-t border-[var(--border-color)] pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">Split transaction</h3>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Split categories replace the transaction's single category while this split is active.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="min-h-9 rounded-full px-3 py-1.5 text-xs"
          onClick={() => setIsOpen((current) => !current)}
        >
          {isOpen ? "Hide split editor" : "Split transaction"}
        </Button>
      </div>

      {isOpen ? (
        <div className="mt-4 rounded-xl border border-[var(--border-color)] bg-[var(--surface-plain)] p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-[var(--text-muted)]">
              Parent category: <span className="font-medium text-[var(--text-strong)]">{parentCategoryLabel || "Uncategorized"}</span>
            </span>
            <span className="font-semibold text-[var(--text-strong)]">
              Transaction total: <Money value={transaction.amount} />
            </span>
          </div>

          {isLoading ? (
            <div className="py-3 text-sm text-[var(--text-muted)]">Loading splits...</div>
          ) : (
            <div className="space-y-3">
              {rows.map((row, index) => {
                const amountErrorId = `split-amount-error-${row.localId}`;
                const hasAmountError = Boolean(validation.rowErrors[row.localId]);
                return (
                  <div
                    key={row.localId}
                    className="grid gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--surface-color)] p-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto]"
                  >
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Category</span>
                      <select
                        ref={index === rows.length - 1 ? latestRowRef : undefined}
                        className="ui-field"
                        value={row.categoryId}
                        onChange={(event) => updateRow(row.localId, { categoryId: event.target.value })}
                      >
                        <option value="">Uncategorized</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>{category.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Amount</span>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-stone-400">$</span>
                        <input
                          className="ui-field py-3 pl-8 pr-4"
                          inputMode="decimal"
                          value={row.amount}
                          aria-invalid={hasAmountError}
                          aria-describedby={hasAmountError ? amountErrorId : undefined}
                          onChange={(event) => updateRow(row.localId, { amount: event.target.value })}
                        />
                      </div>
                      {hasAmountError ? (
                        <span id={amountErrorId} className="mt-2 block text-sm leading-6 text-rose-600">
                          {validation.rowErrors[row.localId]}
                        </span>
                      ) : null}
                    </label>
                    <div className="flex items-end justify-start md:justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-10 rounded-full px-3 py-2 text-xs"
                        aria-label={`Remove split row ${index + 1}`}
                        onClick={() => removeRow(row.localId)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Button type="button" variant="secondary" className="rounded-full px-3 py-1.5 text-xs" onClick={addRow}>
              + Add split
            </Button>
            <div
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${validationToneClass(validation.tone)}`}
              role="status"
              aria-live="polite"
            >
              <span className="mr-3">Total <Money value={centsToMoney(validation.totalCents)} /></span>
              <span>
                {validation.remainingCents < 0 ? "Over by " : "Remaining "}
                <Money value={centsToMoney(Math.abs(validation.remainingCents))} />
              </span>
            </div>
          </div>

          <p className="mt-3 text-sm text-[var(--text-muted)]">{validation.summary}</p>
          {apiError ? <p className="mt-3 text-sm text-rose-600" role="alert">{apiError}</p> : null}

          <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
            {canClear ? (
              <Button type="button" variant="ghost" disabled={isSaving} onClick={() => void clearSplits()}>
                Clear split
              </Button>
            ) : null}
            <Button type="button" variant="secondary" disabled={isSaving} onClick={cancelEdit}>
              Cancel
            </Button>
            <Button type="button" disabled={!validation.isValid || isSaving || isLoading} onClick={() => void saveSplits()}>
              {isSaving ? "Saving..." : "Save split"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
