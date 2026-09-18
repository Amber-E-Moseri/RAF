import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import {
  confirmDebtPaymentReconciliation,
  rejectDebtPaymentReconciliation,
  unlinkDebtPaymentReconciliation,
  listDebtPaymentReconciliations,
  ReconciliationError,
} from '../lib/debts/debtPaymentReconciliation.js';
import {
  deriveDebtActivity,
  deriveEconomicDebtActivity,
  deriveEconomicMonthlyActivitySummary,
  deriveDebtMonthlyActivitySummary,
} from '../lib/debts/debtActivity.js';
import { findDebtPaymentMatches } from '../lib/debts/debtPaymentMatching.js';

const WORKSPACE = 'ws-recon-01';
const DEBT_ID = 'debt-recon-cc';
const USER_ID = 'user-recon-01';

async function setupDbWithDebtAndPayments(extraPayments = []) {
  const db = createInMemoryDb(WORKSPACE);

  await db.transaction(async (tx) => {
    await tx.insertDebt({
      householdId: WORKSPACE, id: DEBT_ID, name: 'Test Credit Card',
      debtType: 'credit_card', startingBalance: '5000.00', currentBalance: '5000.00',
      minimumPayment: '100.00', monthlyPayment: '300.00', apr: '19.99',
    });
    await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-manual-1', amount: '300.00', paymentDate: '2026-03-15', transactionId: null });
    await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-import-1', amount: '300.00', paymentDate: '2026-03-15', transactionId: 'txn-import-1' });
    for (const payment of extraPayments) {
      await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, ...payment });
    }
  });

  return db;
}

