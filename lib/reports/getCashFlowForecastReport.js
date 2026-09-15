import { z } from 'zod';

import { computeCashFlowForecast } from '../raf/cashFlowForecasting.js';
import { formatCents, parseMoneyToCents } from '../raf/reporting.js';

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

// ── Report-layer constants ─────────────────────────────────────────────────────

const LIQUID_ASSET_TYPES = new Set(['checking', 'savings', 'cash', 'other']);
const LIABILITY_TYPES = new Set(['credit_card', 'line_of_credit', 'loan']);

// ── Report-layer helpers ───────────────────────────────────────────────────────

function isoDatePart(isoString) {
  return String(isoString ?? '').slice(0, 10);
}

function calendarDaysBetween(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00.000Z`);
  const to = new Date(`${toDateStr}T00:00:00.000Z`);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizeList(value) {
  return Array.isArray(value) ? value : (value?.items ?? []);
}

/**
 * Build per-account freshness info for all active accounts.
 * Pure function — no DB call.
 *
 * @param {Array}  accounts       Raw rows from tx.listFinancialAccounts
 * @param {object} freshnessCtx   From tx.getAccountFreshnessContext
 * @param {string} startDate      Forecast start date YYYY-MM-DD
 * @returns {Array} Account freshness breakdown with balanceAsOf tracking
 */
function buildAccountBreakdown(accounts, freshnessCtx, startDate) {
  const reconByAccountId = new Map(
    (freshnessCtx.acceptedReconciliations ?? []).map((r) => [r.accountId, r]),
  );
  const importByAccountId = new Map(
    (freshnessCtx.importBatches ?? []).map((b) => [b.accountId, b.latestImportAt]),
  );

  return accounts
    .filter((a) => (a.status ?? 'active') === 'active')
    .filter((a) => LIQUID_ASSET_TYPES.has(a.accountType))
    .map((account) => {
      const balanceAsOf = account.balanceAsOf ?? null;
      const recon = reconByAccountId.get(account.id) ?? null;
      const latestImportAt = importByAccountId.get(account.id) ?? null;

      const balanceDateStr = balanceAsOf ? isoDatePart(balanceAsOf) : null;
      const daysAgo = balanceDateStr ? calendarDaysBetween(balanceDateStr, startDate) : null;

      return {
        accountId: account.id,
        accountName: account.name ?? '',
        accountType: account.accountType,
        balance: formatCents(parseMoneyToCents(account.currentBalance ?? account.current_balance ?? '0.00')),
        balanceAsOf: balanceDateStr,
        balanceAgeInDays: daysAgo,
        lastReconciliationDate: recon?.reconciledAt ? isoDatePart(recon.reconciledAt) : null,
        lastImportDate: latestImportAt ? isoDatePart(latestImportAt) : null,
      };
    });
}

/**
 * Emit a CoverageGap record for every active liability account.
 * Conservative by design — no amount or obligation asserted.
 * Pure function — no DB call.
 *
 * @param {Array} accounts  Raw rows from tx.listFinancialAccounts
 * @returns {Array} Coverage gap records
 */
function buildCoverageGaps(accounts) {
  return accounts
    .filter((a) => (a.status ?? 'active') === 'active' && LIABILITY_TYPES.has(a.accountType))
    .map((account) => ({
      accountId: account.id,
      name: account.name ?? '',
      accountType: account.accountType,
      reason: 'payment_coverage_unknown',
    }));
}

/**
 * Derive headroom/shortfall/dates from the core forecast output.
 * All arithmetic — zero new financial logic.
 *
 * @param {object} coreForecast  Return value of computeCashFlowForecast
 * @returns {{ headroom, shortfall, projectedLowDate, firstShortfallDate }}
 */
function deriveHeadroomShortfall(coreForecast) {
  const { lowestProjectedBalance, lowestProjectedAvailableMargin } = coreForecast.summaryMetrics;
  const floorEnabled = coreForecast.assumptions.savingsFloorEnabled;

  const projectedLowDate = lowestProjectedBalance.date;

  let headroom = null;
  let shortfall = null;

  if (floorEnabled) {
    const marginCents = parseMoneyToCents(lowestProjectedAvailableMargin.amount);
    if (marginCents >= 0) {
      headroom = lowestProjectedAvailableMargin.amount;
    } else {
      shortfall = formatCents(Math.abs(marginCents));
    }
  }

  const firstShortfallDate = floorEnabled
    ? (coreForecast.projections.find(
        (p) => parseMoneyToCents(p.projectedAvailableMargin) < 0,
      )?.date ?? null)
    : null;

  return { headroom, shortfall, projectedLowDate, firstShortfallDate };
}

/**
 * Fetch all data needed for the forecast and call computeCashFlowForecast.
 * Extend with account freshness, coverage gaps, and headroom/shortfall context.
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

    // A. Fetch financial inputs
    const [accounts, incomeEntries, fixedBills, allocationCategories, transactions, debts, upcomingExpenses] = await Promise.all([
      tx.listFinancialAccounts({ householdId }).catch(() => []),
      tx.listIncomeEntries({ householdId, from: threeMonthsAgo, to: resolvedStartDate }),
      tx.listFixedBills({ householdId }),
      tx.listAllocationCategories({ householdId }),
      tx.listTransactions({ householdId, from: threeMonthsAgo, to: resolvedStartDate }),
      tx.listDebts({ householdId }),
      tx.listUpcomingExpenses({ householdId, status: 'active' }).catch(() => []),
    ]);

    const normalizedAccounts = normalizeList(accounts);

    // B. Core forecast — UNCHANGED. computeCashFlowForecast receives the same
    //    inputs and returns the same outputs as before this branch.
    const coreForecast = computeCashFlowForecast({
      accounts: normalizedAccounts,
      incomeEntries: normalizeList(incomeEntries),
      fixedBills: normalizeList(fixedBills),
      allocationCategories: normalizeList(allocationCategories),
      transactions: normalizeList(transactions),
      debts: normalizeList(debts),
      upcomingExpenses: normalizeList(upcomingExpenses),
      household,
      days: parsedDays,
      startDate: resolvedStartDate,
    });

    // C. Freshness context — 3 read-only queries, no financial calculation
    const freshnessCtx = await tx.getAccountFreshnessContext?.({ householdId }) ?? {
      importBatches: [],
      acceptedReconciliations: [],
      unreviewedImportCount: 0,
    };

    // D. Account breakdown — report layer, no financial calculation
    const accountBreakdown = buildAccountBreakdown(normalizedAccounts, freshnessCtx, resolvedStartDate);

    // E. Coverage gaps — all active liability accounts, conservative by design
    const coverageGaps = buildCoverageGaps(normalizedAccounts);

    // F. Headroom / shortfall / dates — arithmetic only from existing engine output
    const { headroom, shortfall, projectedLowDate, firstShortfallDate } = deriveHeadroomShortfall(coreForecast);

    // G. Compose and return extended response (additive — no existing fields removed)
    return {
      ...coreForecast,
      assumptions: {
        ...coreForecast.assumptions,
        accountBreakdown,
        coverageGaps,
        pendingReviewCount: freshnessCtx.unreviewedImportCount,
      },
      summaryMetrics: {
        ...coreForecast.summaryMetrics,
        headroom,
        shortfall,
        projectedLowDate,
        firstShortfallDate,
      },
    };
  });
}
