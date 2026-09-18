import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDebtPayment,
  normalizeDebtAdjustment,
  deriveDebtActivity,
  deriveDebtMonthlyActivitySummary,
  deriveEconomicDebtActivity,
  deriveEconomicMonthlyActivitySummary,
  assessActivityCompleteness,
} from '../lib/debts/debtActivity.js';

const WORKSPACE = 'ws-activity-test';
const DEBT_ID = 'debt-activity-test';

function makePayment(overrides = {}) {
  return {
    id: 'dp-1',
    debtId: DEBT_ID,
    householdId: WORKSPACE,
    amount: '300.00',
    paymentDate: '2026-03-15',
    transactionId: null,
    ...overrides,
  };
}

function makeAdjustment(overrides = {}) {
  return {
    id: 'adj-1',
    debtId: DEBT_ID,
    householdId: WORKSPACE,
    amount: '25.00',
    adjustmentType: 'interest',
    effectiveDate: '2026-03-15',
    ...overrides,
  };
}

describe('normalizeDebtPayment', () => {
  test('manual payment (no transactionId) has source=manual', () => {
    const activity = normalizeDebtPayment(makePayment());
    assert.equal(activity.type, 'payment');
    assert.equal(activity.source, 'manual');
    assert.equal(activity.amountCents, 30000);
    assert.equal(activity.effectiveDate, '2026-03-15');
    assert.equal(activity.debtId, DEBT_ID);
    assert.equal(activity.workspaceId, WORKSPACE);
    assert.deepEqual(activity.provenance, { recordType: 'debt_payment', recordId: 'dp-1' });
  });

  test('import payment with transaction has source=import', () => {
    const txMap = new Map([['txn-1', { id: 'txn-1', source: 'import' }]]);
    const activity = normalizeDebtPayment(makePayment({ transactionId: 'txn-1' }), txMap);
    assert.equal(activity.source, 'import');
    assert.equal(activity.transactionId, 'txn-1');
  });

  test('buffer payment has source=buffer', () => {
    const txMap = new Map([['txn-buf', { id: 'txn-buf', source: 'buffer_disposition' }]]);
    const activity = normalizeDebtPayment(makePayment({ transactionId: 'txn-buf' }), txMap);
    assert.equal(activity.source, 'buffer');
  });

  test('monthly_review payment has source=monthly_review', () => {
    const txMap = new Map([['txn-mr', { id: 'txn-mr', source: 'manual', description: 'Monthly review allocation: March 2026' }]]);
    const activity = normalizeDebtPayment(makePayment({ transactionId: 'txn-mr' }), txMap);
    assert.equal(activity.source, 'monthly_review');
  });

  test('unknown transaction source falls back to unknown', () => {
    const txMap = new Map([['txn-unk', { id: 'txn-unk', source: 'webhook' }]]);
    const activity = normalizeDebtPayment(makePayment({ transactionId: 'txn-unk' }), txMap);
    assert.equal(activity.source, 'unknown');
  });

  test('id is prefixed with payment:', () => {
    const activity = normalizeDebtPayment(makePayment({ id: 'dp-abc' }));
    assert.equal(activity.id, 'payment:dp-abc');
  });
});

describe('normalizeDebtAdjustment', () => {
  test('interest adjustment has type=interest', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ adjustmentType: 'interest' }));
    assert.equal(activity.type, 'interest');
    assert.equal(activity.amountCents, 2500);
  });

  test('fee adjustment has type=fee', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ adjustmentType: 'fee' }));
    assert.equal(activity.type, 'fee');
  });

  test('late_fee adjustment has type=fee', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ adjustmentType: 'late_fee' }));
    assert.equal(activity.type, 'fee');
  });

  test('reconciliation adjustment has type=balance_reconciliation', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ adjustmentType: 'reconciliation' }));
    assert.equal(activity.type, 'balance_reconciliation');
  });

  test('correction adjustment has type=adjustment', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ adjustmentType: 'correction' }));
    assert.equal(activity.type, 'adjustment');
  });

  test('id is prefixed with adjustment:', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ id: 'adj-xyz' }));
    assert.equal(activity.id, 'adjustment:adj-xyz');
  });

  test('generated=true adjustment has source=system', () => {
    const activity = normalizeDebtAdjustment(makeAdjustment({ generated: true }));
    assert.equal(activity.source, 'system');
  });
});

describe('deriveDebtActivity', () => {
  test('combines payments and adjustments sorted by date', () => {
    const payments = [
      makePayment({ id: 'dp-b', paymentDate: '2026-03-20' }),
      makePayment({ id: 'dp-a', paymentDate: '2026-03-10' }),
    ];
    const adjustments = [
      makeAdjustment({ id: 'adj-c', effectiveDate: '2026-03-15' }),
    ];
    const activities = deriveDebtActivity({ payments, adjustments });
    assert.equal(activities.length, 3);
    assert.equal(activities[0].effectiveDate, '2026-03-10');
    assert.equal(activities[1].effectiveDate, '2026-03-15');
    assert.equal(activities[2].effectiveDate, '2026-03-20');
  });

  test('empty inputs return empty array', () => {
    assert.equal(deriveDebtActivity({}).length, 0);
  });

  test('same-date activities are secondarily sorted by id', () => {
    const payments = [
      makePayment({ id: 'dp-z', paymentDate: '2026-03-15' }),
      makePayment({ id: 'dp-a', paymentDate: '2026-03-15' }),
    ];
    const activities = deriveDebtActivity({ payments });
    assert.equal(activities[0].id, 'payment:dp-a');
    assert.equal(activities[1].id, 'payment:dp-z');
  });
});

