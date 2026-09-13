/**
 * Intelligence Service — data fetching coordinator for all Post-Closure Intelligence phases.
 *
 * Each function fetches the minimum needed data from the DB and delegates all
 * computation to the pure intelligence modules.  No derived analysis is persisted.
 *
 * Split-transaction awareness:
 *   When a transaction has splits, category attribution must come from
 *   transaction_splits rows instead of the parent transaction category.
 */

import { parseMoneyToCents } from '../raf/reporting.js';
import { computeSpendingVelocity, extractVelocityAlerts } from './spendingVelocity.js';
import {
  buildClosedMonthsForPressure,
  computePlanPressure,
} from './planPressure.js';
import { buildPlanHistory } from './planHistory.js';
import { extractFinancialDecisions } from './financialDecisions.js';
import { buildFinancialTimeline, buildDebtMilestoneEvents } from './financialTimeline.js';
import { buildThenVsNow, computeClosedMonthAverages } from './progressMetrics.js';
import { computeIncomeResilience } from './incomeResilience.js';

export class IntelligenceHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireHousehold(householdId) {
  if (!householdId) throw new IntelligenceHttpError(400, 'householdId is required');
}

/**
 * Build a Map<transactionId, SplitRow[]> for the given transactions.
 * Fetches all splits for the household, then keeps only those belonging to
 * the transaction IDs we already have (avoids a missing date-filter on the
 * DB method).
 */
async function fetchSplitsByTransactionId(tx, householdId, transactionIds) {
  if (
    typeof tx.listTransactionSplits !== 'function'
    || transactionIds.size === 0
  ) {
    return new Map();
  }
  const allSplits = await tx.listTransactionSplits({ householdId });
  const map = new Map();
  for (const split of allSplits) {
    if (!transactionIds.has(split.transactionId)) continue;
    const key = split.transactionId;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(split);
  }
  return map;
}

/**
 * Safely unwrap the paginated result that listTransactions returns.
 * Always use a high limit to avoid silent pagination truncation.
 */
function unwrapItems(result) {
  return result?.items ?? (Array.isArray(result) ? result : []);
}

function toMoneyCents(value) {
  return parseMoneyToCents(value ?? 0);
}

// ─── Phase 1: Spending Velocity ──────────────────────────────────────────────

export async function getSpendingVelocity({ db, householdId, isoMonth, today }) {
  requireHousehold(householdId);

  // Fix: today?.slice(0,7) may be undefined; compute separately before '+ '-01''.
  const resolvedToday = today ?? new Date().toISOString().slice(0, 10);
  const month = isoMonth ?? (resolvedToday.slice(0, 7) + '-01');

  return db.transaction(async (tx) => {
    const categories = await tx.listAllocationCategories({ householdId });

    const allocatedByBucketId = new Map();
    const usedByBucketId = new Map();

    // Build allocated amounts from income allocations this month.
    const allAllocations = await tx.listIncomeAllocations({ householdId, from: month, to: month });
    const allocations = unwrapItems(allAllocations);
    for (const a of allocations) {
      const catId = a.allocationCategoryId ?? a.allocation_category_id;
      if (!catId) continue;
      allocatedByBucketId.set(
        catId,
        (allocatedByBucketId.get(catId) ?? 0) + parseMoneyToCents(a.allocatedAmount ?? a.allocated_amount ?? 0),
      );
    }

    // Fetch debit transactions this month with a high limit to avoid truncation.
    const txResult = await tx.listTransactions({
      householdId,
      from: month,
      to: month,
      direction: 'debit',
      limit: 5000,
    });
    const transactions = unwrapItems(txResult);

    // Build split index for split-aware attribution.
    const txIds = new Set(transactions.map((t) => t.id));
    const splitsByTxId = await fetchSplitsByTransactionId(tx, householdId, txIds);

    for (const t of transactions) {
      if (splitsByTxId.has(t.id)) {
        // Split transaction: attribute each split's amount to its own categoryId.
        for (const split of splitsByTxId.get(t.id)) {
          const catId = split.categoryId ?? split.category_id;
          if (!catId) continue;
          usedByBucketId.set(catId, (usedByBucketId.get(catId) ?? 0) + toMoneyCents(split.amount));
        }
      } else {
        // Unsplit: use parent categoryId directly.
        const catId = t.categoryId ?? t.category_id;
        if (!catId) continue;
        usedByBucketId.set(catId, (usedByBucketId.get(catId) ?? 0) + toMoneyCents(t.amount));
      }
    }

    const velocityResults = computeSpendingVelocity({
      isoMonth: month,
      today: resolvedToday,
      buckets: categories,
      allocatedByBucketId,
      usedByBucketId,
    });

    return {
      isoMonth: month,
      velocity: velocityResults,
      alerts: extractVelocityAlerts(velocityResults),
    };
  });
}