describe('Debt Payment Reconciliation — Phase 2B', () => {
  describe('Confirmation', () => {
    test('manual $300 + import $300 confirmed: raw=2, economic=1, economicPayments=$300', async () => {
      const db = await setupDbWithDebtAndPayments();

      const reconciliation = await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH', userId: USER_ID,
      });

      assert.equal(reconciliation.status, 'confirmed');
      assert.equal(reconciliation.primaryPaymentId, 'dp-manual-1');
      assert.equal(reconciliation.duplicatePaymentId, 'dp-import-1');
      assert.equal(reconciliation.matchType, 'POSSIBLE_MATCH');
      assert.equal(reconciliation.confirmedBy, 'user');

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const txMap = new Map([['txn-import-1', { id: 'txn-import-1', source: 'import' }]]);
      const rawActivities = deriveDebtActivity({ payments, transactionsByIdMap: txMap });

      assert.equal(rawActivities.length, 2);

      const economic = deriveEconomicDebtActivity({ activities: rawActivities, reconciliations: [reconciliation] });
      assert.equal(economic.length, 1);
      assert.equal(economic[0].provenance.recordId, 'dp-manual-1');

      const summary = deriveEconomicMonthlyActivitySummary(rawActivities, '2026-03-01', [reconciliation]);
      assert.equal(summary.paymentsCents, 30000);
    });

    test('stores workspace, IDs, status, matchType, confirmedBy, and timestamps', async () => {
      const db = await setupDbWithDebtAndPayments();

      const rec = await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH', userId: USER_ID,
      });

      assert.ok(rec.id);
      assert.equal(rec.workspaceId ?? rec.householdId, WORKSPACE);
      assert.ok(rec.confirmedAt);
      assert.ok(rec.createdAt);
    });
  });

  describe('Rejection', () => {
    test('rejected pair: raw=2, economic=2, payments=$600', async () => {
      const db = await setupDbWithDebtAndPayments();

      const rejection = await rejectDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH', userId: USER_ID,
      });

      assert.equal(rejection.status, 'rejected');

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const txMap = new Map([['txn-import-1', { id: 'txn-import-1', source: 'import' }]]);
      const rawActivities = deriveDebtActivity({ payments, transactionsByIdMap: txMap });

      assert.equal(rawActivities.length, 2);
      const economic = deriveEconomicDebtActivity({ activities: rawActivities, reconciliations: [rejection] });
      assert.equal(economic.length, 2);

      const summary = deriveEconomicMonthlyActivitySummary(rawActivities, '2026-03-01', [rejection]);
      assert.equal(summary.paymentsCents, 60000);
    });

    test('rejected pair is suppressed from matcher suggestions', async () => {
      const db = await setupDbWithDebtAndPayments();

      const rejection = await rejectDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const txMap = new Map([['txn-import-1', { id: 'txn-import-1', source: 'import' }]]);
      const activities = deriveDebtActivity({ payments, transactionsByIdMap: txMap });

      const matches = findDebtPaymentMatches({ activities, reconciliations: [rejection] });
      assert.equal(matches.matches.length, 0);
    });
  });

  describe('Reversal protection', () => {
    test('rejects (B,A) when (A,B) already exists', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-import-1', duplicatePaymentId: 'dp-manual-1',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /reconciliation already exists/); return true; },
      );
    });

    test('rejects duplicate (A,B) when (A,B) already exists', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /reconciliation already exists/); return true; },
      );
    });
  });

  describe('Self-reconciliation', () => {
    test('A → A must fail', async () => {
      const db = await setupDbWithDebtAndPayments();

      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-manual-1',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /cannot reconcile a payment with itself/); return true; },
      );
    });
  });

  describe('Cross-workspace isolation', () => {
    test('rejects confirmation when payment does not exist in workspace', async () => {
      const db = createInMemoryDb(WORKSPACE);

      await db.transaction(async (tx) => {
        await tx.insertDebt({ householdId: WORKSPACE, id: DEBT_ID, name: 'Card', debtType: 'credit_card', startingBalance: '1000.00', currentBalance: '1000.00', minimumPayment: '50.00', monthlyPayment: '100.00', apr: '15.00' });
        await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-ws1', amount: '100.00', paymentDate: '2026-03-15' });
      });

      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-ws1', duplicatePaymentId: 'dp-nonexistent',
          matchType: 'POSSIBLE_MATCH',
        }),
      );
    });
  });

  describe('Different debt', () => {
    test('rejects confirmation when payments belong to different debts', async () => {
      const db = createInMemoryDb(WORKSPACE);

      await db.transaction(async (tx) => {
        await tx.insertDebt({ householdId: WORKSPACE, id: 'debt-a', name: 'Card A', debtType: 'credit_card', startingBalance: '1000.00', currentBalance: '1000.00', minimumPayment: '50.00', monthlyPayment: '100.00', apr: '15.00' });
        await tx.insertDebt({ householdId: WORKSPACE, id: 'debt-b', name: 'Card B', debtType: 'credit_card', startingBalance: '2000.00', currentBalance: '2000.00', minimumPayment: '50.00', monthlyPayment: '200.00', apr: '18.00' });
        await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: 'debt-a', id: 'dp-a', amount: '100.00', paymentDate: '2026-03-15' });
        await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: 'debt-b', id: 'dp-b', amount: '100.00', paymentDate: '2026-03-15' });
      });

      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: 'debt-a',
          primaryPaymentId: 'dp-a', duplicatePaymentId: 'dp-b',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /both payments must belong to the specified debt/); return true; },
      );
    });
  });

  describe('Missing payment', () => {
    test('rejects when primary payment does not exist', async () => {
      const db = await setupDbWithDebtAndPayments();
      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-nonexistent', duplicatePaymentId: 'dp-import-1',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /not found/); return true; },
      );
    });

    test('rejects when duplicate payment does not exist', async () => {
      const db = await setupDbWithDebtAndPayments();
      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-nonexistent',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /not found/); return true; },
      );
    });
  });

  describe('Provenance preservation', () => {
    test('after reconciliation both original debt_payment records still exist', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const manual = payments.find((p) => p.id === 'dp-manual-1');
      const imported = payments.find((p) => p.id === 'dp-import-1');
      assert.ok(manual);
      assert.equal(manual.amount, '300.00');
      assert.ok(imported);
      assert.equal(imported.amount, '300.00');
      assert.equal(imported.transactionId, 'txn-import-1');
    });
  });

  describe('Recorded vs Economic Activity', () => {
    test('recorded activity shows both records; economic activity shows one', async () => {
      const db = await setupDbWithDebtAndPayments();

      const rec = await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const txMap = new Map([['txn-import-1', { id: 'txn-import-1', source: 'import' }]]);
      const rawActivities = deriveDebtActivity({ payments, transactionsByIdMap: txMap });

      const rawSummary = deriveDebtMonthlyActivitySummary(rawActivities, '2026-03-01');
      assert.equal(rawSummary.paymentsCents, 60000);
      assert.equal(rawSummary.activityCount, 2);

      const economicSummary = deriveEconomicMonthlyActivitySummary(rawActivities, '2026-03-01', [rec]);
      assert.equal(economicSummary.paymentsCents, 30000);
      assert.equal(economicSummary.activityCount, 1);
    });
  });

  describe('Monthly boundaries', () => {
    test('reconciliation uses primary economic event effective date for month assignment', async () => {
      const db = createInMemoryDb(WORKSPACE);

      await db.transaction(async (tx) => {
        await tx.insertDebt({ householdId: WORKSPACE, id: DEBT_ID, name: 'Card', debtType: 'credit_card', startingBalance: '5000.00', currentBalance: '5000.00', minimumPayment: '100.00', monthlyPayment: '300.00', apr: '19.99' });
        await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-manual-feb', amount: '300.00', paymentDate: '2026-02-28' });
        await tx.insertDebtPayment({ householdId: WORKSPACE, debtId: DEBT_ID, id: 'dp-import-mar', amount: '300.00', paymentDate: '2026-03-01', transactionId: 'txn-import-mar' });
      });

      const rec = await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-feb', duplicatePaymentId: 'dp-import-mar',
        matchType: 'POSSIBLE_MATCH',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const txMap = new Map([['txn-import-mar', { id: 'txn-import-mar', source: 'import' }]]);
      const rawActivities = deriveDebtActivity({ payments, transactionsByIdMap: txMap });

      const febEconomic = deriveEconomicMonthlyActivitySummary(rawActivities, '2026-02-01', [rec]);
      const marEconomic = deriveEconomicMonthlyActivitySummary(rawActivities, '2026-03-01', [rec]);

      assert.equal(febEconomic.paymentsCents, 30000);
      assert.equal(marEconomic.paymentsCents, 0);
    });
  });

  describe('listDebtPaymentReconciliations', () => {
    test('returns reconciliations for a specific debt', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      const list = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      assert.equal(list.length, 1);
      assert.equal(list[0].primaryPaymentId, 'dp-manual-1');
    });

    test('returns empty array when no reconciliations exist', async () => {
      const db = await setupDbWithDebtAndPayments();
      const list = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      assert.equal(list.length, 0);
    });
  });

  describe('Unlink / Reversal', () => {
    test('confirmed reconciliation can be unlinked and pair returns to undecided', async () => {
      const db = await setupDbWithDebtAndPayments();

      const rec = await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH', userId: USER_ID,
      });
      assert.equal(rec.status, 'confirmed');

      const unlinked = await unlinkDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        userId: USER_ID,
      });
      assert.ok(unlinked.id);

      const remaining = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      assert.equal(remaining.length, 0);
    });

    test('both payments still exist after unlink', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      await unlinkDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      assert.ok(payments.find((p) => p.id === 'dp-manual-1'));
      assert.ok(payments.find((p) => p.id === 'dp-import-1'));
    });

    test('payment amounts are unchanged after unlink', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      await unlinkDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      assert.equal(payments.find((p) => p.id === 'dp-manual-1')?.amount, '300.00');
      assert.equal(payments.find((p) => p.id === 'dp-import-1')?.amount, '300.00');
    });

    test('economic activity counts both payments again after unlink', async () => {
      const db = await setupDbWithDebtAndPayments();

      const rec = await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: WORKSPACE, debtId: DEBT_ID }));
      const txMap = new Map([['txn-import-1', { id: 'txn-import-1', source: 'import' }]]);
      const rawActivities = deriveDebtActivity({ payments, transactionsByIdMap: txMap });

      const economicBefore = deriveEconomicDebtActivity({ activities: rawActivities, reconciliations: [rec] });
      assert.equal(economicBefore.length, 1);

      await unlinkDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
      });

      const reconciliationsAfter = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      const economicAfter = deriveEconomicDebtActivity({ activities: rawActivities, reconciliations: reconciliationsAfter });
      assert.equal(economicAfter.length, 2);
    });

    test('pair ordering (B,A) unlinks a reconciliation stored as (A,B)', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      const unlinked = await unlinkDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-import-1', duplicatePaymentId: 'dp-manual-1',
      });
      assert.ok(unlinked);

      const remaining = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      assert.equal(remaining.length, 0);
    });

    test('unlinking nonexistent reconciliation throws 404', async () => {
      const db = await setupDbWithDebtAndPayments();

      await assert.rejects(
        () => unlinkDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        }),
        (err) => {
          assert.ok(err instanceof ReconciliationError);
          assert.equal(err.status, 404);
          return true;
        },
      );
    });

    test('cross-workspace unlink is blocked — payment not found in foreign workspace', async () => {
      const db = await setupDbWithDebtAndPayments();

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      await assert.rejects(
        () => unlinkDebtPaymentReconciliation({
          db, householdId: 'ws-different-99', debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        }),
        (err) => {
          assert.ok(err instanceof ReconciliationError);
          return true;
        },
      );

      const remaining = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      assert.equal(remaining.length, 1);
    });

    test('confirmed and rejected status remain distinct after unlink of confirmed', async () => {
      const db = await setupDbWithDebtAndPayments([
        { id: 'dp-manual-2', amount: '150.00', paymentDate: '2026-04-01', transactionId: null },
        { id: 'dp-import-2', amount: '150.00', paymentDate: '2026-04-01', transactionId: 'txn-import-2' },
      ]);

      await confirmDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
        matchType: 'POSSIBLE_MATCH',
      });

      await rejectDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-2', duplicatePaymentId: 'dp-import-2',
        matchType: 'POSSIBLE_MATCH',
      });

      await unlinkDebtPaymentReconciliation({
        db, householdId: WORKSPACE, debtId: DEBT_ID,
        primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
      });

      const remaining = await listDebtPaymentReconciliations({ db, householdId: WORKSPACE, debtId: DEBT_ID });
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].status, 'rejected');
    });

    test('unlink self-reference is rejected', async () => {
      const db = await setupDbWithDebtAndPayments();
      await assert.rejects(
        () => unlinkDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-manual-1',
        }),
        (err) => { assert.match(err.message, /cannot unlink a payment from itself/); return true; },
      );
    });
  });

  describe('Validation', () => {
    test('rejects invalid matchType', async () => {
      const db = await setupDbWithDebtAndPayments();
      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: 'dp-manual-1', duplicatePaymentId: 'dp-import-1',
          matchType: 'INVALID',
        }),
        (err) => { assert.match(err.message, /matchType must be/); return true; },
      );
    });

    test('rejects missing primaryPaymentId', async () => {
      const db = await setupDbWithDebtAndPayments();
      await assert.rejects(
        () => confirmDebtPaymentReconciliation({
          db, householdId: WORKSPACE, debtId: DEBT_ID,
          primaryPaymentId: null, duplicatePaymentId: 'dp-import-1',
          matchType: 'POSSIBLE_MATCH',
        }),
        (err) => { assert.match(err.message, /primaryPaymentId is required/); return true; },
      );
    });
  });
});
