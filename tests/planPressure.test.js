import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildClosedMonthsForPressure, computePlanPressure } from '../lib/intelligence/planPressure.js';

function makeMonth(reviewMonth, slugActuals, slugPlanned) {
  return {
    reviewMonth,
    categoryActuals: new Map(Object.entries(slugActuals)),
    categoryPlanned: new Map(Object.entries(slugPlanned)),
  };
}

describe('plan pressure', () => {
  // 9. No pressure when well within plan
  it('9. no signals when categories are within plan', () => {
    const months = [
      makeMonth('2026-06-01', { dining: 5000, entertainment: 3000 }, { dining: 10000, entertainment: 8000 }),
      makeMonth('2026-07-01', { dining: 6000, entertainment: 3500 }, { dining: 10000, entertainment: 8000 }),
      makeMonth('2026-08-01', { dining: 5500, entertainment: 3200 }, { dining: 10000, entertainment: 8000 }),
    ];
    const signals = computePlanPressure({ closedMonths: months, lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 0);
  });

  // 10. Pressure detected: 3+ months consistently over
  it('10. returns signal when 3+ months exceed plan by 10%+', () => {
    const months = [
      makeMonth('2026-05-01', { dining: 12000 }, { dining: 10000 }),
      makeMonth('2026-06-01', { dining: 11500 }, { dining: 10000 }),
      makeMonth('2026-07-01', { dining: 11200 }, { dining: 10000 }),
      makeMonth('2026-08-01', { dining: 13000 }, { dining: 10000 }),
    ];
    const signals = computePlanPressure({ closedMonths: months, lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].categorySlug, 'dining');
    assert.ok(signals[0].monthsOver >= 3);
  });

  // 11. Only 2 months over — below minimum threshold, no signal
  it('11. no signal when only 2 months are over (below minMonthsOver=3)', () => {
    const months = [
      makeMonth('2026-06-01', { dining: 12000 }, { dining: 10000 }),
      makeMonth('2026-07-01', { dining: 11500 }, { dining: 10000 }),
      makeMonth('2026-08-01', { dining: 9000 }, { dining: 10000 }),
      makeMonth('2026-09-01', { dining: 8500 }, { dining: 10000 }),
    ];
    const signals = computePlanPressure({ closedMonths: months, lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 0);
  });

  // 12. Planned = 0 months are skipped for that category
  it('12. months with planned=0 for a slug are skipped, not treated as infinite pressure', () => {
    const months = [
      makeMonth('2026-06-01', { new_cat: 5000 }, {}),  // planned=0 for new_cat
      makeMonth('2026-07-01', { new_cat: 5000 }, {}),
      makeMonth('2026-08-01', { new_cat: 5000 }, {}),
    ];
    const signals = computePlanPressure({ closedMonths: months, lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 0, 'Should produce no signal when planned=0 for all months');
  });

  // 13. Lookback window only considers the most recent N months
  it('13. lookback window limits to most recent N months', () => {
    const months = [
      // 8 months ago — very old, should be excluded
      makeMonth('2025-12-01', { dining: 15000 }, { dining: 10000 }),
      makeMonth('2026-01-01', { dining: 15000 }, { dining: 10000 }),
      makeMonth('2026-02-01', { dining: 15000 }, { dining: 10000 }),
      makeMonth('2026-03-01', { dining: 15000 }, { dining: 10000 }),
      // Recent months — within lookback
      makeMonth('2026-06-01', { dining: 9000 }, { dining: 10000 }),
      makeMonth('2026-07-01', { dining: 9500 }, { dining: 10000 }),
      makeMonth('2026-08-01', { dining: 9200 }, { dining: 10000 }),
    ];
    // lookback=3: only last 3 months — all within plan, so no signal
    const signals = computePlanPressure({ closedMonths: months, lookback: 3, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 0, 'Old over-plan months should be excluded by lookback window');
  });

  // 14. Multiple categories — signals are sorted by urgency
  it('14. multiple categories: results sorted most-over first', () => {
    const months = [
      makeMonth('2026-06-01', { dining: 13000, gas: 11000 }, { dining: 10000, gas: 10000 }),
      makeMonth('2026-07-01', { dining: 14000, gas: 11200 }, { dining: 10000, gas: 10000 }),
      makeMonth('2026-08-01', { dining: 15000, gas: 11100 }, { dining: 10000, gas: 10000 }),
    ];
    const signals = computePlanPressure({ closedMonths: months, lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 2);
    // dining has larger overage — must come first
    assert.equal(signals[0].categorySlug, 'dining');
    assert.equal(signals[1].categorySlug, 'gas');
  });

  // 15. Exactly at the pressure ratio boundary — included
  it('15. ratio exactly at threshold is treated as over', () => {
    const months = [
      makeMonth('2026-06-01', { groceries: 11000 }, { groceries: 10000 }), // ratio=1.1 exactly
      makeMonth('2026-07-01', { groceries: 11000 }, { groceries: 10000 }),
      makeMonth('2026-08-01', { groceries: 11000 }, { groceries: 10000 }),
    ];
    const signals = computePlanPressure({ closedMonths: months, lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].categorySlug, 'groceries');
  });

  // 16. Empty closed months → empty result
  it('16. empty closedMonths returns empty array', () => {
    const signals = computePlanPressure({ closedMonths: [], lookback: 4, minMonthsOver: 3, pressureRatio: 1.10 });
    assert.deepEqual(signals, []);
  });

  it('16b. closed-month pressure uses split attribution and ignores the parent category', () => {
    const closedMonths = buildClosedMonthsForPressure({
      monthlyReviews: [{ review_month: '2026-08-01', status: 'applied' }],
      allCategories: [
        { id: 'cat-parent', slug: 'household', allocation_percent: 0.50, effective_from: '2026-01-01' },
        { id: 'cat-food', slug: 'food', allocation_percent: 0.30, effective_from: '2026-01-01' },
        { id: 'cat-fuel', slug: 'fuel', allocation_percent: 0.20, effective_from: '2026-01-01' },
      ],
      allAllocations: [
        { received_date: '2026-08-03', allocation_category_id: 'cat-parent', allocated_amount: '500.00' },
        { received_date: '2026-08-03', allocation_category_id: 'cat-food', allocated_amount: '300.00' },
        { received_date: '2026-08-03', allocation_category_id: 'cat-fuel', allocated_amount: '200.00' },
      ],
      allTransactions: [
        { id: 'tx-split', transaction_date: '2026-08-10', direction: 'debit', amount: '90.00', category_id: 'cat-parent' },
      ],
      splitsByTxId: new Map([
        ['tx-split', [
          { transaction_id: 'tx-split', amount: '40.00', category_id: 'cat-food' },
          { transaction_id: 'tx-split', amount: '50.00', category_id: 'cat-fuel' },
        ]],
      ]),
    });

    assert.equal(closedMonths[0].categoryActuals.get('household') ?? 0, 0);
    assert.equal(closedMonths[0].categoryActuals.get('food'), 4000);
    assert.equal(closedMonths[0].categoryActuals.get('fuel'), 5000);
    assert.equal(closedMonths[0].categoryPlanned.get('food'), 30000);
  });

  it('16c. pressure resolves planned and actual categories from historical snapshots', () => {
    const closedMonths = buildClosedMonthsForPressure({
      monthlyReviews: [
        { reviewMonth: '2026-07-01', status: 'applied' },
        { reviewMonth: '2026-09-01', status: 'applied' },
      ],
      allCategories: [
        { id: 'cat-1', slug: 'dining', allocation_percent: 0.20, effective_from: '2026-01-01', superseded_at: '2026-08-01' },
        { id: 'cat-1', slug: 'restaurants', allocation_percent: 0.20, effective_from: '2026-08-01', superseded_at: null },
      ],
      allAllocations: [
        { received_date: '2026-07-05', allocation_category_id: 'cat-1', allocated_amount: '200.00' },
        { received_date: '2026-09-05', allocation_category_id: 'cat-1', allocated_amount: '200.00' },
      ],
      allTransactions: [
        { id: 'tx-july', transaction_date: '2026-07-10', direction: 'debit', amount: '40.00', category_id: 'cat-1' },
        { id: 'tx-sept', transaction_date: '2026-09-10', direction: 'debit', amount: '50.00', category_id: 'cat-1' },
      ],
    });

    const july = closedMonths.find((m) => m.reviewMonth === '2026-07-01');
    const sept = closedMonths.find((m) => m.reviewMonth === '2026-09-01');
    assert.equal(july.categoryActuals.get('dining'), 4000);
    assert.equal(july.categoryPlanned.get('dining'), 20000);
    assert.equal(sept.categoryActuals.get('restaurants'), 5000);
    assert.equal(sept.categoryPlanned.get('restaurants'), 20000);
  });
});
