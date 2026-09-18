import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDebtPayment,
  deriveDebtMonthlyActivitySummary,
  deriveEconomicMonthlyActivitySummary,
} from '../lib/debts/debtActivity.js';

const MONTH = '2026-03-01';
const WS = 'ws-cert-1';

function makePayment(id, { amount, date = '2026-03-15', debtId = 'debt-1', transactionId = null }) {
  return { id, householdId: WS, debtId, amount, paymentDate: date, transactionId };
}

function makeImportPayment(id, { amount, date = '2026-03-15', debtId = 'debt-1', transactionId }) {
  const txMap = new Map();
  txMap.set(transactionId, { source: 'import', importBatchId: 'batch-1' });
  return { payment: { id, householdId: WS, debtId, amount, paymentDate: date, transactionId }, txMap };
}

function makeBufferPayment(id, { amount, date = '2026-03-15', debtId = 'debt-1', transactionId }) {
  const txMap = new Map();
  txMap.set(transactionId, { source: 'buffer_disposition' });
  return { payment: { id, householdId: WS, debtId, amount, paymentDate: date, transactionId }, txMap };
}

function makeMonthlyReviewPayment(id, { amount, date = '2026-03-15', debtId = 'debt-1', transactionId }) {
  const txMap = new Map();
  txMap.set(transactionId, { source: 'manual', description: 'Monthly review allocation: March' });
  return { payment: { id, householdId: WS, debtId, amount, paymentDate: date, transactionId }, txMap };
}

function buildActivities(payments, txMaps = []) {
  const mergedMap = new Map();
  for (const m of txMaps) { for (const [k, v] of m) mergedMap.set(k, v); }
  return payments.map((p) => normalizeDebtPayment(p, mergedMap));
}

function assertParity(activities, reconciliations = []) {
  const old = deriveDebtMonthlyActivitySummary(activities, MONTH);
  const economic = deriveEconomicMonthlyActivitySummary(activities, MONTH, reconciliations);
  assert.equal(economic.paymentsCents, old.paymentsCents);
  assert.equal(economic.activityCount, old.activityCount);
  return { old, economic };
}

describe('Gate 6 — Old vs Economic Parity (no reconciliation)', () => {
  test('zero payments', () => {
    assertParity([]);
  });

  test('one manual payment', () => {
    const activities = buildActivities([makePayment('p1', { amount: '300.00' })]);
    const { old, economic } = assertParity(activities);
    assert.equal(old.paymentsCents, 30000);
    assert.equal(economic.paymentsCents, 30000);
  });

  test('multiple manual payments', () => {
    const activities = buildActivities([
      makePayment('p1', { amount: '100.00' }),
      makePayment('p2', { amount: '200.00' }),
      makePayment('p3', { amount: '50.00' }),
    ]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 35000);
  });

  test('one imported payment', () => {
    const imp = makeImportPayment('p1', { amount: '500.00', transactionId: 'tx-1' });
    const activities = buildActivities([imp.payment], [imp.txMap]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 50000);
  });

  test('mixed manual + import that are genuinely separate', () => {
    const imp = makeImportPayment('p2', { amount: '200.00', date: '2026-03-20', transactionId: 'tx-2' });
    const activities = buildActivities(
      [makePayment('p1', { amount: '300.00', date: '2026-03-10' }), imp.payment],
      [imp.txMap],
    );
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 50000);
  });

  test('monthly-review payment', () => {
    const mr = makeMonthlyReviewPayment('p1', { amount: '150.00', transactionId: 'tx-mr' });
    const activities = buildActivities([mr.payment], [mr.txMap]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 15000);
  });

  test('buffer payment', () => {
    const buf = makeBufferPayment('p1', { amount: '75.00', transactionId: 'tx-buf' });
    const activities = buildActivities([buf.payment], [buf.txMap]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 7500);
  });

  test('month boundary — only March payments counted', () => {
    const activities = buildActivities([
      makePayment('p-feb', { amount: '100.00', date: '2026-02-28' }),
      makePayment('p-mar', { amount: '200.00', date: '2026-03-01' }),
      makePayment('p-apr', { amount: '300.00', date: '2026-04-01' }),
    ]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 20000);
    assert.equal(old.activityCount, 1);
  });

  test('multiple debts', () => {
    const activities = buildActivities([
      makePayment('p1', { amount: '100.00', debtId: 'debt-1' }),
      makePayment('p2', { amount: '200.00', debtId: 'debt-2' }),
    ]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 30000);
  });

  test('account-backed debt payment (import source)', () => {
    const imp = makeImportPayment('p1', { amount: '350.00', transactionId: 'tx-acct' });
    const activities = buildActivities([imp.payment], [imp.txMap]);
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 35000);
  });

  test('manual-derived debt with multiple payment types', () => {
    const mr = makeMonthlyReviewPayment('p1', { amount: '100.00', transactionId: 'tx-mr2' });
    const imp = makeImportPayment('p2', { amount: '200.00', transactionId: 'tx-imp2' });
    const activities = buildActivities(
      [makePayment('p3', { amount: '50.00' }), mr.payment, imp.payment],
      [mr.txMap, imp.txMap],
    );
    const { old } = assertParity(activities);
    assert.equal(old.paymentsCents, 35000);
  });
});

