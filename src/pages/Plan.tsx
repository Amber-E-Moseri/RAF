import { Link } from "react-router-dom";
import { BufferStatusCard } from "../components/plan/BufferStatusCard";
import { PlanExecutionCard } from "../components/plan/PlanExecutionCard";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { PageShell } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Money } from "../components/ui/Money";
import { useAsyncData } from "../hooks/useAsyncData";
import { AllocationPreferences } from "./AllocationPreferences";

// ── Compact Goals summary (kept for reference but not displayed) ───────────────────────────────────────

function GoalsSummary() {
  const { data, isLoading, error } = useAsyncData(() => getGoals(), []);
  const activeGoals = (data?.items ?? []).filter((g) => g.active !== false);

  if (isLoading) return <LoadingState label="Loading goals..." />;
  if (error) return <ErrorState title="Failed to load goals" message={error} />;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-3">
        <Card>
          <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Active goals</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">{activeGoals.length}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Total targets</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
            <Money value={String(activeGoals.reduce((sum, g) => sum + Number(g.target_amount || "0"), 0).toFixed(2))} />
          </p>
        </Card>
        <Card>
          <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Funded so far</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
            <Link to="/goals" className="text-[var(--theme-accent)] underline-offset-2 hover:underline text-[inherit] font-[inherit] text-[inherit]">
              See goals →
            </Link>
          </p>
        </Card>
      </section>

      {activeGoals.length ? (
        <div className="space-y-2">
          {activeGoals.slice(0, 6).map((goal) => (
            <div
              key={goal.id}
              className="flex items-center gap-3 rounded-xl border border-[var(--border-color)] px-4 py-3"
              style={{ background: "var(--surface-plain)" }}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--text-strong)]">{goal.name}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  Target: <Money value={goal.target_amount} />
                  {goal.target_date ? ` · Due ${goal.target_date}` : ""}
                </p>
              </div>
              <Badge tone="neutral">{goal.active !== false ? "Active" : "Archived"}</Badge>
            </div>
          ))}
          {activeGoals.length > 6 ? (
            <p className="text-center text-xs text-[var(--text-muted)]">+{activeGoals.length - 6} more</p>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="No active goals"
          message="Create a goal on the Goals page to track your savings targets."
        />
      )}

      <div className="flex justify-end">
        <Link
          to="/goals"
          className="inline-flex min-h-[38px] items-center rounded-[11px] bg-[var(--theme-primary)] px-[13px] text-[11.5px] font-semibold text-white transition hover:opacity-90"
        >
          Manage goals →
        </Link>
      </div>
    </div>
  );
}

// ── Compact Debts summary for Plan tab ───────────────────────────────────────

function DebtsSummary() {
  const { data, isLoading, error } = useAsyncData(() => getDebts(), []);
  const activeDebts = (data?.items ?? []).filter((d) => d.isActive !== false);

  if (isLoading) return <LoadingState label="Loading debts..." />;
  if (error) return <ErrorState title="Failed to load debts" message={error} />;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-3">
        <Card>
          <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Remaining balance</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
            <Money value={data?.summary.totalRemaining ?? "0.00"} />
          </p>
        </Card>
        <Card>
          <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Active debts</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">{activeDebts.length}</p>
        </Card>
        <Card>
          <p className="text-[10px] font-[850] uppercase tracking-[0.1em] text-[var(--text-muted)]">Paid all time</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
            <Money value={data?.summary.totalPaidAllTime ?? "0.00"} />
          </p>
        </Card>
      </section>

      {activeDebts.length ? (
        <div className="space-y-2">
          {activeDebts.slice(0, 6).map((debt) => (
            <div
              key={debt.id}
              className="flex items-center gap-3 rounded-xl border border-[var(--border-color)] px-4 py-3"
              style={{ background: "var(--surface-plain)" }}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--text-strong)]">{debt.name}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  Balance: <Money value={debt.currentBalance} /> · APR {debt.apr}%
                  {debt.monthlyPayment ? ` · Planned: $${debt.monthlyPayment}/mo` : ""}
                </p>
              </div>
              <Badge tone={debt.status === "paid_off" ? "success" : "neutral"}>
                {debt.status === "paid_off" ? "Paid off" : "Open"}
              </Badge>
            </div>
          ))}
          {activeDebts.length > 6 ? (
            <p className="text-center text-xs text-[var(--text-muted)]">+{activeDebts.length - 6} more</p>
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="No active debts"
          message="Add a debt on the Debts page to track its payment plan and payoff progress."
        />
      )}

      <div className="flex justify-end">
        <Link
          to="/debts"
          className="inline-flex min-h-[38px] items-center rounded-[11px] bg-[var(--theme-primary)] px-[13px] text-[11.5px] font-semibold text-white transition hover:opacity-90"
        >
          Manage debts →
        </Link>
      </div>
    </div>
  );
}

// ── Plan page ────────────────────────────────────────────────────────────────

export function Plan() {
  return (
    <PageShell
      eyebrow="Plan"
      title="Allocation without noise."
      description="Adjust allocation preferences, track goal progress, and manage debts — without turning RAF into a traditional budgeting app."
    >
      <AllocationPreferences />
      <PlanExecutionCard />

      <BufferStatusCard />
    </PageShell>
  );
}
