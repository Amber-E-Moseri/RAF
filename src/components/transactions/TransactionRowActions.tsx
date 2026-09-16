import type { Debt, Goal } from "../../lib/types";

export interface QuickLinkState {
  txId: string;
  kind: "goal" | "debt";
}

interface TransactionRowActionsProps {
  transaction: { id: string; linkedGoalId: string | null; linkedDebtId: string | null };
  goals: Goal[];
  debts: Debt[];
  openQuickLink: QuickLinkState | null;
  isLinking: boolean;
  onOpenChange: (next: QuickLinkState | null) => void;
  onLink: (txId: string, kind: "goal" | "debt", linkedId: string) => Promise<void>;
}

export function TransactionRowActions({
  transaction,
  goals,
  debts,
  openQuickLink,
  isLinking,
  onOpenChange,
  onLink,
}: TransactionRowActionsProps) {
  if (goals.length === 0 && debts.length === 0) {
    return null;
  }

  const goalOpen = openQuickLink?.txId === transaction.id && openQuickLink.kind === "goal";
  const debtOpen = openQuickLink?.txId === transaction.id && openQuickLink.kind === "debt";

  function toggleGoal() {
    onOpenChange(goalOpen ? null : { txId: transaction.id, kind: "goal" });
  }

  function toggleDebt() {
    onOpenChange(debtOpen ? null : { txId: transaction.id, kind: "debt" });
  }

  return (
    <div className="flex items-center gap-1">
      {goals.length > 0 ? (
        <div className="relative">
          <button
            type="button"
            disabled={isLinking}
            className="rounded-full border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] disabled:opacity-50"
            onClick={toggleGoal}
          >
            {transaction.linkedGoalId ? "✓ Goal" : "+ Goal"}
          </button>
          {goalOpen ? (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-[var(--border-color)] bg-[var(--surface-color)] shadow-lg">
              <div className="p-1">
                {transaction.linkedGoalId ? (
                  <button
                    key="__unlink"
                    type="button"
                    className="block w-full rounded-lg px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-[var(--surface-plain)]"
                    onClick={() => void onLink(transaction.id, "goal", "").then(() => onOpenChange(null))}
                  >
                    Remove goal link
                  </button>
                ) : null}
                {goals.map((goal) => (
                  <button
                    key={goal.id}
                    type="button"
                    className="block w-full rounded-lg px-3 py-1.5 text-left text-xs text-[var(--text-strong)] hover:bg-[var(--surface-plain)]"
                    onClick={() => void onLink(transaction.id, "goal", goal.id)}
                  >
                    {goal.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {debts.length > 0 ? (
        <div className="relative">
          <button
            type="button"
            disabled={isLinking}
            className="rounded-full border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:bg-[var(--surface-plain)] disabled:opacity-50"
            onClick={toggleDebt}
          >
            {transaction.linkedDebtId ? "✓ Debt" : "+ Debt"}
          </button>
          {debtOpen ? (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-[var(--border-color)] bg-[var(--surface-color)] shadow-lg">
              <div className="p-1">
                {transaction.linkedDebtId ? (
                  <button
                    key="__unlink"
                    type="button"
                    className="block w-full rounded-lg px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-[var(--surface-plain)]"
                    onClick={() => void onLink(transaction.id, "debt", "").then(() => onOpenChange(null))}
                  >
                    Remove debt link
                  </button>
                ) : null}
                {debts.map((debt) => (
                  <button
                    key={debt.id}
                    type="button"
                    className="block w-full rounded-lg px-3 py-1.5 text-left text-xs text-[var(--text-strong)] hover:bg-[var(--surface-plain)]"
                    onClick={() => void onLink(transaction.id, "debt", debt.id)}
                  >
                    {debt.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
