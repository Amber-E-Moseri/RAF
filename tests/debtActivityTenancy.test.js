import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { listDebtActivity } from '../lib/debts/debts.js';

const WS_A = 'ws-tenancy-a';
const WS_B = 'ws-tenancy-b';
const DEBT_A = 'debt-a-001';
const DEBT_B = 'debt-b-001';

async function seedWorkspace(wsId, debtId, paymentAmount) {
  const db = createInMemoryDb(wsId);
  await db.transaction(async (tx) => {
    await tx.insertDebt({
      householdId: wsId, id: debtId, name: 'Card', debtType: 'credit_card',
      startingBalance: '5000.00', currentBalance: '5000.00',
      minimumPayment: '100.00', monthlyPayment: '300.00', apr: '19.99',
    });
    await tx.insertDebtPayment({
      householdId: wsId, debtId, id: `dp-${wsId}`,
      amount: paymentAmount, paymentDate: '2026-03-15',
    });
  });
  return db;
}

describe('Debt Activity Tenancy Isolation', () => {
  test('listDebtActivity only returns activities for the requesting workspace', async () => {
    const dbA = await seedWorkspace(WS_A, DEBT_A, '300.00');
    await seedWorkspace(WS_B, DEBT_B, '500.00');

    const resultA = await listDebtActivity({ db: dbA, householdId: WS_A, debtId: DEBT_A });
    assert.equal(resultA.activities.length, 1);
    assert.equal(resultA.activities[0].amountCents, 30000);
  });

  test('workspace A cannot retrieve debt from workspace B', async () => {
    const dbA = await seedWorkspace(WS_A, DEBT_A, '300.00');

    await assert.rejects(
      () => listDebtActivity({ db: dbA, householdId: WS_A, debtId: DEBT_B }),
      (err) => { assert.equal(err.status, 404); return true; },
    );
  });

  test('two workspaces have independent activity views', async () => {
    const dbA = await seedWorkspace(WS_A, DEBT_A, '300.00');
    const dbB = await seedWorkspace(WS_B, DEBT_B, '500.00');

    const [resultA, resultB] = await Promise.all([
      listDebtActivity({ db: dbA, householdId: WS_A, debtId: DEBT_A }),
      listDebtActivity({ db: dbB, householdId: WS_B, debtId: DEBT_B }),
    ]);

    assert.equal(resultA.activities.length, 1);
    assert.equal(resultA.activities[0].amountCents, 30000);

    assert.equal(resultB.activities.length, 1);
    assert.equal(resultB.activities[0].amountCents, 50000);
  });

  test('reconciliation from workspace A does not affect workspace B activity', async () => {
    const dbA = await seedWorkspace(WS_A, DEBT_A, '300.00');
    await dbA.transaction(async (tx) => {
      await tx.insertDebtPaymentReconciliation({
        householdId: WS_A,
        primaryPaymentId: `dp-${WS_A}`,
        duplicatePaymentId: 'dp-nonexistent-in-b',
        status: 'confirmed',
        matchType: 'POSSIBLE_MATCH',
      });
    });

    const dbB = await seedWorkspace(WS_B, DEBT_B, '500.00');
    const resultB = await listDebtActivity({ db: dbB, householdId: WS_B, debtId: DEBT_B });

    assert.equal(resultB.activities.length, 1);
    assert.equal(resultB.activities[0].amountCents, 50000);
  });
});
