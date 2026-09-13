import { useState } from "react";
import { PageShell } from "../components/layout/PageShell";
import {
  previewScenario,
  getScenarioChangeSet,
  applyScenario as applyScenarioApi,
  type Scenario,
  type ScenarioPreviewResponse,
  type ChangeSetEntry,
  type ScenarioApplyResponse,
} from "../api/scenariosApi";
import { ApiError } from "../api/client";
import { useAsyncData } from "../hooks/useAsyncData";
import { getJson } from "../api/client";

interface HouseholdDebt {
  id: string;
  name: string;
  current_balance: string;
  minimum_payment: string;
  apr: string;
}

interface HouseholdGoal {
  id: string;
  goal_name?: string;
  name?: string;
  target_amount: string;
  reserved_amount?: string;
}

interface HouseholdAllocation {
  id: string;
  slug: string;
  label: string;
  allocationPercent: string;
  isBuffer: boolean;
}

const SCENARIO_TYPES = [
  { type: "extra_debt_payment", label: "Extra Debt Payment", icon: "💳", description: "Pay extra toward a debt each month" },
  { type: "expense_increase", label: "Expense Increase", icon: "📈", description: "Add or increase a fixed bill" },
  { type: "income_drop", label: "Income Drop", icon: "📉", description: "Model a % reduction in monthly income" },
  { type: "goal_savings", label: "Goal Savings", icon: "🎯", description: "Set a monthly contribution toward a goal" },
  { type: "one_time_purchase", label: "One-time Purchase", icon: "🛍️", description: "A large one-time expense" },
  { type: "surplus_redirect", label: "Surplus Redirect", icon: "↗️", description: "Move surplus dollars to an allocation" },
  { type: "emergency_floor_change", label: "Buffer Change", icon: "🛡️", description: "Adjust emergency buffer allocation %" },
] as const;

function MetricCard({ label, value, delta }: { label: string; value: string; delta?: { formatted: string; cents: number } }) {
  const positive = (delta?.cents ?? 0) > 0;
  const negative = (delta?.cents ?? 0) < 0;
  return (
    <div
      className="rounded-[1.25rem] border border-[var(--border-subtle)] p-4"
      style={{ background: "var(--surface-elevated)" }}
    >
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-lg font-bold text-[var(--text-strong)]">{value}</p>
      {delta && delta.cents !== 0 && (
        <p
          className="mt-0.5 text-[12px] font-semibold"
          style={{ color: positive ? "var(--badge-success-text)" : negative ? "var(--badge-danger-text)" : "var(--text-muted)" }}
        >
          {delta.formatted}
        </p>
      )}
    </div>
  );
}

