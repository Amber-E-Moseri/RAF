import { formatCents, parseMoneyToCents } from '../raf/reporting.js';
import {
  PRESSURE_LOOKBACK_MONTHS,
  PRESSURE_MIN_MONTHS_OVER,
  PRESSURE_RATIO,
} from './constants.js';

/**
 * Build a per-category pressure analysis from a sequence of closed months.
 *
 * @param {object}  opts
 * @param {Array}   opts.closedMonths
 *   Each entry: { reviewMonth, categoryActuals: Map<slug, cents>, categoryPlanned: Map<slug, cents> }
 *   Only genuinely closed months should be passed — open months are excluded by the caller.
 * @param {number}  [opts.lookback]      Override PRESSURE_LOOKBACK_MONTHS for testing.
 * @param {number}  [opts.minMonthsOver] Override PRESSURE_MIN_MONTHS_OVER for testing.
 * @param {number}  [opts.pressureRatio] Override PRESSURE_RATIO for testing.
 * @returns {Array} pressure signals per category
 */
export function computePlanPressure({
  closedMonths,
  lookback = PRESSURE_LOOKBACK_MONTHS,
  minMonthsOver = PRESSURE_MIN_MONTHS_OVER,
  pressureRatio = PRESSURE_RATIO,
}) {
  // Take only the most recent `lookback` months, newest first.
  const window = [...closedMonths]
    .sort((a, b) => (b.reviewMonth > a.reviewMonth ? 1 : -1))
    .slice(0, lookback);

  if (window.length === 0) return [];

  // Collect all category slugs across the window.
  const allSlugs = new Set();
  for (const month of window) {
    for (const slug of month.categoryActuals.keys()) allSlugs.add(slug);
    for (const slug of month.categoryPlanned.keys()) allSlugs.add(slug);
  }

  const signals = [];

  for (const slug of allSlugs) {
    const monthsAnalyzed = [];
    let monthsOver = 0;
    let totalActualCents = 0;
    let totalPlannedCents = 0;

    for (const month of window) {
      const actualCents = month.categoryActuals.get(slug) ?? 0;
      const plannedCents = month.categoryPlanned.get(slug) ?? 0;

      // When planned = 0 we cannot compute a ratio — skip this month for this category.
      if (plannedCents === 0) continue;

      const ratio = actualCents / plannedCents;
      const isOver = ratio >= pressureRatio;

      monthsAnalyzed.push({
        reviewMonth: month.reviewMonth,
        plannedAmount: formatCents(plannedCents),
        actualAmount: formatCents(actualCents),
        varianceAmount: formatCents(actualCents - plannedCents),
        utilizationRatio: Number(ratio.toFixed(3)),
        isOver,
      });

      if (isOver) monthsOver++;
      totalActualCents += actualCents;
      totalPlannedCents += plannedCents;
    }

    if (monthsAnalyzed.length < minMonthsOver) continue;
    if (monthsOver < minMonthsOver) continue;

    const avgPlannedCents = Math.round(totalPlannedCents / monthsAnalyzed.length);
    const avgActualCents = Math.round(totalActualCents / monthsAnalyzed.length);

    signals.push({
      categorySlug: slug,
      monthsOver,
      monthsAnalyzed: monthsAnalyzed.length,
      lookbackMonths: window.length,
      averagePlannedAmount: formatCents(avgPlannedCents),
      averageActualAmount: formatCents(avgActualCents),
      averageDifferenceAmount: formatCents(avgActualCents - avgPlannedCents),
      months: monthsAnalyzed,
    });
  }

  // Most-urgent categories first (most months over, then highest average overage).
  signals.sort((a, b) => {
    if (b.monthsOver !== a.monthsOver) return b.monthsOver - a.monthsOver;
    const aDiff = parseMoneyToCents(a.averageDifferenceAmount);
    const bDiff = parseMoneyToCents(b.averageDifferenceAmount);
    return bDiff - aDiff;
  });

  return signals;
}

/**
 * Build the closedMonths input for computePlanPressure from raw DB rows.
 *
 * @param {object} opts
 * @param {Array}  opts.monthlyReviews   rows from listMonthlyReviews (only applied/closed ones)
 * @param {Array}  opts.allTransactions  all transactions for the relevant period
 * @param {Array}  opts.allAllocations   all income_allocations for the relevant period
 * @param {Array}  opts.allCategories    all allocation_categories (historical snapshots)
 */
export function buildClosedMonthsForPressure({
  monthlyReviews,
  allTransactions,
  allAllocations,
  allCategories,
}) {
  return monthlyReviews.map((review) => {
    const month = review.reviewMonth;

    // Planned: find allocation categories effective for this month.
    // A category is effective if effective_from <= month AND (superseded_at IS NULL OR superseded_at > month).
    const effectiveCategories = allCategories.filter((cat) => {
      const from = cat.effectiveFrom ?? cat.effective_from ?? null;
      const superseded = cat.supersededAt ?? cat.superseded_at ?? null;
      if (!from) return false;
      if (from > month) return false;
      if (superseded && superseded <= month) return false;
      return true;
    });

    // Planned amount per slug = allocation_percent × total income for this month.
    const totalIncomeCents = allAllocations
      .filter((a) => {
        const entryMonth = (a.receivedDate ?? a.received_date ?? '').slice(0, 7);
        return entryMonth === month.slice(0, 7);
      })
      .reduce((sum, a) => sum + parseMoneyToCents(a.allocatedAmount ?? a.allocated_amount ?? 0), 0);

    const categoryPlanned = new Map();
    for (const cat of effectiveCategories) {
      const slug = cat.slug;
      const pct = Number(cat.allocationPercent ?? cat.allocation_percent ?? 0);
      categoryPlanned.set(slug, Math.round(pct * totalIncomeCents));
    }

    // Actual: debit transactions for this month by category slug.
    const monthStr = month.slice(0, 7);
    const categoryActuals = new Map();
    for (const tx of allTransactions) {
      if (tx.direction !== 'debit') continue;
      const txMonth = (tx.transactionDate ?? tx.transaction_date ?? '').slice(0, 7);
      if (txMonth !== monthStr) continue;
      const catSlug = tx.categorySlug ?? tx.category_slug ?? null;
      if (!catSlug) continue;
      categoryActuals.set(catSlug, (categoryActuals.get(catSlug) ?? 0) + parseMoneyToCents(tx.amount));
    }

    return { reviewMonth: month, categoryActuals, categoryPlanned };
  });
}
