import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeClosedMonthAverages,
  computeDebtBalanceAsOf,
  buildThenVsNow,
} from '../lib/intelligence/progressMetrics.js';
import { Provenance } from '../lib/intelligence/provenance.js';

describe('progress metrics', () => {
  // 37. Averages from closed reviews
  it('37. computeClosedMonthAverages produces metric averages with correct provenance', () => {
    const closedReviews = [
      { id: 'rev-1', review_month: '2026-07-01', net_surplus: '500.00', status: 'applied' },
      { id: 'rev-2', review_month: '2026-08-01', net_surplus: '300.00', status: 'applied' },
    ];
    const incomeEntries = [
      { received_date: '2026-07-05', amount: '5000.00' },
      { received_date: '2026-08-05', amount: '5200.00' },
    ];
    const transactions = [
      { transaction_date: '2026-07-10', direction: 'debit', amount: '1200.00' },
      { transaction_date: '2026-07-20', direction: 'debit', amount: '800.00' },
      { transaction_date: '2026-08-10', direction: 'debit', amount: '1500.00' },
      { transaction_date: '2026-08-25', direction: 'credit', amount: '100.00' }, // credits ignored for spending
    ];

    const result = computeClosedMonthAverages(closedReviews, incomeEntries, transactions);
    assert.equal(result.monthsAvailable, 2);

    const incomeMetric = result.metrics.find((m) => m.key === 'avg_monthly_income');
    assert.equal(incomeMetric.provenance, Provenance.SNAPSHOT);
    assert.equal(incomeMetric.safe, true);

    const surplusMetric = result.metrics.find((m) => m.key === 'avg_monthly_surplus');
    assert.equal(surplusMetric.provenance, Provenance.SNAPSHOT);

    const spendMetric = result.metrics.find((m) => m.key === 'avg_monthly_spending');
    assert.equal(spendMetric.provenance, Provenance.LEDGER_RECONSTRUCTED);
  });

  // 38. Empty closed reviews → zero months
  it('38. empty closed reviews returns monthsAvailable=0', () => {
    const result = computeClosedMonthAverages([], [], []);
    assert.equal(result.monthsAvailable, 0);
    assert.deepEqual(result.metrics, []);
  });

  // 39. computeDebtBalanceAsOf: payments reduce balance
  it('39. computeDebtBalanceAsOf reconstructs balance from ledger', () => {
    const debt = { starting_balance: '5000.00' };
    const payments = [
      { payment_date: '2026-01-15', amount: '500.00' },
      { payment_date: '2026-02-15', amount: '500.00' },
    ];
    const adjustments = [];

    const result = computeDebtBalanceAsOf(debt, payments, adjustments, '2026-03-01');
    assert.equal(result.provenance, Provenance.LEDGER_RECONSTRUCTED);
    assert.equal(result.balanceCents, 400000); // $4000.00
    assert.equal(result.safe, true);
  });

  // 40. computeDebtBalanceAsOf: adjustments (interest) increase balance
  it('40. interest adjustments increase the reconstructed balance', () => {
    const debt = { starting_balance: '1000.00' };
    const payments = [{ payment_date: '2026-01-01', amount: '200.00' }];
    const adjustments = [{ effective_date: '2026-01-15', amount: '50.00' }]; // interest charge

    const result = computeDebtBalanceAsOf(debt, payments, adjustments, '2026-02-01');
    // $1000 - $200 + $50 = $850
    assert.equal(result.balanceCents, 85000);
  });

  // 41. computeDebtBalanceAsOf: clamps to 0 (no negative balance)
  it('41. debt balance never goes below 0', () => {
    const debt = { starting_balance: '100.00' };
    const payments = [{ payment_date: '2026-01-01', amount: '500.00' }]; // overpayment
    const result = computeDebtBalanceAsOf(debt, payments, [], '2026-02-01');
    assert.equal(result.balanceCents, 0);
  });

  // 42. buildThenVsNow: safe comparison produces delta
  it('42. buildThenVsNow produces delta when both sides are SNAPSHOT provenance', () => {
    const then = { value: 400000, provenance: Provenance.SNAPSHOT };
    const now = { value: 450000, provenance: Provenance.SNAPSHOT };
    const result = buildThenVsNow('avg_monthly_income', 'Average income', then, now);
    assert.equal(result.safe, true);
    assert.ok(result.delta.percent > 0);
    assert.equal(result.key, 'avg_monthly_income');
  });

  // 43. buildThenVsNow: unsafe when CURRENT_ONLY provenance
  it('43. buildThenVsNow returns safe=false when then is CURRENT_ONLY', () => {
    const then = { value: 400000, provenance: Provenance.CURRENT_ONLY };
    const now = { value: 450000, provenance: Provenance.SNAPSHOT };
    const result = buildThenVsNow('metric', 'Label', then, now);
    assert.equal(result.safe, false);
    assert.ok(result.reason);
  });

  // 44. buildThenVsNow: unsafe when UNAVAILABLE
  it('44. buildThenVsNow returns safe=false when either side is UNAVAILABLE', () => {
    const then = { value: 0, provenance: Provenance.UNAVAILABLE };
    const now = { value: 0, provenance: Provenance.SNAPSHOT };
    const result = buildThenVsNow('metric', 'Label', then, now);
    assert.equal(result.safe, false);
  });
});