describe('Gate 7 — Intentional Difference', () => {
  function buildDuplicateScenario() {
    const manual = makePayment('dp-manual', { amount: '300.00' });
    const imp = makeImportPayment('dp-import', { amount: '300.00', transactionId: 'tx-dup' });
    const activities = buildActivities([manual, imp.payment], [imp.txMap]);
    return activities;
  }

  test('confirmed reconciliation: old=$600, economic=$300', () => {
    const activities = buildDuplicateScenario();
    const reconciliations = [{
      id: 'rec-1',
      primaryPaymentId: 'dp-manual',
      duplicatePaymentId: 'dp-import',
      status: 'confirmed',
      matchType: 'POSSIBLE_MATCH',
    }];

    const old = deriveDebtMonthlyActivitySummary(activities, MONTH);
    const economic = deriveEconomicMonthlyActivitySummary(activities, MONTH, reconciliations);

    assert.equal(old.paymentsCents, 60000);
    assert.equal(economic.paymentsCents, 30000);
    assert.equal(old.activityCount, 2);
    assert.equal(economic.activityCount, 1);
  });

  test('rejected reconciliation: old=$600, economic=$600', () => {
    const activities = buildDuplicateScenario();
    const reconciliations = [{
      id: 'rec-1',
      primaryPaymentId: 'dp-manual',
      duplicatePaymentId: 'dp-import',
      status: 'rejected',
      matchType: 'POSSIBLE_MATCH',
    }];

    const old = deriveDebtMonthlyActivitySummary(activities, MONTH);
    const economic = deriveEconomicMonthlyActivitySummary(activities, MONTH, reconciliations);

    assert.equal(old.paymentsCents, 60000);
    assert.equal(economic.paymentsCents, 60000);
  });

  test('unreconciled POSSIBLE_MATCH: old=$600, economic=$600', () => {
    const activities = buildDuplicateScenario();
    const reconciliations = [];

    const old = deriveDebtMonthlyActivitySummary(activities, MONTH);
    const economic = deriveEconomicMonthlyActivitySummary(activities, MONTH, reconciliations);

    assert.equal(old.paymentsCents, 60000);
    assert.equal(economic.paymentsCents, 60000);
  });
});

describe('Gate 8 — Primary Date Semantics', () => {
  test('cross-month reconciliation: economic event uses primary payment date', () => {
    const manual = makePayment('dp-mar31', { amount: '300.00', date: '2026-03-31' });
    const imp = makeImportPayment('dp-apr1', { amount: '300.00', date: '2026-04-01', transactionId: 'tx-cross' });
    const activities = buildActivities([manual, imp.payment], [imp.txMap]);

    const reconciliations = [{
      id: 'rec-cross',
      primaryPaymentId: 'dp-mar31',
      duplicatePaymentId: 'dp-apr1',
      status: 'confirmed',
      matchType: 'POSSIBLE_MATCH',
    }];

    const marchOld = deriveDebtMonthlyActivitySummary(activities, '2026-03-01');
    const aprilOld = deriveDebtMonthlyActivitySummary(activities, '2026-04-01');
    const marchEcon = deriveEconomicMonthlyActivitySummary(activities, '2026-03-01', reconciliations);
    const aprilEcon = deriveEconomicMonthlyActivitySummary(activities, '2026-04-01', reconciliations);

    assert.equal(marchOld.paymentsCents, 30000);
    assert.equal(aprilOld.paymentsCents, 30000);

    assert.equal(marchEcon.paymentsCents, 30000);
    assert.equal(aprilEcon.paymentsCents, 0);

    assert.equal(marchEcon.activityCount, 1);
    assert.equal(aprilEcon.activityCount, 0);
  });

  test('reversed primary: economic event uses primary payment date (April)', () => {
    const manual = makePayment('dp-mar31', { amount: '300.00', date: '2026-03-31' });
    const imp = makeImportPayment('dp-apr1', { amount: '300.00', date: '2026-04-01', transactionId: 'tx-cross2' });
    const activities = buildActivities([manual, imp.payment], [imp.txMap]);

    const reconciliations = [{
      id: 'rec-cross2',
      primaryPaymentId: 'dp-apr1',
      duplicatePaymentId: 'dp-mar31',
      status: 'confirmed',
      matchType: 'POSSIBLE_MATCH',
    }];

    const marchEcon = deriveEconomicMonthlyActivitySummary(activities, '2026-03-01', reconciliations);
    const aprilEcon = deriveEconomicMonthlyActivitySummary(activities, '2026-04-01', reconciliations);

    assert.equal(marchEcon.paymentsCents, 0);
    assert.equal(aprilEcon.paymentsCents, 30000);
  });
});
