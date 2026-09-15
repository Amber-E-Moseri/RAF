import { resolveDebtBalanceAuthority } from '../debts/debtBalanceAuthority.js';
import { deriveDebtSnapshot } from './debts.js';
import { deriveReviewEligibility } from '../transactions/transactionReview.js';
import { computeCashFlowForecast } from './cashFlowForecasting.js';

export class FinancialAttentionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FinancialAttentionError';
    this.status = status;
  }
}

const PRIORITY_RANK = { BLOCKING: 0, ACTION_NEEDED: 1, REVIEW: 2 };

function sortItems(items) {
  return [...items].sort((a, b) => {
    const pDiff = (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99);
    if (pDiff !== 0) return pDiff;
    if (a.dueAt && b.dueAt) {
      if (String(a.dueAt) < String(b.dueAt)) return -1;
      if (String(a.dueAt) > String(b.dueAt)) return 1;
    } else if (a.dueAt) {
      return -1;
    } else if (b.dueAt) {
      return 1;
    }
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}

/**
 * Pure, deterministic, read-only aggregation of attention signals.
 *
 * Consumes pre-computed domain outputs. Does not perform financial calculations,
 * re-derive balances, or introduce new financial policy.
 *
 * @param {object} inputs
 * @param {number} inputs.unreviewedImportsCount - Canonical count from Financial Inbox domain
 * @param {number} inputs.unreviewedEligibleTransactionCount - Count from Transaction Review domain
 * @param {Array}  inputs.debtSnapshots - Output of deriveDebtSnapshot per active debt
 * @param {Array}  inputs.forecastPressurePoints - pressurePoints from computeCashFlowForecast
 * @param {Array}  inputs.openReconciliationsByAccount - { accountId, accountName, openCount }[]
 */
export function deriveFinancialAttentionItems({
  unreviewedImportsCount = 0,
  unreviewedEligibleTransactionCount = 0,
  debtSnapshots = [],
  forecastPressurePoints = [],
  openReconciliationsByAccount = [],
} = {}) {
  const raw = [];

  if (unreviewedImportsCount > 0) {
    raw.push({
      id: 'import-review',
      type: 'IMPORT_REVIEW',
      priority: 'ACTION_NEEDED',
      title: 'Transactions Need Review',
      description: unreviewedImportsCount === 1
        ? '1 imported transaction awaits categorization before month close.'
        : `${unreviewedImportsCount} imported transactions await categorization before month close.`,
      action: { label: 'Review Now', href: '/transactions?tab=needs-review' },
      count: unreviewedImportsCount,
      dueAt: null,
    });
  }

  if (unreviewedEligibleTransactionCount > 0) {
    raw.push({
      id: 'transaction-review',
      type: 'TRANSACTION_REVIEW',
      priority: 'REVIEW',
      title: 'Transactions Ready to Mark Reviewed',
      description: unreviewedEligibleTransactionCount === 1
        ? '1 transaction is categorized and ready to be marked reviewed.'
        : `${unreviewedEligibleTransactionCount} transactions are categorized and ready to be marked reviewed.`,
      action: { label: 'Mark Reviewed', href: '#transaction-review' },
      count: unreviewedEligibleTransactionCount,
      dueAt: null,
    });
  }

  // DEBT_OBLIGATION and DEBT_TRAJECTORY are independent dimensions — never collapsed.
  // in_progress (partial payment before due date) is NOT a negative signal.
  for (const snapshot of debtSnapshots) {
    if (!snapshot.paymentObligation) continue;
    const { status, dueDate } = snapshot.paymentObligation;

    if (status === 'missed_payment') {
      raw.push({
        id: `debt-obligation-missed-${snapshot.id}`,
        type: 'DEBT_OBLIGATION',
        priority: 'BLOCKING',
        title: `${snapshot.name}: Payment Overdue`,
        description: `Payment for ${snapshot.name} was not made by the due date.`,
        action: { label: 'View Debt', href: `/debts/${snapshot.id}` },
        dueAt: dueDate ?? null,
        metadata: { debtId: snapshot.id, obligationStatus: status },
      });
    } else if (status === 'under_minimum') {
      raw.push({
        id: `debt-obligation-under-minimum-${snapshot.id}`,
        type: 'DEBT_OBLIGATION',
        priority: 'ACTION_NEEDED',
        title: `${snapshot.name}: Payment Below Minimum`,
        description: `Payment recorded for ${snapshot.name} is below the required minimum.`,
        action: { label: 'View Debt', href: `/debts/${snapshot.id}` },
        dueAt: dueDate ?? null,
        metadata: { debtId: snapshot.id, obligationStatus: status },
      });
    }
  }

  for (const snapshot of debtSnapshots) {
    if (!snapshot.balanceTrajectory?.warning) continue;
    raw.push({
      id: `debt-trajectory-${snapshot.id}`,
      type: 'DEBT_TRAJECTORY',
      priority: 'ACTION_NEEDED',
      title: `${snapshot.name}: Balance Increasing`,
      description: `The balance on ${snapshot.name} increased this period despite payments.`,
      action: { label: 'View Debt', href: `/debts/${snapshot.id}` },
      dueAt: null,
      metadata: { debtId: snapshot.id, trajectory: snapshot.balanceTrajectory.trajectory },
    });
  }

  const criticalPoints = forecastPressurePoints.filter((p) => p.riskLevel === 'critical');
  const tightPoints = forecastPressurePoints.filter((p) => p.riskLevel === 'tight');
  if (criticalPoints.length > 0) {
    const earliest = criticalPoints.reduce((a, b) => String(a.date) <= String(b.date) ? a : b);
    raw.push({
      id: 'forecast-pressure-critical',
      type: 'FORECAST_PRESSURE',
      priority: 'BLOCKING',
      title: 'Cash Flow Critical',
      description: earliest.reason
        ? `Critical cash pressure on ${earliest.date}: ${earliest.reason}.`
        : `Critical cash flow pressure projected on ${earliest.date}.`,
      action: { label: 'View Forecast', href: '/reports/cash-flow' },
      dueAt: earliest.date,
      count: criticalPoints.length,
      metadata: { pressurePoints: criticalPoints },
    });
  } else if (tightPoints.length > 0) {
    const earliest = tightPoints.reduce((a, b) => String(a.date) <= String(b.date) ? a : b);
    raw.push({
      id: 'forecast-pressure-tight',
      type: 'FORECAST_PRESSURE',
      priority: 'ACTION_NEEDED',
      title: 'Cash Flow Tight',
      description: earliest.reason
        ? `Tight cash flow projected on ${earliest.date}: ${earliest.reason}.`
        : `Tight cash flow projected on ${earliest.date}.`,
      action: { label: 'View Forecast', href: '/reports/cash-flow' },
      dueAt: earliest.date,
      count: tightPoints.length,
      metadata: { pressurePoints: tightPoints },
    });
  }

  for (const { accountId, accountName, openCount } of openReconciliationsByAccount) {
    if (!(openCount > 0)) continue;
    raw.push({
      id: `reconciliation-${accountId}`,
      type: 'RECONCILIATION_DISCREPANCY',
      priority: 'REVIEW',
      title: `${accountName}: Balance Discrepancy`,
      description: openCount === 1
        ? `1 open balance discrepancy needs review for ${accountName}.`
        : `${openCount} open balance discrepancies need review for ${accountName}.`,
      action: { label: 'Review', href: `/accounts/${accountId}/reconciliations` },
      dueAt: null,
      count: openCount,
      metadata: { accountId },
    });
  }

  const items = sortItems(raw);
  const urgent = items.filter((i) => i.priority === 'BLOCKING').length;
  const attention = items.filter((i) => i.priority === 'ACTION_NEEDED').length;

  return { items, summary: { total: items.length, urgent, attention } };
}

// ─── DB-loading wrapper ──────────────────────────────────────────────────────

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new FinancialAttentionError(500, 'Financial attention DB adapter must implement transaction().');
  }
}

