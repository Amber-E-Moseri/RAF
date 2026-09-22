import { test } from 'node:test';
import assert from 'node:assert';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';

const TEST_HOUSEHOLD_ID = 'household_test_ph1';
const TEST_DEBT_ID = 'debt_test_ph1';

test('Phase 1: Debt Adjustments Constraint — Production Types Accepted', async (t) => {
  const db = createInMemoryDb();

  await t.test('type=interest accepted (existing)', async () => {
    const adj = await db.transaction((tx) =>
      tx.insertDebtAdjustment({
        householdId: TEST_HOUSEHOLD_ID,
        debtId: TEST_DEBT_ID,
        amount: '50.00',
        adjustmentType: 'interest',
        effectiveDate: '2026-09-15',
      })
    );
    assert.strictEqual(adj.adjustmentType, 'interest');
  });

  await t.test('type=fee accepted (existing)', async () => {
    const adj = await db.transaction((tx) =>
      tx.insertDebtAdjustment({
        householdId: TEST_HOUSEHOLD_ID,
        debtId: TEST_DEBT_ID,
        amount: '35.00',
        adjustmentType: 'fee',
        effectiveDate: '2026-09-15',
      })
    );
    assert.strictEqual(adj.adjustmentType, 'fee');
  });

  await t.test('type=correction accepted (existing)', async () => {
    const adj = await db.transaction((tx) =>
      tx.insertDebtAdjustment({
        householdId: TEST_HOUSEHOLD_ID,
        debtId: TEST_DEBT_ID,
        amount: '100.00',
        adjustmentType: 'correction',
        effectiveDate: '2026-09-15',
      })
    );
    assert.strictEqual(adj.adjustmentType, 'correction');
  });

  await t.test('type=reconciliation accepted (Phase 1 fix — productin path: establishManualAuthorityBoundary)', async () => {
    const adj = await db.transaction((tx) =>
      tx.insertDebtAdjustment({
        householdId: TEST_HOUSEHOLD_ID,
        debtId: TEST_DEBT_ID,
        amount: '-250.00',
        adjustmentType: 'reconciliation',
        effectiveDate: '2026-09-17',
        note: 'Manual balance confirmed while unlinking financial account authority',
      })
    );
    assert.strictEqual(adj.adjustmentType, 'reconciliation');
  });

  await t.test('type=late_fee accepted (Phase 1 fix — production path: buildGeneratedAdjustments)', async () => {
    const adj = await db.transaction((tx) =>
      tx.insertDebtAdjustment({
        householdId: TEST_HOUSEHOLD_ID,
        debtId: TEST_DEBT_ID,
        amount: '35.00',
        adjustmentType: 'late_fee',
        effectiveDate: '2026-09-15',
        note: 'Auto-posted late fee',
      })
    );
    assert.strictEqual(adj.adjustmentType, 'late_fee');
  });
});

test('Phase 1: Import Fingerprint — Idempotency Mechanism', async (t) => {
  const db = createInMemoryDb();

  await t.test('fingerprint field accepted on imported transactions', async () => {
    const inserted = await db.transaction((tx) =>
      tx.insertImportedTransactions({
        rows: [{
          householdId: TEST_HOUSEHOLD_ID,
          date: '2026-09-15',
          description: 'MERCHANT INC',
          amount: '50.00',
          currency: 'USD',
          source: 'bank_import',
          fingerprint: 'abc123sha256hash', // Phase 1 addition
          status: 'unreviewed',
        }],
      })
    );
    assert(inserted.length === 1);
    assert.strictEqual(inserted[0].fingerprint, 'abc123sha256hash');
  });

  await t.test('multiple distinct fingerprints accepted (legitimate repeated transactions)', async () => {
    const inserted = await db.transaction((tx) =>
      tx.insertImportedTransactions({
        rows: [
          {
            householdId: TEST_HOUSEHOLD_ID,
            date: '2026-09-05',
            description: 'EMPLOYER ACME',
            amount: '500.00',
            currency: 'USD',
            source: 'bank_import',
            fingerprint: 'sep5_500_emp', // Different fingerprint (different date)
            status: 'unreviewed',
          },
          {
            householdId: TEST_HOUSEHOLD_ID,
            date: '2026-09-20',
            description: 'EMPLOYER ACME',
            amount: '500.00',
            currency: 'USD',
            source: 'bank_import',
            fingerprint: 'sep20_500_emp', // Different fingerprint (different date)
            status: 'unreviewed',
          },
        ],
      })
    );
    assert.strictEqual(inserted.length, 2);
    assert(inserted[0].fingerprint !== inserted[1].fingerprint);
  });
});
