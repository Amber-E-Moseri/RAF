import { z } from 'zod';

import { computeCashFlowForecast } from '../raf/cashFlowForecasting.js';

export class CashFlowForecastHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CashFlowForecastHttpError';
    this.status = status;
  }
}

const VALID_DAYS = new Set([30, 60, 90]);

const daysSchema = z
  .union([z.string(), z.number(), z.undefined(), z.null()])
  .transform((v) => (v == null || v === '' ? 30 : typeof v === 'number' ? v : Number(v)))
  .refine((v) => VALID_DAYS.has(v), { message: 'days must be 30, 60, or 90' });

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Cash-flow forecast DB adapter must implement transaction().');
  }
}

function parseDays(raw) {
  const result = daysSchema.safeParse(raw);
  if (!result.success) {
    throw new CashFlowForecastHttpError(400, result.error.issues[0].message);
  }
  return result.data;
}

/**
 * Fetch all data needed for the forecast and call computeCashFlowForecast.
 *
 * startDate defaults to today (UTC). Inject it explicitly in tests to keep
 * results deterministic.
 */
export async function getCashFlowForecastReport({ db, householdId, days, startDate = null }) {
  if (!householdId) {
    throw new CashFlowForecastHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedDays = parseDays(days);
  const resolvedStartDate = startDate ?? new Date().toISOString().slice(0, 10);

  return db.transaction(async (tx) => {
    const household = await tx.getHousehold({ householdId });
    if (!household) {
      throw new CashFlowForecastHttpError(404, 'household not found');
    }

    const threeMonthsAgo = (() => {
      const d = new Date(`${resolvedStartDate}T00:00:00.000Z`);
      d.setUTCMonth(d.getUTCMonth() - 3);
      d.setUTCDate(1);
      return d.toISOString().slice(0, 10);
    })();

    const [accounts, incomeEntries, fixedBills, allocationCategories, transactions, debts, upcomingExpenses] = await Promise.all([
      tx.listFinancialAccounts({ householdId }).catch(() => []),
      tx.listIncomeEntries({ householdId, from: threeMonthsAgo, to: resolvedStartDate }),
      tx.listFixedBills({ householdId }),
      tx.listAllocationCategories({ householdId }),
      tx.listTransactions({ householdId, from: threeMonthsAgo, to: resolvedStartDate }),
      tx.listDebts({ householdId }),
      tx.listUpcomingExpenses({ householdId, status: 'active' }).catch(() => []),
    ]);

    const safe = (v) => Array.isArray(v) ? v : (v?.items ?? []);

    return computeCashFlowForecast({
      accounts: safe(accounts),
      incomeEntries: safe(incomeEntries),
      fixedBills: safe(fixedBills),
      allocationCategories: safe(allocationCategories),
      transactions: safe(transactions),
      debts: safe(debts),
      upcomingExpenses: safe(upcomingExpenses),
      household,
      days: parsedDays,
      startDate: resolvedStartDate,
    });
  });
}
