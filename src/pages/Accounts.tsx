import { useState } from "react";

import {
  createAccountReconciliation,
  createFinancialAccount,
  getFinancialAccounts,
  resolveAccountReconciliation,
} from "../api/accountsApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Money } from "../components/ui/Money";
import { useAsyncData } from "../hooks/useAsyncData";
import type { FinancialAccount } from "../lib/types";

const ACCOUNT_TYPES: Array<{ value: FinancialAccount["account_type"]; label: string }> = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "investment", label: "Investment" },
  { value: "cash", label: "Cash" },
  { value: "loan", label: "Loan" },
  { value: "line_of_credit", label: "Line of Credit" },
  { value: "other", label: "Other" },
];

interface AccountFormState {
  name: string;
  account_type: FinancialAccount["account_type"];
  current_balance: string;
  currency: string;
}

const EMPTY_FORM: AccountFormState = {
  name: "",
  account_type: "checking",
  current_balance: "",
  currency: "CAD",
};

function accountTypeBadgeTone(accountType: string): "success" | "warning" | "neutral" {
  if (["checking", "savings", "cash"].includes(accountType)) return "success";
  if (["credit_card", "line_of_credit", "loan"].includes(accountType)) return "warning";
  return "neutral";
}

function accountTypeLabel(accountType: string) {
  return ACCOUNT_TYPES.find((t) => t.value === accountType)?.label ?? accountType.replace(/_/g, " ");
}

function isLiability(account: FinancialAccount) {
  return ["credit_card", "line_of_credit", "loan"].includes(account.account_type) || Number(account.current_balance) < 0;
}

