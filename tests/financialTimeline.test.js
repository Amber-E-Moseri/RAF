import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthClosedEvent,
  buildDebtMilestoneEvents,
  buildPlanChangedEvent,
  buildFinancialTimeline,
  TimelineEventType,
} from '../lib/intelligence/financialTimeline.js';

describe('financial timeline', () => {
  // 29. Month closed event shape
  it('29. buildMonthClosedEvent produces correct shape and type', () => {
    const review = {
      id: 'rev-1',
      review_month: '2026-08-01',
      status: 'applied',
      net_surplus: '250.00',
    };
    const event = buildMonthClosedEvent(review);
    assert.equal(event.type, TimelineEventType.MONTH_CLOSED);
    assert.equal(event.date, '2026-08-01');
    assert.ok(event.id.includes('month_closed'));
    assert.ok(event.metrics.netSurplus !== null);
    assert.equal(event.source, 'monthly_review');
  });

  // 30. Month closed with deficit
  it('30. buildMonthClosedEvent handles negative surplus (deficit)', () => {
    const review = { id: 'rev-2', review_month: '2026-07-01', net_surplus: '-150.00' };
    const event = buildMonthClosedEvent(review);
    assert.ok(event.description.includes('deficit'));
  });

  // 31. Debt milestone events cross threshold
  it('31. buildDebtMilestoneEvents emits event when balance crosses below threshold', () => {
    const debt = { id: 'debt-1', name: 'Car Loan', starting_balance: '15000.00' };
    const paymentsAndAdj = [
      { date: '2026-01-01', deltaCents: -300000 },  // -$3000 → balance $12,000
      { date: '2026-04-01', deltaCents: -300000 },  // -$3000 → balance $9,000 (crosses $10k)
    ];
    const events = buildDebtMilestoneEvents(debt, paymentsAndAdj, [10000]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, TimelineEventType.DEBT_MILESTONE);
    assert.equal(events[0].date, '2026-04-01');
    assert.ok(events[0].title.toLowerCase().includes('10000') || events[0].title.includes('10,000'));
  });

  // 32. Debt milestones — paid off = balance 0
  it('32. paid-off milestone emitted when balance crosses 0', () => {
    const debt = { id: 'debt-2', name: 'Credit Card', starting_balance: '500.00' };
    const paymentsAndAdj = [
      { date: '2026-09-01', deltaCents: -50000 },  // -$500 → $0
    ];
    const events = buildDebtMilestoneEvents(debt, paymentsAndAdj, [0]);
    assert.equal(events.length, 1);
    assert.ok(events[0].title.includes('paid off'));
  });

  // 33. No milestone emitted if threshold never crossed
  it('33. no milestone events when balance never crosses any threshold', () => {
    const debt = { id: 'debt-3', name: 'Mortgage', starting_balance: '200000.00' };
    const paymentsAndAdj = [
      { date: '2026-01-01', deltaCents: -50000 }, // tiny payment
    ];
    const events = buildDebtMilestoneEvents(debt, paymentsAndAdj, [100000, 50000, 0]);
    assert.equal(events.length, 0);
  });

  // 34. Plan changed event shape
  it('34. buildPlanChangedEvent produces correct shape', () => {
    const activity = {
      id: 'act-1',
      created_at: '2026-06-15T09:00:00Z',
      metadata: { reason: 'Annual review', before: {}, after: {} },
    };
    const event = buildPlanChangedEvent(activity);
    assert.equal(event.type, TimelineEventType.PLAN_CHANGED);
    assert.equal(event.source, 'workspace_activity');
    assert.equal(event.description, 'Annual review');
    assert.ok(event.id.includes('plan_changed'));
  });

  // 35. buildFinancialTimeline merges and sorts descending
  it('35. buildFinancialTimeline merges and sorts all event types newest first', () => {
    const closedReviews = [
      { id: 'rev-1', review_month: '2026-06-01', net_surplus: '100.00' },
      { id: 'rev-2', review_month: '2026-08-01', net_surplus: '200.00' },
    ];
    const planChanges = [
      { id: 'act-1', created_at: '2026-07-15T00:00:00Z', metadata: {} },
    ];
    const events = buildFinancialTimeline({ closedReviews, debtMilestones: [], planChanges });
    assert.equal(events.length, 3);
    // Newest first: 2026-08 > 2026-07 > 2026-06
    assert.ok(events[0].date >= events[1].date);
    assert.ok(events[1].date >= events[2].date);
  });

  // 36. GOAL_COMPLETED is intentionally absent
  it('36. TimelineEventType does not include GOAL_COMPLETED', () => {
    assert.ok(!('GOAL_COMPLETED' in TimelineEventType));
  });
});
