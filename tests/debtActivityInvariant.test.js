import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { listDebtActivity } from '../lib/debts/debts.js';

const WORKSPACE = 'ws-invariant-01';
const DEBT_ID = 'debt-invariant-cc';

async function setupDb() {
  const db = createInMemoryDb(WORKSPACE);
  await db.transaction(async (tx) => {
    await tx.insertDebt({
      householdId: WORKSPACE, id: DEBT_ID, name: 'Card', debtType: 'credit_card',
      startingBalance: '5000.00', currentBalance: '4700.00',
      minimumPayment: '100.00', monthlyPayment: '300.00', apr: '19.99',
    });
    await tx.insertDebtPayment({
      householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-1',
      amount: '300.00', paymentDate: '2026-03-15',
    });
    await tx.insertDebtAdjustment({
      householdId: WORKSPACE, debtId: DEBT_ID, id: 'adj-1',
      amount: '25.00', adjustmentType: 'interest', effectiveDate: '2026-03-01',
    });
  });
  return db;
}

describe('Debt Activity Financial Invariants', () => {
  test('listDebtActivity does not change debt balance', async () => {
    const db = await setupDb();

    const debtBefore = await db.transaction((tx) => tx.getDebtById({ householdId: WORKSPACE, debtId: DEBT_ID }));

    await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID });

    const debtAfter = await db.transaction((tx) => tx.getDebtById({ householdId: WORKSPACE, debtId: DEBT_ID }));

    assert.equal(debtBefore.currentBalance, debtAfter.currentBalance);
    assert.equal(debtBefore.startingBalance, debtAfter.startingBalance);
  });

  test('listDebtActivity does not change payment records', async () => {
    const db = await setupDb();

    const paymentsBefore = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));

    await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID });

    const paymentsAfter = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));

    assert.equal(paymentsBefore.length, paymentsAfter.length);
    assert.equal(paymentsBefore[0].amount, paymentsAfter[0].amount);
  });

  test('listDebtActivity does not change adjustment records', async () => {
    const db = await setupDb();

    const adjBefore = await db.transaction((tx) => tx.listDebtAdjustments({ householdId: WORKSPACE, debtId: DEBT_ID }));

    await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID });

    const adjAfter = await db.transaction((tx) => tx.listDebtAdjustments({ householdId: WORKSPACE, debtId: DEBT_ID }));

    assert.equal(adjBefore.length, adjAfter.length);
  });

  test('calling listDebtActivity twice returns identical results', async () => {
    const db = await setupDb();

    const first = await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID });
    const second = await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID });

    assert.equal(first.activities.length, second.activities.length);
    assert.equal(
      first.activities.map((a) => a.id).join(','),
      second.activities.map((a) => a.id).join(','),
    );
  });

  test('economic view payment sum matches raw payment sum when no reconciliations', async () => {
    const db = await setupDb();

    const rawResult = await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID, view: 'raw' });
    const economicResult = await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID, view: 'economic' });

    const rawPaymentCents = rawResult.activities.filter((a) => a.type === 'payment').reduce((s, a) => s + a.amountCents, 0);
    const economicPaymentCents = economicResult.activities.filter((a) => a.type === 'payment').reduce((s, a) => s + a.amountCents, 0);

    assert.equal(rawPaymentCents, economicPaymentCents);
  });

  test('economic view never shows MORE payments than raw view', async () => {
    const db = await setupDb();

    await db.transaction(async (tx) => {
      await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-2', amount: '300.00', paymentDate: '2026-03-15', transactionId: 'txn-import' });
      await tx.insertDebtPaymentReconciliation({
        householdId: WORKSPACE,
        primaryPaymentId: 'dp-1',
        duplicatePaymentId: 'dp-2',
        status: 'confirmed',
        matchType: 'POSSIBLE_MATCH',
      });
    });

    const rawResult = await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID, view: 'raw' });
    const economicResult = await listDebtActivity({ db, householdId: WORKSPACE, debtId: DEBT_ID, view: 'economic' });

    const rawPayments = rawResult.activities.filter((a) => a.type === 'payment').length;
    const economicPayments = economicResult.activities.filter((a) => a.type === 'payment').length;

    assert.ok(economicPayments <= rawPayments, `economic (${economicPayments}) must be <= raw (${rawPayments})`);
  });
});