describe('deriveDebtMonthlyActivitySummary', () => {
  test('sums payments for correct month only', () => {
    const activities = deriveDebtActivity({
      payments: [
        makePayment({ id: 'dp-mar', amount: '300.00', paymentDate: '2026-03-15' }),
        makePayment({ id: 'dp-apr', amount: '200.00', paymentDate: '2026-04-15' }),
      ],
    });
    const summary = deriveDebtMonthlyActivitySummary(activities, '2026-03-01');
    assert.equal(summary.paymentsCents, 30000);
    assert.equal(summary.activityCount, 1);
  });

  test('sums interest correctly', () => {
    const activities = deriveDebtActivity({
      adjustments: [
        makeAdjustment({ id: 'adj-1', adjustmentType: 'interest', amount: '25.00', effectiveDate: '2026-03-01' }),
        makeAdjustment({ id: 'adj-2', adjustmentType: 'interest', amount: '10.00', effectiveDate: '2026-03-15' }),
      ],
    });
    const summary = deriveDebtMonthlyActivitySummary(activities, '2026-03-01');
    assert.equal(summary.interestCents, 3500);
  });

  test('returns zero-valued summary for month with no activity', () => {
    const activities = deriveDebtActivity({ payments: [makePayment({ paymentDate: '2026-03-15' })] });
    const summary = deriveDebtMonthlyActivitySummary(activities, '2026-04-01');
    assert.equal(summary.paymentsCents, 0);
    assert.equal(summary.activityCount, 0);
  });
});

describe('deriveEconomicDebtActivity', () => {
  test('excludes duplicatePaymentId from confirmed reconciliation', () => {
    const activities = deriveDebtActivity({
      payments: [
        makePayment({ id: 'dp-manual' }),
        makePayment({ id: 'dp-import', transactionId: 'txn-1' }),
      ],
    });
    const reconciliations = [{
      status: 'confirmed',
      primaryPaymentId: 'dp-manual',
      duplicatePaymentId: 'dp-import',
    }];
    const economic = deriveEconomicDebtActivity({ activities, reconciliations });
    assert.equal(economic.length, 1);
    assert.equal(economic[0].provenance.recordId, 'dp-manual');
  });

  test('rejected reconciliation does not exclude either payment', () => {
    const activities = deriveDebtActivity({
      payments: [
        makePayment({ id: 'dp-manual' }),
        makePayment({ id: 'dp-import', transactionId: 'txn-1' }),
      ],
    });
    const reconciliations = [{
      status: 'rejected',
      primaryPaymentId: 'dp-manual',
      duplicatePaymentId: 'dp-import',
    }];
    const economic = deriveEconomicDebtActivity({ activities, reconciliations });
    assert.equal(economic.length, 2);
  });

  test('no reconciliations: all activities returned', () => {
    const activities = deriveDebtActivity({
      payments: [makePayment({ id: 'dp-1' }), makePayment({ id: 'dp-2' })],
    });
    const economic = deriveEconomicDebtActivity({ activities, reconciliations: [] });
    assert.equal(economic.length, 2);
  });

  test('adjustments are never excluded by reconciliation', () => {
    const activities = deriveDebtActivity({
      adjustments: [makeAdjustment({ id: 'adj-1', adjustmentType: 'interest' })],
    });
    const reconciliations = [{
      status: 'confirmed',
      primaryPaymentId: 'adj-1',
      duplicatePaymentId: 'dp-import',
    }];
    const economic = deriveEconomicDebtActivity({ activities, reconciliations });
    assert.equal(economic.length, 1);
  });
});

describe('deriveEconomicMonthlyActivitySummary', () => {
  test('confirmed pair: month summary reflects single economic payment', () => {
    const activities = deriveDebtActivity({
      payments: [
        makePayment({ id: 'dp-manual', amount: '300.00', paymentDate: '2026-03-15' }),
        makePayment({ id: 'dp-import', amount: '300.00', paymentDate: '2026-03-15', transactionId: 'txn-1' }),
      ],
    });
    const reconciliations = [{
      status: 'confirmed',
      primaryPaymentId: 'dp-manual',
      duplicatePaymentId: 'dp-import',
    }];
    const summary = deriveEconomicMonthlyActivitySummary(activities, '2026-03-01', reconciliations);
    assert.equal(summary.paymentsCents, 30000);
    assert.equal(summary.activityCount, 1);
  });
});

describe('assessActivityCompleteness', () => {
  test('empty activities returns balance_only', () => {
    const result = assessActivityCompleteness({ activities: [] });
    assert.equal(result, 'balance_only');
  });

  test('account-backed with balance match returns complete', () => {
    const activities = deriveDebtActivity({
      payments: [makePayment({ amount: '300.00', paymentDate: '2026-03-15' })],
    });
    const result = assessActivityCompleteness({
      activities,
      balanceAuthority: { source: 'financial_account', balance: '4700.00' },
      openingBalanceCents: 500000,
      closingBalanceCents: 470000,
    });
    assert.equal(result, 'complete');
  });

  test('account-backed with balance mismatch returns partial', () => {
    const activities = deriveDebtActivity({
      payments: [makePayment({ amount: '300.00', paymentDate: '2026-03-15' })],
    });
    const result = assessActivityCompleteness({
      activities,
      balanceAuthority: { source: 'financial_account', balance: '4200.00' },
      openingBalanceCents: 500000,
      closingBalanceCents: 470000,
    });
    assert.equal(result, 'partial');
  });

  test('manual authority always returns complete', () => {
    const activities = deriveDebtActivity({
      payments: [makePayment({ amount: '100.00', paymentDate: '2026-03-15' })],
    });
    const result = assessActivityCompleteness({
      activities,
      balanceAuthority: { source: 'manual_derived', balance: null },
    });
    assert.equal(result, 'complete');
  });
});