// ─── Phase 2: Plan Pressure ───────────────────────────────────────────────────

export async function getPlanPressure({ db, householdId, lookbackMonths }) {
  requireHousehold(householdId);

  return db.transaction(async (tx) => {
    const reviews = await tx.listMonthlyReviews({ householdId });
    const closedReviews = unwrapItems(reviews)
      .filter((r) => (r.status ?? 'draft') === 'applied');

    if (closedReviews.length === 0) {
      return { signals: [], closedMonthsAnalyzed: 0 };
    }

    // Fetch the date range covered by closed reviews.
    const months = closedReviews.map((r) => r.reviewMonth ?? r.review_month).sort();
    const from = months[0];
    const to = months[months.length - 1];

    const [txResult, allAllocations, allCategories] = await Promise.all([
      tx.listTransactions({ householdId, from, to, limit: 5000 }),
      tx.listIncomeAllocations({ householdId, from, to }),
      tx.listAllocationCategories({ householdId, includeSuperseded: true }),
    ]);
    const allTransactions = unwrapItems(txResult);

    // Build split index for split-aware pressure actuals.
    const txIds = new Set(allTransactions.map((t) => t.id));
    const splitsByTxId = await fetchSplitsByTransactionId(tx, householdId, txIds);

    const closedMonths = buildClosedMonthsForPressure({
      monthlyReviews: closedReviews,
      allTransactions,
      allAllocations: unwrapItems(allAllocations),
      allCategories,
      splitsByTxId,
    });

    const signals = computePlanPressure({
      closedMonths,
      ...(lookbackMonths ? { lookback: Number(lookbackMonths) } : {}),
    });

    return { signals, closedMonthsAnalyzed: closedMonths.length };
  });
}

// ─── Phase 3: Plan History ────────────────────────────────────────────────────

export async function getPlanHistory({ db, householdId }) {
  requireHousehold(householdId);

  return db.transaction(async (tx) => {
    const [categories, activityResult] = await Promise.all([
      tx.listAllocationCategories({ householdId, includeSuperseded: true }),
      tx.listWorkspaceActivity({ workspaceId: householdId, limit: 200 }),
    ]);

    const activities = unwrapItems(activityResult)
      .filter((a) => a.action === 'plan_changed');

    const history = buildPlanHistory(categories, activities);
    return { history, snapshotCount: history.length };
  });
}

// ─── Phase 4: Financial Decisions ─────────────────────────────────────────────

export async function getFinancialDecisions({ db, householdId, limit }) {
  requireHousehold(householdId);

  const parsedLimit = Number(limit ?? 100);
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    throw new IntelligenceHttpError(400, 'limit must be a positive integer');
  }

  return db.transaction(async (tx) => {
    const activityResult = await tx.listWorkspaceActivity({
      workspaceId: householdId,
      limit: Math.min(parsedLimit, 500),
    });

    const rows = unwrapItems(activityResult);
    const decisions = extractFinancialDecisions(rows);
    return { decisions, total: decisions.length };
  });
}

// ─── Phase 5: Financial Timeline ──────────────────────────────────────────────

