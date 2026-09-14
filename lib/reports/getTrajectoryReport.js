import { z } from 'zod';

import { resolveDebtBalanceAuthority } from '../debts/debtBalanceAuthority.js';
import { buildTrajectoryProjections } from '../trajectory/index.js';

export class TrajectoryReportHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TrajectoryReportHttpError';
    this.status = status;
  }
}

const monthsSchema = z
  .union([z.string(), z.number(), z.undefined(), z.null()])
  .transform((value) => {
    if (value == null || value === '') {
      return 12;
    }
    return typeof value === 'number' ? value : Number(value);
  })
  .refine((value) => Number.isInteger(value) && value > 0 && value <= 60, {
    message: 'months must be an integer between 1 and 60',
  });

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Trajectory report DB adapter must implement transaction().');
  }
}

function parseMonths(value) {
  const result = monthsSchema.safeParse(value);
  if (!result.success) {
    throw new TrajectoryReportHttpError(400, result.error.issues[0].message);
  }

  return result.data;
}

export async function getTrajectoryReport({ db, householdId, months }) {
  if (!householdId) {
    throw new TrajectoryReportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedMonths = parseMonths(months);

  return db.transaction(async (tx) => {
    const household = await tx.getHousehold({ householdId });
    if (!household) {
      throw new TrajectoryReportHttpError(404, 'household not found');
    }

    const [incomeEntries, incomeAllocations, allocationCategories, transactions, monthlyReviews, surplusSplitRules, debts, debtPayments] = await Promise.all([
      tx.listIncomeEntries({ householdId, from: '0001-01-01', to: '9999-12-01' }),
      tx.listIncomeAllocations({ householdId, from: '0001-01-01', to: '9999-12-01' }),
      tx.listAllocationCategories({ householdId }),
      tx.listTransactions({ householdId, from: '0001-01-01', to: '9999-12-01' }),
      tx.listMonthlyReviews({ householdId, from: '0001-01-01', to: '9999-12-01' }),
      tx.listSurplusSplitRules({ householdId }),
      tx.listDebts({ householdId }),
      tx.listDebtPayments({ householdId, from: '0001-01-01', to: '9999-12-01' }),
    ]);

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

    return buildTrajectoryProjections({
      activeMonth: household.activeMonth,
      months: parsedMonths,
      household,
      allocationCategories,
      incomeEntries,
      incomeAllocations,
      transactions: transactions.items ?? transactions,
      monthlyReviews,
      surplusSplitRules,
      debts: debtsWithAuthority,
      debtPayments,
    });
  });
}
