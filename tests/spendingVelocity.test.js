import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCategoryVelocity,
  computeSpendingVelocity,
  extractVelocityAlerts,
  isCategoryVelocityApplicable,
} from '../lib/intelligence/spendingVelocity.js';

const MONTH = '2026-09-01';

// 1. Too early to estimate (< 3 days elapsed)
describe('spending velocity', () => {
  it('1. returns tooEarly when fewer than 3 days have elapsed', () => {
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-02',
      allocatedCents: 100000,
      usedCents: 5000,
    });
    assert.equal(result.tooEarly, true);
    assert.equal(result.reason, 'Too early to estimate');
  });

  // 2. No spending
  it('2. handles zero spending — dailyAverage is 0, no runway', () => {
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-15',
      allocatedCents: 100000,
      usedCents: 0,
    });
    assert.equal(result.tooEarly, false);
    assert.equal(result.dailyAverage, '0.00');
    assert.equal(result.estimatedRunwayDays, null);
    assert.equal(result.over, false);
  });

  // 3. Planned = 0 returns null
  it('3. returns null when allocated is 0', () => {
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-15',
      allocatedCents: 0,
      usedCents: 500,
    });
    assert.equal(result, null);
  });

  // 4. On pace mid-month
  it('4. mid-month on pace — paceRatio near 1.0, signal = on_pace', () => {
    // 15 of 30 days elapsed = 50%. Used 500/1000 = 50%.
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-15',
      allocatedCents: 100000,
      usedCents: 50000,
    });
    assert.equal(result.tooEarly, false);
    assert.equal(result.signal, 'on_pace');
    assert.equal(result.utilizationPercent, 50.0);
    assert.equal(result.elapsedPercent, 50.0);
  });

  // 5. Ahead of pace
  it('5. ahead of pace — utilizationPercent > elapsedPercent, signal = ahead or over_pace', () => {
    // 10 days elapsed (33%). Used 60% already.
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-10',
      allocatedCents: 100000,
      usedCents: 60000,
    });
    assert.equal(result.tooEarly, false);
    assert.ok(['ahead', 'over_pace'].includes(result.signal));
    assert.ok(result.utilizationPercent > result.elapsedPercent);
  });

  // 6. Behind pace
  it('6. under pace — utilizationPercent << elapsedPercent, signal = under_pace', () => {
    // 20 days elapsed (67%). Used only 10%.
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-20',
      allocatedCents: 100000,
      usedCents: 10000,
    });
    assert.equal(result.signal, 'under_pace');
  });

  // 7. Over allocation (usedCents > allocatedCents)
  it('7. over allocation — over flag is true', () => {
    const result = computeCategoryVelocity({
      isoMonth: MONTH,
      today: '2026-09-20',
      allocatedCents: 50000,
      usedCents: 60000,
    });
    assert.equal(result.over, true);
    assert.ok(result.utilizationPercent > 100);
  });

  // 8. Non-applicable categories omitted
  it('8. non-applicable category slugs (savings, debt-payoff, etc.) return false for applicability', () => {
    const nonApplicable = ['savings', 'buffer', 'debt-payoff', 'fixed-bills', 'investment'];
    for (const slug of nonApplicable) {
      assert.equal(
        isCategoryVelocityApplicable({ slug }),
        false,
        `Expected ${slug} to not be velocity-applicable`,
      );
    }
    assert.equal(isCategoryVelocityApplicable({ slug: 'personal-spending' }), true);
    assert.equal(isCategoryVelocityApplicable({ slug: 'entertainment' }), true);
  });

  // Compound: only applicable categories appear in results
  it('9. computeSpendingVelocity includes only applicable categories', () => {
    const buckets = [
      { id: '1', slug: 'personal-spending', label: 'Personal' },
      { id: '2', slug: 'savings', label: 'Savings' },
      { id: '3', slug: 'entertainment', label: 'Entertainment' },
    ];
    const allocated = new Map([['1', 100000], ['2', 50000], ['3', 30000]]);
    const used = new Map([['1', 30000], ['2', 15000], ['3', 10000]]);

    const results = computeSpendingVelocity({
      isoMonth: MONTH,
      today: '2026-09-15',
      buckets,
      allocatedByBucketId: allocated,
      usedByBucketId: used,
    });

    const slugs = results.map((r) => r.bucketSlug);
    assert.ok(slugs.includes('personal-spending'));
    assert.ok(slugs.includes('entertainment'));
    assert.ok(!slugs.includes('savings'), 'savings should be excluded from velocity');
  });

  // Alert extraction
  it('10. extractVelocityAlerts returns only ahead/over_pace signals', () => {
    const velocityResults = [
      {
        bucketId: '1',
        bucketName: 'Personal',
        velocity: { tooEarly: false, signal: 'ahead', utilizationPercent: 65, elapsedPercent: 50, runwayLabel: null },
      },
      {
        bucketId: '2',
        bucketName: 'Entertainment',
        velocity: { tooEarly: false, signal: 'on_pace', utilizationPercent: 50, elapsedPercent: 50, runwayLabel: null },
      },
      {
        bucketId: '3',
        bucketName: 'Dining',
        velocity: { tooEarly: false, signal: 'over_pace', utilizationPercent: 95, elapsedPercent: 50, runwayLabel: '~3 days remaining at recent pace' },
      },
    ];

    const alerts = extractVelocityAlerts(velocityResults);
    assert.equal(alerts.length, 2);
    const signalSet = new Set(alerts.map((a) => a.signal));
    assert.ok(signalSet.has('ahead'));
    assert.ok(signalSet.has('over_pace'));
    assert.ok(!signalSet.has('on_pace'));
  });
});