function safeArray(v) {
  return Array.isArray(v) ? v : (v?.items ?? []);
}

function threeMonthsBeforeDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - 3);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

function groupByField(items, field) {
  const map = new Map();
  for (const item of items) {
    const key = item[field];
    const existing = map.get(key) ?? [];
    existing.push(item);
    map.set(key, existing);
  }
  return map;
}

/**
 * Async DB-loading wrapper. Loads all domain signals within a single transaction
 * and delegates computation to the pure deriveFinancialAttentionItems function.
 *
 * READ-ONLY: loads data from authoritative domain sources, never mutates.
 * WORKSPACE-SCOPED: every query is scoped to householdId.
 */
export async function buildFinancialAttention({ db, householdId, startDate = null }) {
  if (!householdId) {
    throw new FinancialAttentionError(400, 'householdId is required');
  }
  requireDbContract(db);

  return db.transaction(async (tx) => {
    const household = await tx.getHousehold({ householdId });
    if (!household) {
      throw new FinancialAttentionError(404, 'household not found');
    }

    const today = startDate ?? new Date().toISOString().slice(0, 10);
    const threeMonthsAgo = threeMonthsBeforeDate(today);
    const activeMonth = typeof household.activeMonth === 'string'
      ? household.activeMonth.slice(0, 7) + '-01'
      : today.slice(0, 7) + '-01';

    const [
      rawImports,
      rawTransactions,
      rawSplits,
      rawDebts,
      rawDebtPayments,
      rawDebtAdjustments,
      rawAccounts,
      rawIncomeEntries,
      rawFixedBills,
      rawAllocationCategories,
      rawUpcomingExpenses,
    ] = await Promise.all([
      typeof tx.listImportedTransactions === 'function'
        ? tx.listImportedTransactions({ householdId }).catch(() => [])
        : [],
      typeof tx.listTransactions === 'function'
        ? tx.listTransactions({ householdId, from: threeMonthsAgo, to: today }).catch(() => [])
        : [],
      typeof tx.listTransactionSplits === 'function'
        ? tx.listTransactionSplits({ householdId }).catch(() => [])
        : [],
      typeof tx.listDebts === 'function'
        ? tx.listDebts({ householdId }).catch(() => [])
        : [],
      typeof tx.listDebtPayments === 'function'
        ? tx.listDebtPayments({ householdId }).catch(() => [])
        : [],
      typeof tx.listDebtAdjustments === 'function'
        ? tx.listDebtAdjustments({ householdId }).catch(() => [])
        : [],
      typeof tx.listFinancialAccounts === 'function'
        ? tx.listFinancialAccounts({ householdId }).catch(() => [])
        : [],
      typeof tx.listIncomeEntries === 'function'
        ? tx.listIncomeEntries({ householdId, from: threeMonthsAgo, to: today }).catch(() => [])
        : [],
      typeof tx.listFixedBills === 'function'
        ? tx.listFixedBills({ householdId }).catch(() => [])
        : [],
      typeof tx.listAllocationCategories === 'function'
        ? tx.listAllocationCategories({ householdId }).catch(() => [])
        : [],
      typeof tx.listUpcomingExpenses === 'function'
        ? tx.listUpcomingExpenses({ householdId, status: 'active' }).catch(() => [])
        : [],
    ]);

    const imports = safeArray(rawImports);
    const transactions = safeArray(rawTransactions);
    const splits = safeArray(rawSplits);
    const debts = safeArray(rawDebts);
    const debtPayments = safeArray(rawDebtPayments);
    const debtAdjustments = safeArray(rawDebtAdjustments);
    const accounts = safeArray(rawAccounts);

    // ── Signal A: Financial Inbox (unreviewed imports) ─────────────────────
    const unreviewedImportsCount = imports.filter((i) => (i.status ?? i.needs_review) === 'unreviewed').length;

    // ── Signal B: Transaction Review ───────────────────────────────────────
    const splitsByTxId = groupByField(splits, 'transactionId');
    const unreviewedEligibleTransactionCount = transactions.filter((t) => {
      const reviewed = t.reviewedAt ?? t.reviewed_at;
      if (reviewed) return false;
      // Only surface transactions from the active month onwards
      const txDate = t.transactionDate ?? t.transaction_date ?? '';
      if (txDate && txDate < activeMonth) return false;
      const txSplits = splitsByTxId.get(t.id) ?? [];
      return deriveReviewEligibility(t, txSplits).eligible;
    }).length;

    // ── Signal C+D: Debt Obligation + Trajectory ───────────────────────────
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const paymentsByDebtId = groupByField(debtPayments, 'debtId');
    const adjustmentsByDebtId = groupByField(debtAdjustments, 'debtId');

    const debtSnapshots = debts
      .filter((d) => d.isActive !== false)
      .map((debt) => {
        const financialAccountId = debt.financialAccountId ?? debt.financial_account_id ?? null;
        const financialAccount = financialAccountId ? accountById.get(financialAccountId) ?? null : null;
        let balanceAuthority;
        try {
          balanceAuthority = resolveDebtBalanceAuthority({ debt: { ...debt, financialAccountId }, financialAccount });
        } catch {
          balanceAuthority = { source: 'manual_derived', balance: null, asOf: null, financialAccountId: null };
        }
        const enrichedDebt = { ...debt, financialAccountId, balanceAuthority };
        return deriveDebtSnapshot(
          enrichedDebt,
          paymentsByDebtId.get(debt.id) ?? [],
          adjustmentsByDebtId.get(debt.id) ?? [],
          activeMonth,
        );
      });

    // ── Signal E: Forecast Pressure ────────────────────────────────────────
    let forecastPressurePoints = [];
    try {
      const forecast = computeCashFlowForecast({
        accounts,
        incomeEntries: safeArray(rawIncomeEntries),
        fixedBills: safeArray(rawFixedBills),
        allocationCategories: safeArray(rawAllocationCategories),
        transactions,
        debts,
        upcomingExpenses: safeArray(rawUpcomingExpenses),
        household,
        days: 30,
        startDate: today,
      });
      forecastPressurePoints = forecast.pressurePoints ?? [];
    } catch {
      // forecast is best-effort; missing data (e.g. no income entries) is not fatal
    }

    // ── Signal F: Reconciliation Discrepancies ─────────────────────────────
    const openReconciliationsByAccount = [];
    if (typeof tx.listAccountReconciliations === 'function') {
      await Promise.all(
        accounts.map(async (account) => {
          try {
            const recs = await tx.listAccountReconciliations({ householdId, accountId: account.id });
            const recItems = safeArray(recs);
            const openCount = recItems.filter((r) => (r.status ?? 'open') === 'open').length;
            if (openCount > 0) {
              const accountName = account.name ?? account.institution_name ?? account.id;
              openReconciliationsByAccount.push({ accountId: account.id, accountName, openCount });
            }
          } catch {
            // skip accounts with no reconciliation support
          }
        }),
      );
    }

    return deriveFinancialAttentionItems({
      unreviewedImportsCount,
      unreviewedEligibleTransactionCount,
      debtSnapshots,
      forecastPressurePoints,
      openReconciliationsByAccount,
    });
  });
}