export function Accounts() {
  const { data, error, isLoading, reload } = useAsyncData(() => getFinancialAccounts(), []);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AccountFormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [reconcileId, setReconcileId] = useState<string | null>(null);
  const [reconcileBalance, setReconcileBalance] = useState("");
  const [reconcileNote, setReconcileNote] = useState("");
  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  const accounts = data?.items ?? [];
  const assets = accounts
    .filter((a) => !isLiability(a))
    .reduce((sum, a) => sum + Number(a.current_balance), 0);
  const liabilities = accounts
    .filter((a) => isLiability(a))
    .reduce((sum, a) => sum + Math.abs(Number(a.current_balance)), 0);
  const netPosition = assets - liabilities;

  async function handleCreateAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !form.current_balance.trim()) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await createFinancialAccount({
        name: form.name.trim(),
        account_type: form.account_type,
        current_balance: form.current_balance.trim(),
        currency: form.currency,
        balance_as_of: new Date().toISOString().slice(0, 10),
        is_manual: true,
      });
      setSaveMessage("Account added.");
      setForm(EMPTY_FORM);
      setShowForm(false);
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Account could not be created.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleReconcile(event: React.FormEvent) {
    event.preventDefault();
    if (!reconcileId || !reconcileBalance.trim()) return;
    setIsReconciling(true);
    setReconcileError(null);
    try {
      const rec = await createAccountReconciliation(reconcileId, {
        reportedBalance: reconcileBalance.trim(),
        note: reconcileNote.trim() || null,
      });
      await resolveAccountReconciliation(reconcileId, rec.id, { action: "accept_reported_balance" });
      setSaveMessage("Balance reconciled.");
      setReconcileId(null);
      setReconcileBalance("");
      setReconcileNote("");
      await reload();
    } catch (err) {
      setReconcileError(err instanceof Error ? err.message : "Reconciliation could not be saved.");
    } finally {
      setIsReconciling(false);
    }
  }

  const reconcileTarget = accounts.find((a) => a.id === reconcileId) ?? null;

  return (
    <PageShell
      eyebrow="Accounts"
      title="Where your cash lives."
      description="Balances, account roles and freshness are visible separately so activity recency is never mistaken for balance certainty."
      actions={
        <Button type="button" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add account"}
        </Button>
      }
    >
      {isLoading ? <LoadingState label="Loading accounts..." /> : null}
      {!isLoading && error ? (
        <ErrorState title="Failed to load accounts" message={error} onRetry={() => void reload()} />
      ) : null}
      {saveError ? <ErrorState title="Account error" message={saveError} /> : null}
      {saveMessage ? <SuccessNotice title="Accounts updated" message={saveMessage} /> : null}

      {/* Summary KPIs */}
      {!isLoading && !error && accounts.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-3">
          <Card>
            <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Assets</p>
            <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
              <Money value={assets.toFixed(2)} />
            </p>
          </Card>
          <Card>
            <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Liabilities</p>
            <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
              <Money value={liabilities.toFixed(2)} />
            </p>
          </Card>
          <Card>
            <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Net position</p>
            <p className={`mt-2 text-[25px] font-black tracking-tight ${netPosition >= 0 ? "text-[var(--theme-accent)]" : "text-rose-600"}`}>
              <Money value={netPosition.toFixed(2)} />
            </p>
          </Card>
        </section>
      ) : null}

      {/* Add account form */}
      {showForm ? (
        <Card title="Add account" subtitle="Add a checking, savings, credit card or other financial account.">
          <form className="space-y-4" onSubmit={handleCreateAccount}>
            <Input
              label="Account name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Everyday Checking"
            />
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-strong)]">Account type</span>
                <select
                  className="ui-field"
                  value={form.account_type}
                  onChange={(e) => setForm((f) => ({ ...f, account_type: e.target.value as FinancialAccount["account_type"] }))}
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </label>
              <Input
                label="Current balance"
                value={form.current_balance}
                onChange={(e) => setForm((f) => ({ ...f, current_balance: e.target.value }))}
                placeholder="3940.00"
                inputMode="decimal"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving || !form.name.trim() || !form.current_balance.trim()}>
                {isSaving ? "Saving..." : "Add account"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* Account cards */}
      {!isLoading && !error ? (
        accounts.length > 0 ? (
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="rounded-2xl border border-[var(--border-color)] bg-[var(--surface-color)] p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[13px] font-[900] text-[var(--text-strong)]">{account.name}</h3>
                    <p className="mt-1 text-[9.5px] text-[var(--text-muted)]">{accountTypeLabel(account.account_type)}</p>
                  </div>
                  <Badge tone={accountTypeBadgeTone(account.account_type)}>
                    {accountTypeLabel(account.account_type)}
                  </Badge>
                </div>
                <p className={`mt-4 text-[22px] font-[900] tracking-tight ${Number(account.current_balance) < 0 ? "text-rose-600" : "text-[var(--text-strong)]"}`}>
                  <Money value={account.current_balance} />
                </p>
                <p className="mt-1 text-[9.5px] text-[var(--text-muted)]">
                  {account.currency} · Balance as of {account.balance_as_of}
                </p>
                <div className="mt-4 flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="flex-1 rounded-full px-3 py-1.5 text-xs min-h-8"
                    onClick={() => {
                      setReconcileId(account.id);
                      setReconcileBalance(Math.abs(Number(account.current_balance)).toFixed(2));
                      setReconcileNote("");
                      setReconcileError(null);
                    }}
                  >
                    Reconcile
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ) : (
          !showForm && (
            <EmptyState
              title="No accounts yet"
              message="Add your first financial account to track balances and cash position."
            />
          )
        )
      ) : null}

      {/* Reconcile modal */}
      {reconcileTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
          <div className="w-full max-w-md rounded-[22px] border border-[var(--border-color)] bg-[var(--surface-color)] shadow-2xl">
            <div className="flex items-start justify-between gap-4 px-6 pt-6">
              <div>
                <p className="text-[10px] font-[900] uppercase tracking-[0.1em] text-[var(--text-muted)]">Reconcile</p>
                <h2 className="mt-1 text-lg font-[900] text-[var(--text-strong)]">{reconcileTarget.name}</h2>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="min-h-8 min-w-8 rounded-full px-0 text-[var(--text-muted)]"
                onClick={() => setReconcileId(null)}
                aria-label="Close"
              >
                ×
              </Button>
            </div>
            <form onSubmit={handleReconcile}>
              <div className="space-y-4 px-6 py-5">
                <Input
                  label="Reported balance"
                  value={reconcileBalance}
                  onChange={(e) => setReconcileBalance(e.target.value)}
                  placeholder="3940.00"
                  inputMode="decimal"
                />
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Note (optional)</span>
                  <textarea
                    className="ui-field min-h-16 resize-y"
                    value={reconcileNote}
                    onChange={(e) => setReconcileNote(e.target.value)}
                    placeholder="e.g. Verified against bank statement"
                  />
                </label>
                {reconcileError ? <p className="text-sm text-rose-600">{reconcileError}</p> : null}
              </div>
              <div className="flex justify-end gap-2 rounded-b-[22px] border-t border-[var(--border-color)] bg-[var(--surface-color)] px-6 py-4">
                <Button type="button" variant="ghost" onClick={() => setReconcileId(null)}>Cancel</Button>
                <Button type="submit" disabled={isReconciling || !reconcileBalance.trim()}>
                  {isReconciling ? "Saving..." : "Confirm balance"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
