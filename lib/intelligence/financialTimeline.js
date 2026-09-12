/**
 * Financial Timeline — aggregates events from multiple authoritative sources
 * into a chronological narrative.
 *
 * SAFE sources (used):
 *   - Closed monthly snapshots (monthly_reviews with status = applied)
 *   - Debt milestones (reconstructed from debt_payments + debt_adjustments)
 *   - Plan change events (workspace_activity with action = plan_changed)
 *
 * UNSAFE sources (NOT used):
 *   - goal.targetDate as completion proxy (no completed_at in schema)
 *   - today's account balance as historical fact
 */

import { formatCents, parseMoneyToCents } from '../raf/reporting.js';

export const TimelineEventType = Object.freeze({
  MONTH_CLOSED: 'month_closed',
  DEBT_MILESTONE: 'debt_milestone',
  PLAN_CHANGED: 'plan_changed',
  // GOAL_COMPLETED is intentionally absent — no completed_at in schema.
});

/**
 * Build timeline events from a closed monthly review row.
 */
export function buildMonthClosedEvent(review) {
  const surplus = review.netSurplus ?? review.net_surplus ?? null;
  const surplusCents = surplus !== null ? parseMoneyToCents(surplus) : null;

  return {
    id: `month_closed:${review.reviewMonth ?? review.review_month}`,
    date: review.reviewMonth ?? review.review_month,
    type: TimelineEventType.MONTH_CLOSED,
    title: `Month closed: ${review.reviewMonth ?? review.review_month}`,
    description: surplusCents !== null
      ? `Net ${surplusCents >= 0 ? 'surplus' : 'deficit'}: ${formatCents(Math.abs(surplusCents))}`
      : null,
    metrics: {
      netSurplus: surplus !== null ? formatCents(surplusCents) : null,
    },
    linkedEntity: { type: 'monthly_review', id: review.id },
    source: 'monthly_review',
  };
}

/**
 * Build debt milestone events from an ordered payment ledger.
 * Only emits if the balance crossed a round-number threshold.
 *
 * @param {object} debt            The debt record (starting_balance, name, id)
 * @param {Array}  paymentsAndAdj  Sorted payment/adjustment rows (date + signed amount in cents)
 * @param {number[]} [thresholds] Milestone amounts in dollars (default [10000,5000,2500,1000,0])
 */
export function buildDebtMilestoneEvents(debt, paymentsAndAdj, thresholds = [10000, 5000, 2500, 1000, 0]) {
  const events = [];
  const startingCents = parseMoneyToCents(debt.startingBalance ?? debt.starting_balance ?? 0);
  let balanceCents = startingCents;
  const sortedThresholds = [...thresholds].sort((a, b) => b - a);
  const thresholdCentsSet = new Set(sortedThresholds.map((t) => t * 100));
  const emittedThresholds = new Set();

  for (const entry of paymentsAndAdj) {
    const prevBalance = balanceCents;
    balanceCents += entry.deltaCents; // negative = payment/reduction, positive = charge/interest

    for (const thresholdCents of thresholdCentsSet) {
      if (emittedThresholds.has(thresholdCents)) continue;
      // Did balance cross below this threshold?
      if (prevBalance > thresholdCents && balanceCents <= thresholdCents) {
        emittedThresholds.add(thresholdCents);
        events.push({
          id: `debt_milestone:${debt.id}:${thresholdCents}`,
          date: entry.date,
          type: TimelineEventType.DEBT_MILESTONE,
          title: thresholdCents === 0
            ? `${debt.name} paid off`
            : `${debt.name} fell below ${formatCents(thresholdCents)}`,
          description: `Balance: ${formatCents(Math.max(balanceCents, 0))}`,
          metrics: {
            previousBalanceCents: prevBalance,
            balanceCents: Math.max(balanceCents, 0),
            thresholdCents,
          },
          linkedEntity: { type: 'debt', id: debt.id },
          source: 'debt_ledger',
        });
      }
    }
  }

  return events;
}

/**
 * Build a plan-change timeline event from a workspace_activity row.
 */
export function buildPlanChangedEvent(activity) {
  const meta = activity.metadata ?? {};
  return {
    id: `plan_changed:${activity.id}`,
    date: activity.createdAt ?? activity.created_at,
    type: TimelineEventType.PLAN_CHANGED,
    title: 'Allocation plan updated',
    description: meta.reason ?? null,
    metrics: {
      before: meta.before ?? null,
      after: meta.after ?? null,
    },
    linkedEntity: meta.relatedEntity
      ? { type: 'allocation_plan', id: meta.relatedEntity }
      : null,
    source: 'workspace_activity',
  };
}

/**
 * Merge all timeline events from multiple sources and sort chronologically.
 */
export function buildFinancialTimeline({ closedReviews = [], debtMilestones = [], planChanges = [] }) {
  const events = [
    ...closedReviews.map(buildMonthClosedEvent),
    ...debtMilestones,
    ...planChanges.map(buildPlanChangedEvent),
  ];

  // Chronological descending (newest first).
  events.sort((a, b) => (b.date > a.date ? 1 : -1));

  return events;
}
