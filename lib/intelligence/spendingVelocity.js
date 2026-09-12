import { formatCents, parseMoneyToCents } from '../raf/reporting.js';
import { NON_VELOCITY_CATEGORY_SLUGS, VELOCITY_MIN_DAYS_ELAPSED } from './constants.js';

function daysInMonth(isoMonth) {
  const [y, m] = isoMonth.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function dayOfMonth(isoDate) {
  return Number(isoDate.split('-')[2]);
}

/**
 * Returns true when a category should produce a velocity estimate.
 * Fixed/savings/buffer/debt categories operate on scheduled amounts, not
 * daily-spend patterns, so the runway model is inapplicable to them.
 */
export function isCategoryVelocityApplicable(category) {
  if (!category) return false;
  const slug = (category.slug ?? '').toLowerCase();
  return !NON_VELOCITY_CATEGORY_SLUGS.has(slug);
}

/**
 * Compute spending velocity for a single category within the current month.
 *
 * @param {object} opts
 * @param {string} opts.isoMonth        e.g. "2026-09-01"
 * @param {string} opts.today           ISO date of today, e.g. "2026-09-12"
 * @param {number} opts.allocatedCents  Total allocated amount for the month (cents)
 * @param {number} opts.usedCents       Total debits charged to this category so far (cents)
 * @returns {object} velocity shape, or null if insufficient data
 */
export function computeCategoryVelocity({ isoMonth, today, allocatedCents, usedCents }) {
  const totalDays = daysInMonth(isoMonth);
  const elapsed = dayOfMonth(today);

  if (elapsed < VELOCITY_MIN_DAYS_ELAPSED) {
    return { tooEarly: true, reason: 'Too early to estimate' };
  }

  if (allocatedCents <= 0) {
    return null; // no allocation → no velocity
  }

  const utilizationPercent = Number(((usedCents / allocatedCents) * 100).toFixed(1));
  const elapsedPercent = Number(((elapsed / totalDays) * 100).toFixed(1));
  const dailyAverageCents = usedCents > 0 ? usedCents / elapsed : 0;
  const remainingCents = Math.max(allocatedCents - usedCents, 0);
  const paceRatio = elapsedPercent > 0 ? utilizationPercent / elapsedPercent : 0;

  // Runway: how many more days at this daily average before the allocation runs out.
  const estimatedRunwayDays = dailyAverageCents > 0
    ? Math.floor(remainingCents / dailyAverageCents)
    : null;

  // Projected spend at month-end based on current daily average.
  const projectedMonthEndCents = Math.round(dailyAverageCents * totalDays);

  // Signal: is this category running ahead?
  let signal = 'on_pace';
  if (paceRatio >= 1.15) signal = 'over_pace';
  else if (paceRatio >= 1.05) signal = 'ahead';
  else if (paceRatio <= 0.85) signal = 'under_pace';

  // Runway label: human-friendly, not fake precision.
  let runwayLabel = null;
  if (estimatedRunwayDays !== null) {
    const daysLeft = totalDays - elapsed;
    if (estimatedRunwayDays < daysLeft) {
      runwayLabel = `~${estimatedRunwayDays} days remaining at recent pace`;
    }
  }

  return {
    tooEarly: false,
    utilizationPercent,
    elapsedPercent,
    paceRatio: Number(paceRatio.toFixed(2)),
    dailyAverage: formatCents(Math.round(dailyAverageCents)),
    remainingAmount: formatCents(remainingCents),
    projectedMonthEnd: formatCents(projectedMonthEndCents),
    estimatedRunwayDays,
    runwayLabel,
    signal,
    over: usedCents > allocatedCents,
  };
}

/**
 * Compute velocity for all applicable categories in the current month.
 *
 * @param {object} opts
 * @param {string} opts.isoMonth   e.g. "2026-09-01"
 * @param {string} opts.today      ISO date of today
 * @param {Array}  opts.buckets    Active allocation categories (must include .slug, .id)
 * @param {Map}    opts.allocatedByBucketId  Map<bucketId, cents>
 * @param {Map}    opts.usedByBucketId       Map<bucketId, cents>
 * @returns {Array} velocity results for applicable categories only
 */
export function computeSpendingVelocity({ isoMonth, today, buckets, allocatedByBucketId, usedByBucketId }) {
  const results = [];

  for (const bucket of buckets) {
    if (!isCategoryVelocityApplicable(bucket)) continue;

    const allocatedCents = allocatedByBucketId.get(bucket.id) ?? 0;
    const usedCents = usedByBucketId.get(bucket.id) ?? 0;

    const velocity = computeCategoryVelocity({ isoMonth, today, allocatedCents, usedCents });
    if (!velocity) continue;

    results.push({
      bucketId: bucket.id,
      bucketSlug: bucket.slug,
      bucketName: bucket.label ?? bucket.slug,
      allocatedAmount: formatCents(allocatedCents),
      usedAmount: formatCents(usedCents),
      velocity,
    });
  }

  return results;
}

/**
 * Extract categories that are signalling ahead/over from a velocity result set.
 * Intended for Home surface — only actionable signals surface here.
 */
export function extractVelocityAlerts(velocityResults) {
  return velocityResults
    .filter((r) => r.velocity?.tooEarly === false && (r.velocity.signal === 'over_pace' || r.velocity.signal === 'ahead'))
    .map((r) => ({
      bucketId: r.bucketId,
      bucketName: r.bucketName,
      signal: r.velocity.signal,
      utilizationPercent: r.velocity.utilizationPercent,
      elapsedPercent: r.velocity.elapsedPercent,
      runwayLabel: r.velocity.runwayLabel,
    }));
}

export function buildVelocityFromBucketProgress(bucketProgressRows, { isoMonth, today, categoryLookupByBucketId }) {
  const allocatedByBucketId = new Map();
  const usedByBucketId = new Map();
  const buckets = [];

  for (const row of bucketProgressRows) {
    allocatedByBucketId.set(row.bucket_id, parseMoneyToCents(row.allocated_this_month));
    usedByBucketId.set(row.bucket_id, parseMoneyToCents(row.used_this_month));
    const cat = categoryLookupByBucketId?.get(row.bucket_id);
    if (cat) buckets.push(cat);
  }

  return computeSpendingVelocity({ isoMonth, today, buckets, allocatedByBucketId, usedByBucketId });
}