function ChangeSetCard({
  changeSet,
  onConfirm,
  onCancel,
  applying,
}: {
  changeSet: ChangeSetEntry[];
  onConfirm: () => void;
  onCancel: () => void;
  applying: boolean;
}) {
  return (
    <div
      className="rounded-[1.25rem] border border-[var(--border-color)] p-5"
      style={{ background: "var(--surface-elevated)" }}
    >
      <p className="mb-3 text-[13px] font-semibold text-[var(--text-strong)]">Changes to apply</p>
      {changeSet.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No persistent changes — this scenario is read-only (e.g. income drop).</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {changeSet.map((c, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-[var(--primary-color)]">•</span>
              <span className="text-[var(--text-primary)]">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={applying}
          className="rounded-full px-5 py-2 text-[13px] font-semibold transition disabled:opacity-50"
          style={{ background: "var(--primary-color)", color: "var(--primary-contrast)" }}
        >
          {applying ? "Applying…" : changeSet.length === 0 ? "Dismiss" : "Confirm & Apply"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={applying}
          className="rounded-full border border-[var(--border-color)] px-5 py-2 text-[13px] font-semibold text-[var(--text-secondary)] transition hover:border-[var(--primary-color)] hover:text-[var(--primary-color)] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CashFlowBar({ months }: { months: ScenarioPreviewResponse["current"]["cashFlow12m"] }) {
  const values = months.map((m) => parseFloat(m.surplus.replace(/[^0-9.-]/g, "")));
  const max = Math.max(...values.map(Math.abs), 1);
  return (
    <div>
      <p className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">12-Month Surplus Projection</p>
      <div className="flex items-end gap-1 h-16">
        {values.map((v, i) => {
          const pct = Math.abs(v) / max;
          const positive = v >= 0;
          return (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-0.5">
              <div
                style={{
                  height: `${Math.max(pct * 56, 2)}px`,
                  background: positive ? "var(--primary-color)" : "var(--badge-danger-bg)",
                  borderRadius: "3px 3px 0 0",
                  opacity: 0.85,
                  width: "100%",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>Mo 1</span>
        <span>Mo 12</span>
      </div>
    </div>
  );
}

export function Scenarios({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: debts } = useAsyncData<HouseholdDebt[]>(() => getJson("/debts"), []);
  const { data: goals } = useAsyncData<{ goals: HouseholdGoal[] }>(() => getJson("/goals"), []);
  const { data: allocations } = useAsyncData<{ categories: HouseholdAllocation[] }>(
    () => getJson("/allocation-preferences"),
    [],
  );

  const [scenarioType, setScenarioType] = useState<string>("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ScenarioPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [changeSet, setChangeSet] = useState<ChangeSetEntry[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ScenarioApplyResponse | null>(null);

  function buildScenario(): Scenario | null {
    if (!scenarioType) return null;
    const s: Scenario = { type: scenarioType as Scenario["type"] };
    if (scenarioType === "extra_debt_payment") {
      if (!params.debtId || !params.extraAmount) return null;
      s.debtId = params.debtId;
      s.extraAmountCents = Math.round(parseFloat(params.extraAmount) * 100);
    } else if (scenarioType === "expense_increase") {
      if (params.percentIncrease) {
        s.percentIncrease = parseFloat(params.percentIncrease);
      } else if (params.amount) {
        s.name = params.name || "New Expense";
        s.amountCents = Math.round(parseFloat(params.amount) * 100);
      } else {
        return null;
      }
    } else if (scenarioType === "income_drop") {
      if (!params.percentDrop) return null;
      s.percentDrop = parseFloat(params.percentDrop);
    } else if (scenarioType === "goal_savings") {
      if (!params.goalId || !params.monthlyContribution) return null;
      s.goalId = params.goalId;
      s.monthlyContributionCents = Math.round(parseFloat(params.monthlyContribution) * 100);
    } else if (scenarioType === "one_time_purchase") {
      if (!params.amount) return null;
      s.name = params.name || "Purchase";
      s.amountCents = Math.round(parseFloat(params.amount) * 100);
    } else if (scenarioType === "surplus_redirect") {
      if (!params.targetSlug || !params.amount) return null;
      s.targetSlug = params.targetSlug;
      s.amountCents = Math.round(parseFloat(params.amount) * 100);
    } else if (scenarioType === "emergency_floor_change") {
      if (!params.newBufferPct) return null;
      s.newBufferPct = parseFloat(params.newBufferPct);
    }
    return s;
  }

  async function runPreview() {
    const scenario = buildScenario();
    if (!scenario) {
      setError("Fill in all required fields.");
      return;
    }
    setLoading(true);
    setError(null);
    setPreview(null);
    setChangeSet(null);
    setApplyResult(null);
    try {
      const res = await previewScenario(scenario);
      setPreview(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run preview.");
    } finally {
      setLoading(false);
    }
  }

  async function requestApply() {
    const scenario = buildScenario();
    if (!scenario) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getScenarioChangeSet(scenario);
      setChangeSet(res.changeSet ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not generate change set.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmApply() {
    const scenario = buildScenario();
    if (!scenario) return;
    setApplying(true);
    try {
      const res = await applyScenarioApi(scenario);
      setApplyResult(res);
      setChangeSet(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Apply failed.");
    } finally {
      setApplying(false);
    }
  }

  const debtList = debts ?? [];
  const goalList = goals?.goals ?? [];
  const allocationList = (allocations?.categories ?? []).filter((a: HouseholdAllocation) => !a.isBuffer);

  const selectedType = SCENARIO_TYPES.find((t) => t.type === scenarioType);

  return (
    <PageShell title="Scenarios" description="Test financial what-ifs without changing your plan" embedded={embedded}>
      <div className="space-y-6">
        {/* Scenario picker */}
        <div>
          <p className="mb-3 text-[13px] font-semibold text-[var(--text-secondary)]">Choose a scenario type</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {SCENARIO_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => {
                  setScenarioType(t.type);
                  setParams({});
                  setPreview(null);
                  setChangeSet(null);
                  setApplyResult(null);
                  setError(null);
                }}
                className={`rounded-[1.1rem] border p-3 text-left transition ${
                  scenarioType === t.type
                    ? "border-[var(--primary-color)] bg-[var(--primary-color)] text-[var(--primary-contrast)]"
                    : "border-[var(--border-color)] text-[var(--text-primary)] hover:border-[var(--primary-color)]"
                }`}
                style={scenarioType === t.type ? {} : { background: "var(--surface-elevated)" }}
              >
                <span className="block text-lg">{t.icon}</span>
                <span className="mt-1 block text-[12px] font-semibold">{t.label}</span>
                <span
                  className="mt-0.5 block text-[11px] leading-snug"
                  style={{
                    color: scenarioType === t.type ? "var(--primary-contrast)" : "var(--text-muted)",
                    opacity: 0.85,
                  }}
                >
                  {t.description}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Scenario form */}
        {scenarioType && (
          <div
            className="rounded-[1.25rem] border border-[var(--border-subtle)] p-5 space-y-4"
            style={{ background: "var(--surface-elevated)" }}
          >
            <p className="text-[13px] font-semibold text-[var(--text-strong)]">
              {selectedType?.icon} {selectedType?.label}
            </p>

            {scenarioType === "extra_debt_payment" && (
              <>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Debt</label>
                  <select
                    className="ui-field"
                    value={params.debtId ?? ""}
                    onChange={(e) => setParams({ ...params, debtId: e.target.value })}
                  >
                    <option value="">Select a debt…</option>
                    {debtList.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} (bal: ${d.current_balance})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Extra monthly payment ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="10"
                    className="ui-field"
                    placeholder="e.g. 200"
                    value={params.extraAmount ?? ""}
                    onChange={(e) => setParams({ ...params, extraAmount: e.target.value })}
                  />
                </div>
              </>
            )}

            {scenarioType === "expense_increase" && (
              <>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">
                    Increase all bills by % (leave blank to add a new expense)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    className="ui-field"
                    placeholder="e.g. 10"
                    value={params.percentIncrease ?? ""}
                    onChange={(e) => setParams({ ...params, percentIncrease: e.target.value })}
                  />
                </div>
                {!params.percentIncrease && (
                  <>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Expense name</label>
                      <input
                        type="text"
                        className="ui-field"
                        placeholder="e.g. New subscription"
                        value={params.name ?? ""}
                        onChange={(e) => setParams({ ...params, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Monthly amount ($)</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        className="ui-field"
                        placeholder="e.g. 150"
                        value={params.amount ?? ""}
                        onChange={(e) => setParams({ ...params, amount: e.target.value })}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {scenarioType === "income_drop" && (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Income reduction (%)</label>
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  className="ui-field"
                  placeholder="e.g. 20"
                  value={params.percentDrop ?? ""}
                  onChange={(e) => setParams({ ...params, percentDrop: e.target.value })}
                />
              </div>
            )}

            {scenarioType === "goal_savings" && (
              <>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Goal</label>
                  <select
                    className="ui-field"
                    value={params.goalId ?? ""}
                    onChange={(e) => setParams({ ...params, goalId: e.target.value })}
                  >
                    <option value="">Select a goal…</option>
                    {goalList.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.goal_name ?? g.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Monthly contribution ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="10"
                    className="ui-field"
                    placeholder="e.g. 300"
                    value={params.monthlyContribution ?? ""}
                    onChange={(e) => setParams({ ...params, monthlyContribution: e.target.value })}
                  />
                </div>
              </>
            )}

            {scenarioType === "one_time_purchase" && (
              <>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Purchase name</label>
                  <input
                    type="text"
                    className="ui-field"
                    placeholder="e.g. New laptop"
                    value={params.name ?? ""}
                    onChange={(e) => setParams({ ...params, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Total amount ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="10"
                    className="ui-field"
                    placeholder="e.g. 1200"
                    value={params.amount ?? ""}
                    onChange={(e) => setParams({ ...params, amount: e.target.value })}
                  />
                </div>
              </>
            )}

            {scenarioType === "surplus_redirect" && (
              <>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Target allocation</label>
                  <select
                    className="ui-field"
                    value={params.targetSlug ?? ""}
                    onChange={(e) => setParams({ ...params, targetSlug: e.target.value })}
                  >
                    <option value="">Select allocation…</option>
                    {allocationList.map((a) => (
                      <option key={a.slug} value={a.slug}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">Monthly amount to redirect ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="10"
                    className="ui-field"
                    placeholder="e.g. 100"
                    value={params.amount ?? ""}
                    onChange={(e) => setParams({ ...params, amount: e.target.value })}
                  />
                </div>
              </>
            )}

            {scenarioType === "emergency_floor_change" && (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-[var(--text-muted)]">New buffer allocation (%)</label>
                <input
                  type="number"
                  min="0"
                  max="50"
                  step="1"
                  className="ui-field"
                  placeholder="e.g. 15"
                  value={params.newBufferPct ?? ""}
                  onChange={(e) => setParams({ ...params, newBufferPct: e.target.value })}
                />
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => void runPreview()}
                disabled={loading}
                className="rounded-full px-5 py-2 text-[13px] font-semibold transition disabled:opacity-50"
                style={{ background: "var(--primary-color)", color: "var(--primary-contrast)" }}
              >
                {loading ? "Running…" : "Preview Impact"}
              </button>
              {preview && (
                <button
                  type="button"
                  onClick={() => void requestApply()}
                  disabled={loading}
                  className="rounded-full border border-[var(--border-color)] px-5 py-2 text-[13px] font-semibold text-[var(--text-secondary)] transition hover:border-[var(--primary-color)] hover:text-[var(--primary-color)] disabled:opacity-50"
                >
                  Apply Scenario
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-[0.75rem] border border-[var(--badge-danger-ring)] bg-[var(--badge-danger-bg)] px-4 py-2 text-sm text-[var(--badge-danger-text)]">
            {error}
          </p>
        )}

        {applyResult && (
          <div className="rounded-[1.25rem] border border-[var(--badge-success-ring,var(--border-color))] bg-[var(--badge-success-bg)] px-5 py-4 text-sm text-[var(--badge-success-text)]">
            Applied {applyResult.changeCount ?? 0} change{(applyResult.changeCount ?? 0) !== 1 ? "s" : ""} successfully.
          </div>
        )}

        {changeSet !== null && (
          <ChangeSetCard
            changeSet={changeSet}
            onConfirm={() => void confirmApply()}
            onCancel={() => setChangeSet(null)}
            applying={applying}
          />
        )}

        {/* Preview results */}
        {preview && (
          <div className="space-y-6">
            <div>
              <p className="mb-3 text-[13px] font-semibold text-[var(--text-secondary)]">Impact Summary</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="Monthly Income"
                  value={preview.scenario.monthlyIncome}
                  delta={preview.delta.monthlyIncome}
                />
                <MetricCard
                  label="Monthly Surplus"
                  value={preview.scenario.surplus}
                  delta={preview.delta.surplus}
                />
                <MetricCard
                  label="Monthly Flexibility"
                  value={preview.scenario.monthlyFlexibility}
                  delta={preview.delta.monthlyFlexibility}
                />
                <MetricCard
                  label="Buffer"
                  value={preview.scenario.bufferAmount}
                  delta={preview.delta.bufferAmount}
                />
                <MetricCard label="Fixed Bills" value={preview.scenario.fixedBillsTotal} />
                <MetricCard label="Debt Minimums" value={preview.scenario.debtMinimums} />
              </div>
            </div>

            {/* Side-by-side table */}
            <div className="overflow-x-auto rounded-[1.25rem] border border-[var(--border-subtle)]">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "var(--surface-elevated)" }}>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Metric</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Current</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Scenario</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Monthly Income", preview.current.monthlyIncome, preview.scenario.monthlyIncome],
                    ["Total Allocated", preview.current.totalAllocated, preview.scenario.totalAllocated],
                    ["Surplus / Deficit", preview.current.surplus, preview.scenario.surplus],
                    ["Buffer", preview.current.bufferAmount, preview.scenario.bufferAmount],
                    ["Monthly Flexibility", preview.current.monthlyFlexibility, preview.scenario.monthlyFlexibility],
                    ["Fixed Bills Total", preview.current.fixedBillsTotal, preview.scenario.fixedBillsTotal],
                    ["Debt Minimums", preview.current.debtMinimums, preview.scenario.debtMinimums],
                    ["Debt Payoff (months)", String(preview.current.maxDebtPayoffMonths), String(preview.scenario.maxDebtPayoffMonths)],
                  ].map(([metric, cur, scen], i) => (
                    <tr
                      key={metric}
                      style={{
                        background: i % 2 === 0 ? "transparent" : "var(--surface-elevated)",
                        borderTop: "1px solid var(--border-subtle)",
                      }}
                    >
                      <td className="px-4 py-2.5 text-[var(--text-primary)]">{metric}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-[var(--text-muted)]">{cur}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-[var(--text-strong)]">{scen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Debt payoff detail */}
            {preview.scenario.debtPayoff.length > 0 && (
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[var(--text-secondary)]">Debt Payoff Timeline</p>
                <div className="space-y-2">
                  {preview.scenario.debtPayoff.map((d) => {
                    const cur = preview.current.debtPayoff.find((x) => x.id === d.id);
                    const diff = cur && Number.isFinite(d.months) && Number.isFinite(cur.months)
                      ? d.months - cur.months
                      : null;
                    return (
                      <div
                        key={d.id}
                        className="flex items-center justify-between rounded-[1rem] border border-[var(--border-subtle)] px-4 py-3"
                        style={{ background: "var(--surface-elevated)" }}
                      >
                        <div>
                          <p className="text-[13px] font-semibold text-[var(--text-strong)]">{d.name}</p>
                          <p className="text-[11px] text-[var(--text-muted)]">Balance: {d.currentBalance} · Payment: {d.minimumPayment}/mo</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[13px] font-bold text-[var(--text-strong)]">
                            {Number.isFinite(d.months) ? `${d.months} mo` : "∞"}
                          </p>
                          {diff !== null && diff !== 0 && (
                            <p
                              className="text-[11px] font-semibold"
                              style={{ color: diff < 0 ? "var(--badge-success-text)" : "var(--badge-danger-text)" }}
                            >
                              {diff < 0 ? `${Math.abs(diff)} mo faster` : `${diff} mo slower`}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Goal completion detail */}
            {preview.scenario.goalCompletion.length > 0 && (
              <div>
                <p className="mb-2 text-[13px] font-semibold text-[var(--text-secondary)]">Goal Completion</p>
                <div className="space-y-2">
                  {preview.scenario.goalCompletion.map((g) => {
                    const cur = preview.current.goalCompletion.find((x) => x.id === g.id);
                    const diff = cur?.months != null && g.months != null ? g.months - cur.months : null;
                    return (
                      <div
                        key={g.id}
                        className="flex items-center justify-between rounded-[1rem] border border-[var(--border-subtle)] px-4 py-3"
                        style={{ background: "var(--surface-elevated)" }}
                      >
                        <div>
                          <p className="text-[13px] font-semibold text-[var(--text-strong)]">{g.name}</p>
                          <p className="text-[11px] text-[var(--text-muted)]">{g.reservedAmount} / {g.targetAmount}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[13px] font-bold text-[var(--text-strong)]">
                            {g.months != null ? `${g.months} mo` : "—"}
                          </p>
                          {diff !== null && diff !== 0 && (
                            <p
                              className="text-[11px] font-semibold"
                              style={{ color: diff < 0 ? "var(--badge-success-text)" : "var(--badge-danger-text)" }}
                            >
                              {diff < 0 ? `${Math.abs(diff)} mo faster` : `${diff} mo slower`}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 12-month cash flow chart */}
            <div
              className="rounded-[1.25rem] border border-[var(--border-subtle)] p-5"
              style={{ background: "var(--surface-elevated)" }}
            >
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-[12px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Current plan</p>
                  <CashFlowBar months={preview.current.cashFlow12m} />
                </div>
                <div>
                  <p className="mb-1 text-[12px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">With scenario</p>
                  <CashFlowBar months={preview.scenario.cashFlow12m} />
                </div>
              </div>
            </div>

            <p className="text-center text-[11px] text-[var(--text-muted)]">
              Scenarios are read-only until you click "Apply Scenario". No changes are saved until confirmed.
            </p>
          </div>
        )}
      </div>
    </PageShell>
  );
}
