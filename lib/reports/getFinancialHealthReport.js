import { resolveDebtBalanceAuthority } from '../debts/debtBalanceAuthority.js';
import { computeFinancialHealthScoreSnapshot } from '../raf/financialHealthScore.js';
import { computeBucketBalancesSnapshot, computeFinancialHealthSnapshot, formatCents, monthStart, parseMoneyToCents, unwrapRows } from '../raf/reporting.js';

export class FinancialHealthReportHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FinancialHealthReportHttpError';
    this.status = status;
  }
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Report DB adapter must implement transaction().');
  }
}

function normalizeReviewMonth(value) {
  let normalized;
  try {
    normalized = monthStart(value);
  } catch {
    throw new FinancialHealthReportHttpError(400, 'month must be a valid ISO date');
  }

  if (String(value).trim() !== normalized) {
    throw new FinancialHealthReportHttpError(400, 'month must be the first day of the month');
  }

  return normalized;
}

export async function getFinancialHealthReport({ db, householdId, month = null }) {
  if (!householdId) {
    throw new FinancialHealthReportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const household = await tx.getHousehold({ householdId });
    if (!household) {
      throw new FinancialHealthReportHttpError(404, 'household not found');
    }

    const reviewMonth = month ? normalizeReviewMonth(month) : household.activeMonth;

    const [
      activeMonthIncomeEntries,
      activeMonthIncomeAllocations,
      activeMonthTransactions,
      activeMonthDebtPayments,
      debtPaymentsToDate,
      debts,
      debtAdjustments,
      activeAllocationCategories,
      allIncomeAllocations,
      allTransactionsResult,
      allCategories,
      monthlyReviews,
    ] =
      await Promise.all([
        tx.listIncomeEntries({ householdId, from: reviewMonth, to: reviewMonth }),
        tx.listIncomeAllocations({ householdId, from: reviewMonth, to: reviewMonth }),
        tx.listTransactions({ householdId, from: reviewMonth, to: reviewMonth }),
        tx.listDebtPayments({ householdId, from: reviewMonth, to: reviewMonth }),
        tx.listDebtPayments({ householdId, from: '0001-01-01', to: reviewMonth }),
        typeof tx.listDebts === 'function' ? tx.listDebts({ householdId }) : [],
        typeof tx.listDebtAdjustments === 'function' ? tx.listDebtAdjustments({ householdId }) : [],
        tx.listAllocationCategories({ householdId, asOf: reviewMonth }),
        tx.listIncomeAllocations({ householdId, from: '0001-01-01', to: reviewMonth }),
        tx.listTransactions({ householdId, from: '0001-01-01', to: reviewMonth }),
        tx.listAllocationCategories({ householdId, includeSuperseded: true }),
        tx.listMonthlyReviews({ householdId, from: '0001-01-01', to: '9999-12-01' }),
      ]);
    const allTransactions = unwrapRows(allTransactionsResult);
    const categoryLookupById = new Map(allCategories.map((category) => [category.id, category]));
    const bucketBalances = computeBucketBalancesSnapshot({
      buckets: activeAllocationCategories,
      incomeAllocations: allIncomeAllocations,
      transactions: allTransactions,
      categoryLookupById,
    });
    const savingsAllocations = allIncomeAllocations.filter((allocation) => allocation.slug === 'savings');
    const savingsBalance = bucketBalances.find((bucket) => bucket.slug === 'savings')?.balance ?? null;

    const linkedAccountIds = [...new Set(debts.map((d) => d.financialAccountId ?? d.financial_account_id).filter(Boolean))];
    const accountById = new Map();
    if (linkedAccountIds.length > 0 && typeof tx.getFinancialAccountById === 'function') {
      await Promise.all(linkedAccountIds.map(async (accountId) => {
        const account = await tx.getFinancialAccountById({ householdId, accountId });
        if (account) accountById.set(accountId, account);
      }));
    }
    const debtsWithAuthority = debts.map((debt) => {
      const financialAccountId = debt.financialAccountId ?? debt.financial_account_id ?? null;
      const financialAccount = financialAccountId ? (accountById.get(financialAccountId) ?? null) : null;
      return { ...debt, financialAccountId, balanceAuthority: resolveDebtBalanceAuthority({ debt: { ...debt, financialAccountId }, financialAccount }) };
    });

    const healthScoreSnapshot = computeFinancialHealthScoreSnapshot({
      reviewMonth,
      incomeEntries: activeMonthIncomeEntries,
      incomeAllocations: activeMonthIncomeAllocations,
      transactions: unwrapRows(activeMonthTransactions),
      allocationCategories: activeAllocationCategories,
      debts: debtsWithAuthority,
      debtPayments: debtPaymentsToDate,
      debtAdjustments,
      savingsBalance: savingsBalance ?? formatCents(
        savingsAllocations.reduce(
          (sum, allocation) => sum + parseMoneyToCents(allocation.allocatedAmount ?? allocation.amount ?? '0.00'),
          0,
        ),
      ),
      monthlyEssentials: household.monthlyEssentialsBaseline,
    });

    return computeFinancialHealthSnapshot({
      reviewMonth,
      household: {
        savingsFloor: household.savingsFloor,
        savingsFloorEnabled: household.savingsFloorEnabled === true,
        monthlyEssentialsBaseline: household.monthlyEssentialsBaseline,
      },
      activeMonthIncomeEntries,
      activeMonthIncomeAllocations,
      activeMonthTransactions: unwrapRows(activeMonthTransactions),
      activeMonthDebtPayments,
      savingsAllocations,
      savingsBalance,
      monthlyReviews,
      healthScoreSnapshot,
    });
  });
}
