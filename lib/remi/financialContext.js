import { resolveDebtBalanceAuthority } from '../debts/debtBalanceAuthority.js';
import { buildDebtListResponse } from '../raf/debts.js';
import { sumGoalLinkedContributionCents } from '../reports/goalContributions.js';
import { formatCents, parseMoneyToCents } from '../raf/reporting.js';

function fmt(amount) {
  return Number(amount ?? 0).toFixed(2);
}

/**
 * Strip card/account number fragments from merchant names before including
 * them in AI context. Removes sequences of 4+ consecutive digits.
 * Never include raw transaction descriptions, account numbers, or statement
 * text in Remi context.
 */
export function sanitizeMerchantName(name) {
  return String(name ?? 'Unknown').replace(/\b\d{4,}\b/g, '****').trim() || 'Unknown';
}

function monthsBack(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function buildRemiIncomeContext(incomeEntries = [], months = 1) {
  const totalIncome = incomeEntries.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  return {
    totalForPeriod: fmt(totalIncome),
    avgMonthly: fmt(months > 0 ? totalIncome / months : 0),
    entryCount: incomeEntries.length,
  };
}

// Classify spending by canonical transaction direction, not by sign of amount.
// direction === 'debit' is the single declared authority for debit/spending direction.
export function buildRemiSpendingContext(transactions = [], months = 1) {
  const debitTransactions = transactions.filter((t) => t.direction === 'debit');
  const totalSpending = debitTransactions.reduce((sum, t) => sum + Math.abs(Number(t.amount ?? 0)), 0);
  const topMerchants = Object.entries(
    debitTransactions.reduce((acc, t) => {
      const key = sanitizeMerchantName(t.merchant ?? t.description);
      acc[key] = (acc[key] ?? 0) + Math.abs(Number(t.amount ?? 0));
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([merchant, total]) => ({ merchant, total: fmt(total) }));

  return {
    totalForPeriod: fmt(totalSpending),
    avgMonthly: fmt(months > 0 ? totalSpending / months : 0),
    transactionCount: debitTransactions.length,
    topMerchants,
  };
}

// Receives authoritative debt snapshots already resolved through Authority A.
// Never reads raw debt row fields for balance.
export function buildRemiDebtContext(debtSnapshots = []) {
  return debtSnapshots.map((debt) => ({
    name: debt.name,
    balance: fmt(debt.currentBalance),
    balanceSource: debt.balanceAuthority?.source ?? 'manual_derived',
    balanceAsOf: debt.balanceAuthority?.asOf ?? null,
    minimumPayment: fmt(debt.minimumPayment),
    interestRate: debt.apr ?? debt.interestRate ?? null,
  }));
}

// Receives pre-computed goal contribution cents per goalId.
// Never reads goal.currentAmount from the raw row.
export function buildRemiGoalContext(goals = [], goalContributionCentsByGoalId = new Map()) {
  return goals.map((goal) => {
    const contributionCents = goalContributionCentsByGoalId.get(goal.id) ?? 0;
    const targetCents = parseMoneyToCents(goal.targetAmount ?? '0.00');
    const percentComplete = targetCents > 0
      ? Math.round((contributionCents / targetCents) * 100)
      : 0;
    return {
      name: goal.name,
      target: fmt(goal.targetAmount),
      current: formatCents(Math.max(0, contributionCents)),
      percentComplete,
    };
  });
}

function groupPaymentsByDebtId(rows) {
  const map = new Map();
  for (const row of (rows ?? [])) {
    const key = row.debtId ?? row.debt_id;
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export async function buildFinancialContext({ db, householdId, months = 3 }) {
  const from = monthsBack(months);
  const to = new Date().toISOString().slice(0, 10);

  const { household, txItems, incomeEntries, debtSnapshots, goalList, recentReviews } =
    await db.transaction(async (tx) => {
      const [
        household,
        transactions,
        incomeEntries,
        rawDebts,
        debtPayments,
        debtAdjustments,
        goals,
        monthlyReviews,
      ] = await Promise.all([
        tx.getHousehold({ householdId }),
        tx.listTransactions({ householdId, from, to, limit: 500 }),
        tx.listIncomeEntries({ householdId, from, to }),
        tx.listDebts({ householdId }),
        tx.listDebtPayments({ householdId }),
        typeof tx.listDebtAdjustments === 'function'
          ? tx.listDebtAdjustments({ householdId })
          : Promise.resolve([]),
        tx.listGoals({ householdId }),
        tx.listMonthlyReviews({ householdId }),
      ]);

      const txItems = Array.isArray(transactions) ? transactions : (transactions?.items ?? []);
      const debtList = Array.isArray(rawDebts) ? rawDebts : (rawDebts?.items ?? []);

      // Resolve linked financial accounts before building debt snapshots.
      // Mirrors lib/debts/debts.js:resolveDebtAccounts — required so account-backed
      // debts use financial_account authority, not a ledger fallback.
      const linkedAccountIds = [
        ...new Set(debtList.map((d) => d.financialAccountId ?? d.financial_account_id).filter(Boolean)),
      ];
      const accountById = new Map();
      if (linkedAccountIds.length > 0 && typeof tx.getFinancialAccountById === 'function') {
        await Promise.all(linkedAccountIds.map(async (accountId) => {
          const account = await tx.getFinancialAccountById({ householdId, accountId });
          if (account) accountById.set(accountId, account);
        }));
      }

      // Attach Authority A balance authority to each debt before snapshot derivation.
      // resolveDebtBalanceAuthority throws for a linked debt whose account cannot be
      // found — this is the correct fail-loud behavior, never a silent fallback.
      const debtsWithAuthority = debtList.map((debt) => {
        const financialAccountId = debt.financialAccountId ?? debt.financial_account_id ?? null;
        const financialAccount = financialAccountId ? (accountById.get(financialAccountId) ?? null) : null;
        return {
          ...debt,
          financialAccountId,
          balanceAuthority: resolveDebtBalanceAuthority({
            debt: { ...debt, financialAccountId },
            financialAccount,
          }),
        };
      });

      const debtSnapshots = buildDebtListResponse(
        debtsWithAuthority,
        groupPaymentsByDebtId(debtPayments),
        groupPaymentsByDebtId(debtAdjustments),
        household?.activeMonth,
      ).items ?? [];

      return {
        household,
        txItems,
        incomeEntries,
        debtSnapshots,
        goalList: Array.isArray(goals) ? goals : (goals?.items ?? []),
        recentReviews: (monthlyReviews ?? []).slice(0, months),
      };
    });

  // Compute goal progress from linked transactions — never from goal.currentAmount.
  const goalContributionCentsByGoalId = new Map(
    goalList.map((goal) => [goal.id, sumGoalLinkedContributionCents(goal.id, txItems, [])]),
  );

  const incomeContext = buildRemiIncomeContext(incomeEntries, months);
  const spendingContext = buildRemiSpendingContext(txItems, months);
  const avgMonthlyIncome = Number(incomeContext.avgMonthly);
  const avgMonthlySpending = Number(spendingContext.avgMonthly);

  return {
    householdName: household?.name ?? 'Your Household',
    periodMonths: months,
    periodFrom: from,
    periodTo: to,
    income: incomeContext,
    spending: spendingContext,
    savingsRate: avgMonthlyIncome > 0
      ? Math.round(((avgMonthlyIncome - avgMonthlySpending) / avgMonthlyIncome) * 100)
      : null,
    debts: buildRemiDebtContext(debtSnapshots),
    goals: buildRemiGoalContext(goalList, goalContributionCentsByGoalId),
    recentMonthlyReviews: recentReviews.map((r) => ({
      month: r.activeMonth ?? r.month,
      status: r.status,
    })),
  };
}
