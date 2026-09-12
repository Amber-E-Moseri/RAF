/**
 * Intelligence Service — data fetching coordinator for all Post-Closure Intelligence phases.
 *
 * Each function fetches the minimum needed data from the DB and delegates all
 * computation to the pure intelligence modules.  No derived data is persisted.
 */

import { parseMoneyToCents } from '../raf/reporting.js';
import { computeSpendingVelocity, extractVelocityAlerts } from './spendingVelocity.js';
import {
  buildClosedMonthsForPressure,
  computePlanPressure,
} from './planPressure.js';
import { buildPlanHistory } from './planHistory.js';
import { extractFinancialDecisions, DECISION_ACTIONS } from './financialDecisions.js';
import { buildFinancialTimeline, buildDebtMilestoneEvents } from './financialTimeline.js';
import { buildThenVsNow, computeClosedMonthAverages, computeDebtBalanceAsOf } from './progressMetrics.js';
import { computeIncomeResilience } from './incomeResilience.js';
import { Provenance } from './provenance.js';

export class IntelligenceHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireHousehold(householdId) {
  if (!householdId) throw new IntelligenceHttpError(400, 'householdId is required');
}

// ─── Phase 1: Spending Velocity ──────────────────────────────────────────────

export async function getSpendingVelocity({ db, householdId, isoMonth, today }) {
  requireHousehold(householdId);
  const month = isoMonth ?? today?.slice(0, 7) + '-01' ?? null;
  if (!month) throw new IntelligenceHttpError(400, 'isoMonth is required');

  return db.transaction(async (tx) => {
    const categories = await tx.listAllocationCategories({ householdId });

    const allocatedByBucketId = new Map();
    const usedByBucketId = new Map();

    // Build allocated amounts from income allocations this month.
    const monthStr = month.slice(0, 7);
    const allocations = await tx.listIncomeAllocations({ householdId, from: month, to: month });
    for (const a of allocations) {
      const catId = a.allocationCategoryId ?? a.allocation_category_id;
      if (!catId) continue;
      allocatedByBucketId.set(
        catId,
        (allocatedByBucketId.get(catId) ?? 0) + parseMoneyToCents(a.allocatedAmount ?? a.allocated_amount ?? 0),
      );
    }

    // Build used amounts from debit transactions this month.
    const transactions = await tx.listTransactions({
      householdId,
      from: month,
      to: month,
      direction: 'debit',
    });
    for (const tx_ of transactions) {
      const catId = tx_.categoryId ?? tx_.category_id;
      if (!catId) continue;
      usedByBucketId.set(
        catId,
        (usedByBucketId.get(catId) ?? 0) + parseMoneyToCents(tx_.amount),
      );
    }

    const velocityResults = computeSpendingVelocity({
      isoMonth: month,
      today: today ?? new Date().toISOString().slice(0, 10),
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
    const closedReviews = (reviews.items ?? reviews)
      .filter((r) => (r.status ?? 'draft') === 'applied');

    if (closedReviews.length === 0) {
      return { signals: [], closedMonthsAnalyzed: 0 };
    }

    // Fetch the date range covered by closed reviews.
    const months = closedReviews.map((r) => r.reviewMonth ?? r.review_month).sort();
    const from = months[0];
    const to = months[months.length - 1];

    const [allTransactions, allAllocations, allCategories] = await Promise.all([
      tx.listTransactions({ householdId, from, to }),
      tx.listIncomeAllocations({ householdId, from, to }),
      tx.listAllocationCategories({ householdId, includeSuperseded: true }),
    ]);

    const closedMonths = buildClosedMonthsForPressure({
      monthlyReviews: closedReviews,
      allTransactions: allTransactions.items ?? allTransactions,
      allAllocations,
      allCategories,
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

    const activities = (activityResult.items ?? activityResult ?? [])
      .filter((a) => a.action === 'plan_changed');

    const history = buildPlanHistory(categories, activities);
    return { history, snapshotCount: history.length };
  });
}

// ─── Phase 4: Financial Decisions ─────────────────────────────────────────────

export async function getFinancialDecisions({ db, householdId, limit }) {
  requireHousehold(householdId);

  return db.transaction(async (tx) => {
    const activityResult = await tx.listWorkspaceActivity({
      workspaceId: householdId,
      limit: Math.min(Number(limit ?? 100), 500),
    });

    const rows = activityResult.items ?? activityResult ?? [];
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

    const closedReviews = (reviewsRaw.items ?? reviewsRaw)
      .filter((r) => (r.status ?? 'draft') === 'applied');

    const planChanges = (activityResult.items ?? activityResult ?? [])
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
        ...(payments.items ?? payments).map((p) => ({
          date: p.paymentDate ?? p.payment_date,
          deltaCents: -parseMoneyToCents(p.amount), // payment reduces balance
        })),
        ...(adjustments.items ?? adjustments).map((a) => ({
          date: a.effectiveDate ?? a.effective_date,
          deltaCents: parseMoneyToCents(a.amount), // positive = interest/fee
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
    const closedReviews = (reviewsRaw.items ?? reviewsRaw)
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

    const [incomeEntries, transactions] = await Promise.all([
      tx.listIncomeEntries({ householdId, from, to }),
      tx.listTransactions({ householdId, from, to }),
    ]);

    const averages = computeClosedMonthAverages(
      closedReviews,
      incomeEntries.items ?? incomeEntries,
      transactions.items ?? transactions,
    );

    // Split into "then" (oldest third of months) vs "now" (newest third).
    const splitAt = Math.max(1, Math.floor(closedReviews.length / 3));
    const thenReviews = closedReviews.slice(0, splitAt);
    const nowReviews = closedReviews.slice(-splitAt);

    const thenAverages = computeClosedMonthAverages(
      thenReviews,
      incomeEntries.items ?? incomeEntries,
      transactions.items ?? transactions,
    );
    const nowAverages = computeClosedMonthAverages(
      nowReviews,
      incomeEntries.items ?? incomeEntries,
      transactions.items ?? transactions,
    );

    // Build comparison pairs.
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
