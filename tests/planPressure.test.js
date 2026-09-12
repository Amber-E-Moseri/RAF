import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePlanPressure } from '../lib/intelligence/planPressure.js';

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
});