export async function getFinancialTimeline({ db, householdId }) {
  requireHousehold(householdId);

  return db.transaction(async (tx) => {
    const [reviewsRaw, debts, activityResult] = await Promise.all([
      tx.listMonthlyReviews({ householdId }),
      tx.listDebts({ householdId }),
      tx.listWorkspaceActivity({ workspaceId: householdId, limit: 500 }),
    ]);

    const closedReviews = unwrapItems(reviewsRaw)
      .filter((r) => (r.status ?? 'draft') === 'applied');

    const planChanges = unwrapItems(activityResult)
      .filter((a) => a.action === 'plan_changed');

    // Build debt milestone events for each debt.
    const debtMilestones = [];
    for (const debt of debts) {
      const [payments, adjustments] = await Promise.all([
        tx.listDebtPayments({ householdId, debtId: debt.id }),
        tx.listDebtAdjustments({ householdId, debtId: debt.id }),
      ]);

      // Merge and sort payments + adjustments into a signed ledger.
      const ledgerEntries = [
        ...unwrapItems(payments).map((p) => ({
          date: p.paymentDate ?? p.payment_date,
          deltaCents: -parseMoneyToCents(p.amount), // payment reduces balance
        })),
        ...unwrapItems(adjustments).map((a) => ({
          date: a.effectiveDate ?? a.effective_date,
          deltaCents: parseMoneyToCents(a.amount), // positive = interest/fee/correction
        })),
      ].sort((a, b) => (a.date > b.date ? 1 : -1));

      const milestones = buildDebtMilestoneEvents(debt, ledgerEntries);
      debtMilestones.push(...milestones);
    }

    const events = buildFinancialTimeline({ closedReviews, debtMilestones, planChanges });
    return { events, total: events.length };
  });
}

// ─── Phase 6: Progress / Then vs Now ──────────────────────────────────────────

export async function getProgressMetrics({ db, householdId }) {
  requireHousehold(householdId);

  return db.transaction(async (tx) => {
    const reviewsRaw = await tx.listMonthlyReviews({ householdId });
    const closedReviews = unwrapItems(reviewsRaw)
      .filter((r) => (r.status ?? 'draft') === 'applied')
      .sort((a, b) => {
        const am = a.reviewMonth ?? a.review_month;
        const bm = b.reviewMonth ?? b.review_month;
        return am < bm ? -1 : 1;
      });

    if (closedReviews.length === 0) {
      return { available: false, reason: 'No closed months found' };
    }

    const months = closedReviews.map((r) => r.reviewMonth ?? r.review_month).sort();
    const from = months[0];
    const to = months[months.length - 1];

    const [incomeEntriesRaw, txResult] = await Promise.all([
      tx.listIncomeEntries({ householdId, from, to }),
      tx.listTransactions({ householdId, from, to, limit: 5000 }),
    ]);
    const incomeEntries = unwrapItems(incomeEntriesRaw);
    const transactions = unwrapItems(txResult);

    const averages = computeClosedMonthAverages(closedReviews, incomeEntries, transactions);

    // Split into "then" (oldest third of months) vs "now" (newest third).
    const splitAt = Math.max(1, Math.floor(closedReviews.length / 3));
    const thenReviews = closedReviews.slice(0, splitAt);
    const nowReviews = closedReviews.slice(-splitAt);

    const thenAverages = computeClosedMonthAverages(thenReviews, incomeEntries, transactions);
    const nowAverages = computeClosedMonthAverages(nowReviews, incomeEntries, transactions);

    const comparisons = [];
    for (const thenMetric of thenAverages.metrics) {
      const nowMetric = nowAverages.metrics.find((m) => m.key === thenMetric.key);
      if (!nowMetric) continue;

      const thenCents = parseMoneyToCents(thenMetric.value);
      const nowCents = parseMoneyToCents(nowMetric.value);

      comparisons.push(buildThenVsNow(
        thenMetric.key,
        thenMetric.label,
        { value: thenCents, provenance: thenMetric.provenance },
        { value: nowCents, provenance: nowMetric.provenance },
      ));
    }

    return {
      available: true,
      closedMonthsTotal: closedReviews.length,
      overview: averages,
      thenVsNow: comparisons,
    };
  });
}

// ─── Phase 7: Income Resilience (BLOCKED) ─────────────────────────────────────

export async function getIncomeResilience() {
  return computeIncomeResilience();
}
