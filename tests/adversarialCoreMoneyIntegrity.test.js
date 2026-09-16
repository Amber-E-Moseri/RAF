/**
 * RAF Adversarial Core Money Integrity — Phase 3
 *
 * Answers: Can RAF move money through its core financial system without
 * creating, losing, duplicating, or double-counting a dollar?
 *
 * Architectural invariants tested:
 *  1. Transaction arithmetic: amount created = amount stored = amount summed
 *  2. Edit conservation: only the diff changes, nothing else
 *  3. Delete conservation: removes all and only the right effects
 *  4. Split conservation: sum(splits) === parent.amount at all times
 *  5. Income + allocation: sum(allocations) === income.amount
 *  6. computeDepositAllocations: hard invariant enforced for any amount
 *  7. Plan engine net: totalReceived - totalSpent (never double-counted)
 *  8. Transfer neutrality: no income manufactured by debit+credit pairs
 *  9. Month boundary: transactions belong to exactly one month
 * 10. Cent precision: no floating-point leakage
 *
 * Expected values are computed by INDEPENDENT arithmetic (tocents/toDollars).
 * Production functions are NEVER used to compute their own expected values.
 *
 * Production paths exercised:
 *  lib/transactions/createTransaction.js  (createTransaction, updateTransaction, deleteTransaction, listTransactions)
 *  lib/transactions/transactionSplits.js  (setTransactionSplits, clearTransactionSplits, listTransactionSplits)
 *  lib/income/createIncome.js             (createIncome, updateIncome, deleteIncome, listIncome)
 *  lib/raf/computeDepositAllocations.js   (computeDepositAllocations)
 *  lib/raf/planEngine.js                  (computePlanResult)
 *  lib/server/inMemoryDb.js               (createInMemoryDb)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  listTransactions,
} from '../lib/transactions/createTransaction.js';
import {
  setTransactionSplits,
  clearTransactionSplits,
  listTransactionSplits,
} from '../lib/transactions/transactionSplits.js';
import {
  createIncome,
  updateIncome,
  deleteIncome,
  listIncome,
} from '../lib/income/createIncome.js';
import { computeDepositAllocations } from '../lib/raf/computeDepositAllocations.js';
import { computePlanResult } from '../lib/raf/planEngine.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { tocents, toDollars } from './fixtures/adversarialHouseholdExpected.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOUSEHOLD_ID = 'household_1';
const USER_ID = 'test_user_phase3';

// ---------------------------------------------------------------------------
// Test helpers (independent arithmetic only — no circular calls)
// ---------------------------------------------------------------------------

/**
 * Pull all state for a month-period from the db so it can be passed to
 * computePlanResult. Uses db.transaction so reads are isolated.
 *
 * period must be the first day of the month (YYYY-MM-01). The inMemoryDb
 * month-anchor logic then covers the full calendar month.
 */
async function getPlanState(db, period) {
  return db.transaction(async (tx) => {
    const [txResult, incomeEntries, incomeAllocations, allocationCategories, surplusSplitRules] =
      await Promise.all([
        tx.listTransactions({ householdId: HOUSEHOLD_ID, from: period, to: period, limit: 500 }),
        tx.listIncomeEntries({ householdId: HOUSEHOLD_ID, from: period, to: period }),
        tx.listIncomeAllocations({ householdId: HOUSEHOLD_ID, from: period, to: period }),
        tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }),
        tx.listSurplusSplitRules({ householdId: HOUSEHOLD_ID }),
      ]);
    return {
      transactions: txResult.items ?? [],
      incomeEntries,
      incomeAllocations,
      allocationCategories,
      surplusSplitRules,
    };
  });
}

/** Sum all debit amounts in cents. Independent of plan engine. */
function sumDebits(transactions) {
  return transactions
    .filter((t) => t.direction === 'debit')
    .reduce((sum, t) => sum + tocents(t.amount), 0);
}

/** Sum all credit amounts in cents. Independent of plan engine. */
function sumCredits(transactions) {
  return transactions
    .filter((t) => t.direction === 'credit')
    .reduce((sum, t) => sum + tocents(t.amount), 0);
}

/**
 * Sum allocation amounts in cents. Works for allocations from:
 *  - tx.listIncomeAllocations (has .allocatedAmount)
 *  - computeDepositAllocations result (has .allocatedAmount)
 */
function sumAllocations(allocations) {
  return allocations.reduce((sum, a) => sum + tocents(a.allocatedAmount ?? a.amount ?? '0.00'), 0);
}

/** Sum income entry amounts in cents. */
function sumIncome(entries) {
  return entries.reduce((sum, e) => sum + tocents(e.amount), 0);
}

// ---------------------------------------------------------------------------
// SECTION 1: Transaction Arithmetic Conservation
// ---------------------------------------------------------------------------

test('1.1 single debit: stored amount matches input exactly', async () => {
  const db = createInMemoryDb();
  const t = await createTransaction({
    db,
    householdId: HOUSEHOLD_ID,
    userId: USER_ID,
    input: { transactionDate: '2026-01-15', description: 'Rent', amount: '1500.00', direction: 'debit' },
  });
  assert.equal(t.amount, '1500.00');
  assert.equal(t.direction, 'debit');
});

test('1.2 single credit: stored amount matches input exactly', async () => {
  const db = createInMemoryDb();
  const t = await createTransaction({
    db,
    householdId: HOUSEHOLD_ID,
    userId: USER_ID,
    input: { transactionDate: '2026-01-15', description: 'Refund', amount: '45.00', direction: 'credit' },
  });
  assert.equal(t.amount, '45.00');
  assert.equal(t.direction, 'credit');
});

test('1.3 two debits: list total matches independent arithmetic', async () => {
  const db = createInMemoryDb();
  await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Groceries', amount: '120.50', direction: 'debit' },
  });
  await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-20', description: 'Gas', amount: '60.00', direction: 'debit' },
  });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID,
    query: { from: '2026-01-01', to: '2026-01-31' },
  });
  // Independent: 12050 + 6000 = 18050
  assert.equal(sumDebits(items), 18050, 'sum must equal 18050 cents — no leakage');
});

test('1.4 transaction count equals creation count (no phantom records)', async () => {
  const db = createInMemoryDb();
  for (const [desc, amount] of [['A', '10.00'], ['B', '20.00'], ['C', '30.00']]) {
    await createTransaction({
      db, householdId: HOUSEHOLD_ID, userId: USER_ID,
      input: { transactionDate: '2026-01-01', description: desc, amount, direction: 'debit' },
    });
  }
  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 3, 'exactly 3 transactions — no phantom rows');
});

test('1.5 mixed directions: debits and credits each counted once', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'Purchase', amount: '200.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-11', description: 'Purchase 2', amount: '50.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-12', description: 'Refund', amount: '30.00', direction: 'credit' } });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 3);
  // Independent: debits = 20000 + 5000 = 25000; credits = 3000
  assert.equal(sumDebits(items), 25000, 'debits sum must be 25000 cents');
  assert.equal(sumCredits(items), 3000, 'credits sum must be 3000 cents');
});

// ---------------------------------------------------------------------------
// SECTION 2: Transaction Edit Conservation
// ---------------------------------------------------------------------------

test('2.1 update amount: no phantom row, plan sees new value only', async () => {
  const db = createInMemoryDb();
  const t = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Groceries', amount: '100.00', direction: 'debit' },
  });
  await updateTransaction({
    db, householdId: HOUSEHOLD_ID, transactionId: t.id, userId: USER_ID,
    input: { amount: '130.00' },
  });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 1, 'edit must not create phantom row');
  assert.equal(tocents(items[0].amount), 13000, 'updated amount: 13000 cents, not original 10000');
});

test('2.2 update description: amount unchanged', async () => {
  const db = createInMemoryDb();
  const t = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Old name', amount: '250.00', direction: 'debit' },
  });
  await updateTransaction({
    db, householdId: HOUSEHOLD_ID, transactionId: t.id, userId: USER_ID,
    input: { description: 'New name' },
  });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 1);
  assert.equal(tocents(items[0].amount), 25000, 'description change must not affect amount');
  assert.equal(items[0].description, 'New name');
});

test('2.3 multiple sequential updates: last write wins, no accumulated phantom rows', async () => {
  const db = createInMemoryDb();
  const t = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Food', amount: '50.00', direction: 'debit' },
  });
  await updateTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: t.id, userId: USER_ID, input: { amount: '55.00' } });
  await updateTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: t.id, userId: USER_ID, input: { amount: '60.00' } });
  await updateTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: t.id, userId: USER_ID, input: { amount: '45.00' } });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 1, 'sequential edits must not create phantom rows');
  assert.equal(tocents(items[0].amount), 4500, 'final amount must be 45.00 = 4500 cents');
});

// ---------------------------------------------------------------------------
// SECTION 3: Transaction Delete Conservation
// ---------------------------------------------------------------------------

test('3.1 delete one transaction: sum decreases by exactly that amount', async () => {
  const db = createInMemoryDb();
  const t1 = await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'Keep', amount: '100.00', direction: 'debit' } });
  const t2 = await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-11', description: 'Delete', amount: '50.00', direction: 'debit' } });

  await deleteTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: t2.id, userId: USER_ID });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 1, 'delete must remove exactly one transaction');
  assert.equal(items[0].id, t1.id, 'remaining transaction must be the kept one');
  assert.equal(sumDebits(items), 10000, 'sum after delete: only 100.00 remains = 10000 cents');
});

test('3.2 delete all transactions: sum reaches zero, list is empty', async () => {
  const db = createInMemoryDb();
  const t1 = await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'A', amount: '100.00', direction: 'debit' } });
  const t2 = await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-11', description: 'B', amount: '200.00', direction: 'debit' } });

  await deleteTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: t1.id, userId: USER_ID });
  await deleteTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: t2.id, userId: USER_ID });

  const { items } = await listTransactions({
    db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(items.length, 0, 'all deleted: list must be empty');
  assert.equal(sumDebits(items), 0, 'sum of empty list must be 0');
});

test('3.3 deleting a split parent cascades to child splits', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Split parent', amount: '100.00', direction: 'debit' },
  });
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [
      { categoryId: catA.id, amount: '60.00' },
      { categoryId: catB.id, amount: '40.00' },
    ],
  });

  await deleteTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id, userId: USER_ID });

  await assert.rejects(
    () => listTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id }),
    /not found/i,
    'splits must also be gone after parent deletion (parent not found → 404)',
  );
});

// ---------------------------------------------------------------------------
// SECTION 4: Split Conservation
// ---------------------------------------------------------------------------

test('4.1 two-way split: sum equals parent amount exactly', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Dinner split', amount: '120.00', direction: 'debit' },
  });
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [
      { categoryId: catA.id, amount: '80.00' },
      { categoryId: catB.id, amount: '40.00' },
    ],
  });

  const splits = await listTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id });
  // Independent: 8000 + 4000 = 12000
  const splitTotal = splits.reduce((sum, s) => sum + tocents(s.amount), 0);
  assert.equal(splitTotal, 12000, 'split total must equal parent 120.00 = 12000 cents');
  assert.equal(tocents(parent.amount), 12000, 'parent amount must be unaffected by split creation');
});

test('4.2 three-way split with odd cents: sum equals parent exactly', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB, catC] = cats;

  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Three way', amount: '100.00', direction: 'debit' },
  });
  // $100.00 / 3 → $33.33 + $33.33 + $33.34
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [
      { categoryId: catA.id, amount: '33.33' },
      { categoryId: catB.id, amount: '33.33' },
      { categoryId: catC.id, amount: '33.34' },
    ],
  });

  const splits = await listTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id });
  // Independent integer arithmetic: 3333 + 3333 + 3334 = 10000
  const splitTotal = splits.reduce((sum, s) => sum + tocents(s.amount), 0);
  assert.equal(splitTotal, 10000, '3-way odd-cent split must sum to exactly 10000 cents');
});

test('4.3 split with wrong total: production rejects before persisting', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Bad split', amount: '100.00', direction: 'debit' },
  });

  // $50 + $30 = $80 ≠ $100 — must reject
  await assert.rejects(
    () => setTransactionSplits({
      db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
      splits: [
        { categoryId: catA.id, amount: '50.00' },
        { categoryId: catB.id, amount: '30.00' },
      ],
    }),
    /split/i,
    'mismatched split total must throw',
  );

  // Verify no splits were persisted despite the rejection
  const splits = await listTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id });
  assert.equal(splits.length, 0, 'rejected split must leave no orphan rows');
});

test('4.4 credit transactions cannot be split', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  const credit = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Credit', amount: '100.00', direction: 'credit' },
  });

  // setSplitsSchema requires min(2) splits, so we pass 2 splits summing to $100.
  // The direction check happens after schema validation, so /debit/i matches.
  await assert.rejects(
    () => setTransactionSplits({
      db, householdId: HOUSEHOLD_ID, transactionId: credit.id,
      splits: [
        { categoryId: catA.id, amount: '50.00' },
        { categoryId: catB.id, amount: '50.00' },
      ],
    }),
    /debit/i,
    'splitting a credit transaction must throw with direction error',
  );
});

test('4.5 replace splits atomically: old splits gone, new sum correct', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB, catC] = cats;

  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Resplit', amount: '100.00', direction: 'debit' },
  });

  // First: 2-way split
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [{ categoryId: catA.id, amount: '60.00' }, { categoryId: catB.id, amount: '40.00' }],
  });

  // Replace with 3-way split
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [
      { categoryId: catA.id, amount: '50.00' },
      { categoryId: catB.id, amount: '30.00' },
      { categoryId: catC.id, amount: '20.00' },
    ],
  });

  const splits = await listTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id });
  assert.equal(splits.length, 3, 'replace must atomically swap 2-way for 3-way');
  const total = splits.reduce((sum, s) => sum + tocents(s.amount), 0);
  assert.equal(total, 10000, 'new splits must sum to 10000 cents = $100.00');
});

test('4.6 clear splits: parent transaction survives unchanged', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Clear test', amount: '100.00', direction: 'debit' },
  });
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [{ categoryId: catA.id, amount: '70.00' }, { categoryId: catB.id, amount: '30.00' }],
  });
  await clearTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id });

  const splits = await listTransactionSplits({ db, householdId: HOUSEHOLD_ID, transactionId: parent.id });
  assert.equal(splits.length, 0, 'clear must remove all splits');

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(items.length, 1, 'parent transaction must still exist after split clear');
  assert.equal(tocents(items[0].amount), 10000, 'parent amount unchanged after clearing splits');
});

// ---------------------------------------------------------------------------
// SECTION 5: Category Reclassification Neutrality
// ---------------------------------------------------------------------------

test('5.1 category reassignment does not change transaction amount', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  const t = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Expense', amount: '300.00', direction: 'debit', categoryId: catA.id },
  });
  await updateTransaction({
    db, householdId: HOUSEHOLD_ID, transactionId: t.id, userId: USER_ID,
    input: { categoryId: catB.id },
  });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(items.length, 1, 'category change must not create phantom row');
  assert.equal(tocents(items[0].amount), 30000, 'amount unchanged = 30000 cents');
  assert.equal(items[0].categoryId, catB.id, 'categoryId must reflect the new category');
});

// ---------------------------------------------------------------------------
// SECTION 6: Income Recognition and Idempotency
// ---------------------------------------------------------------------------

test('6.1 createIncome: income entry created with allocations', async () => {
  const db = createInMemoryDb();
  const result = await createIncome({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' },
  });
  assert.equal(result.created, true);
  assert.equal(result.amount, '3000.00');
  assert.ok(Array.isArray(result.allocations) && result.allocations.length > 0, 'allocations must be created');
});

test('6.2 createIncome: allocations from result sum exactly to income amount', async () => {
  const db = createInMemoryDb();
  const result = await createIncome({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' },
  });
  // createIncome allocations use .amount (not .allocatedAmount)
  const allocationTotal = result.allocations.reduce((sum, a) => sum + tocents(a.amount), 0);
  // Independent: $3000.00 = 300000 cents
  assert.equal(allocationTotal, 300000, 'result.allocations must sum to exactly 300000 cents');
});

test('6.3 income idempotency: same key + same payload = existing record, created:false', async () => {
  const db = createInMemoryDb();
  const key = 'payroll-2026-01';
  const input = { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' };

  const first = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input, idempotencyKey: key });
  const second = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input, idempotencyKey: key });

  assert.equal(first.incomeId, second.incomeId, 'same idempotency key must return same incomeId');
  assert.equal(second.created, false, 'second call must return created: false');

  const listed = await listIncome({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(listed.items.length, 1, 'idempotent calls must not duplicate income entries');
});

test('6.4 income idempotency: same key + different amount = 409 error', async () => {
  const db = createInMemoryDb();
  const key = 'payroll-conflict';
  await createIncome({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' },
    idempotencyKey: key,
  });

  await assert.rejects(
    () => createIncome({
      db, householdId: HOUSEHOLD_ID, userId: USER_ID,
      input: { sourceName: 'Salary', amount: '4000.00', receivedDate: '2026-01-15' },
      idempotencyKey: key,
    }),
    (err) => err.status === 409 || /conflict/i.test(err.message),
    'same key + different amount must produce a 409 conflict',
  );
});

// ---------------------------------------------------------------------------
// SECTION 7: Income Date Attribution
// ---------------------------------------------------------------------------

test('7.1 January income does not appear in February query', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Jan Salary', amount: '3000.00', receivedDate: '2026-01-15' } });

  const feb = await listIncome({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-02-01', to: '2026-02-28' } });
  assert.equal(feb.items.length, 0, 'January income must not appear in February query');
});

test('7.2 February income does not appear in January query', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Feb Salary', amount: '3000.00', receivedDate: '2026-02-15' } });

  const jan = await listIncome({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(jan.items.length, 0, 'February income must not appear in January query');
});

test('7.3 income appears in and only in its correct month', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'May Income', amount: '2500.00', receivedDate: '2026-05-10' } });

  const may = await listIncome({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-05-01', to: '2026-05-31' } });
  assert.equal(may.items.length, 1);
  assert.equal(may.items[0].amount, '2500.00');
});

// ---------------------------------------------------------------------------
// SECTION 8: Allocation Conservation (computeDepositAllocations pure fn)
// ---------------------------------------------------------------------------

test('8.1 computeDepositAllocations: $3000 allocates to exactly $3000', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const allocations = computeDepositAllocations('3000.00', cats);
  // Independent: 300000 cents must be allocated (sum of all allocation amounts)
  assert.equal(sumAllocations(allocations), 300000);
});

test('8.2 computeDepositAllocations: $1.00 allocates to exactly 100 cents', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const allocations = computeDepositAllocations('1.00', cats);
  assert.equal(sumAllocations(allocations), 100);
});

test('8.3 computeDepositAllocations: $0.01 allocates to exactly 1 cent', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const allocations = computeDepositAllocations('0.01', cats);
  assert.equal(sumAllocations(allocations), 1, 'smallest possible amount: 1 cent — must not vanish');
});

test('8.4 computeDepositAllocations: $333.33 (odd cents, 7 categories) sums exactly', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const allocations = computeDepositAllocations('333.33', cats);
  // Independent: 33333 cents
  assert.equal(sumAllocations(allocations), 33333, 'odd-cent allocation must sum to exactly 33333 cents');
});

test('8.5 computeDepositAllocations: $50000 allocates to exactly 5000000 cents', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const allocations = computeDepositAllocations('50000.00', cats);
  assert.equal(sumAllocations(allocations), 5000000);
});

// ---------------------------------------------------------------------------
// SECTION 9: Multiple Income Entries — Aggregation Without Duplication
// ---------------------------------------------------------------------------

test('9.1 two income entries: total received is their independent sum', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Bonus', amount: '500.00', receivedDate: '2026-01-15' } });

  const state = await getPlanState(db, '2026-01-01');
  // Independent: 300000 + 50000 = 350000
  assert.equal(sumIncome(state.incomeEntries), 350000, 'income entry total must be 350000 cents');
  assert.equal(state.incomeEntries.length, 2, 'must have exactly 2 income entries');
});

test('9.2 two income entries: each has its own allocations (no cross-contamination)', async () => {
  const db = createInMemoryDb();
  const r1 = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  const r2 = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Bonus', amount: '500.00', receivedDate: '2026-01-15' } });

  const state = await getPlanState(db, '2026-01-01');
  const r1Allocs = state.incomeAllocations.filter((a) => a.incomeEntryId === r1.incomeId);
  const r2Allocs = state.incomeAllocations.filter((a) => a.incomeEntryId === r2.incomeId);

  assert.ok(r1Allocs.length > 0, 'salary must have its own allocations');
  assert.ok(r2Allocs.length > 0, 'bonus must have its own allocations');
  // Independent sums
  assert.equal(sumAllocations(r1Allocs), 300000, 'salary allocations sum = 300000 cents');
  assert.equal(sumAllocations(r2Allocs), 50000, 'bonus allocations sum = 50000 cents');
});

test('9.3 two income entries: total allocations equal total income (no phantom allocation)', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Bonus', amount: '500.00', receivedDate: '2026-01-15' } });

  const state = await getPlanState(db, '2026-01-01');
  const totalIncome = sumIncome(state.incomeEntries);         // 350000
  const totalAllocations = sumAllocations(state.incomeAllocations);
  assert.equal(totalAllocations, totalIncome, 'total allocations must equal total income exactly');
});

// ---------------------------------------------------------------------------
// SECTION 10: Income Update Conservation
// ---------------------------------------------------------------------------

test('10.1 updateIncome: old allocations replaced, no phantom old rows', async () => {
  const db = createInMemoryDb();
  const r = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' } });
  await updateIncome({
    db, householdId: HOUSEHOLD_ID, incomeId: r.incomeId, userId: USER_ID,
    input: { amount: '4000.00' },
  });

  const state = await getPlanState(db, '2026-01-01');
  assert.equal(state.incomeEntries.length, 1, 'update must not create phantom income entry');
  assert.equal(state.incomeEntries[0].amount, '4000.00', 'entry amount must reflect new value');
  // Allocations must sum to new amount (400000), not old (300000)
  assert.equal(sumAllocations(state.incomeAllocations), 400000, 'allocations must sum to new 400000 cents');
});

test('10.2 updateIncome: plan engine reflects updated amount, not stale value', async () => {
  const db = createInMemoryDb();
  const r = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' } });
  await updateIncome({
    db, householdId: HOUSEHOLD_ID, incomeId: r.incomeId, userId: USER_ID,
    input: { amount: '3500.00' },
  });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  // Independent: $3500.00 received
  assert.equal(plan.income.totalReceived, '3500.00', 'plan must reflect updated income');
});

// ---------------------------------------------------------------------------
// SECTION 11: Income Delete Conservation
// ---------------------------------------------------------------------------

test('11.1 deleteIncome: entry and all its allocations removed atomically', async () => {
  const db = createInMemoryDb();
  const r = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' } });
  await deleteIncome({ db, householdId: HOUSEHOLD_ID, incomeId: r.incomeId, userId: USER_ID });

  const state = await getPlanState(db, '2026-01-01');
  assert.equal(state.incomeEntries.length, 0, 'deleteIncome must remove the income entry');
  assert.equal(state.incomeAllocations.length, 0, 'deleteIncome must remove all associated allocations');
});

test('11.2 deleteIncome: plan engine shows zero received income after deletion', async () => {
  const db = createInMemoryDb();
  const r = await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' } });
  await deleteIncome({ db, householdId: HOUSEHOLD_ID, incomeId: r.incomeId, userId: USER_ID });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  assert.equal(plan.income.totalReceived, '0.00', 'plan must show 0.00 totalReceived after income deletion');
});

// ---------------------------------------------------------------------------
// SECTION 12: Buffer Category (default 10% allocation)
// ---------------------------------------------------------------------------

test('12.1 default allocation config includes a buffer category (isBuffer: true)', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const buffer = cats.find((c) => c.isBuffer === true);
  assert.ok(buffer, 'default config must include isBuffer: true category');
  assert.equal(buffer.slug, 'buffer');
});

test('12.2 buffer receives 10% of income: $3000 income → $300 to buffer', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const buffer = cats.find((c) => c.isBuffer === true);

  const r = await createIncome({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' },
  });

  // createIncome allocations use .amount (the formatted allocation response)
  const bufferAlloc = r.allocations.find((a) => a.slug === 'buffer');
  assert.ok(bufferAlloc, 'buffer allocation must exist in income result');
  // Independent: 300000 × 10% = 30000 cents = $300.00
  assert.equal(tocents(bufferAlloc.amount), 30000, 'buffer must receive 30000 cents');
});

test('12.3 spending against buffer category reflects in plan byCategory correctly', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const buffer = cats.find((c) => c.isBuffer === true);

  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  // Spend $150 from buffer ($300 allocated → $150 remaining)
  await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Buffer spend', amount: '150.00', direction: 'debit', categoryId: buffer.id },
  });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  const bufferRow = plan.spending.byCategory.find((r) => r.slug === 'buffer');

  assert.ok(bufferRow, 'buffer must appear in spending.byCategory');
  // Independent: allocated 30000, spent 15000, remaining 15000
  assert.equal(tocents(bufferRow.allocated), 30000, 'buffer allocated: 30000 cents');
  assert.equal(tocents(bufferRow.spent), 15000, 'buffer spent: 15000 cents');
  assert.equal(tocents(bufferRow.remaining), 15000, 'buffer remaining: 15000 cents');
});

// ---------------------------------------------------------------------------
// SECTION 13: Plan Engine Net Calculation
// ---------------------------------------------------------------------------

test('13.1 net = income - spending (basic two-expense case)', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Rent', amount: '900.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-16', description: 'Food', amount: '200.00', direction: 'debit' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  // Independent: 300000 - 90000 - 20000 = 190000 cents = $1900.00
  assert.equal(plan.income.totalReceived, '3000.00');
  assert.equal(plan.spending.total, '1100.00');
  assert.equal(plan.net, '1900.00', 'net = 3000 - 1100 = 1900');
});

test('13.2 net = $0 when spending equals income exactly', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '2000.00', receivedDate: '2026-01-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'All spent', amount: '2000.00', direction: 'debit' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  assert.equal(plan.net, '0.00', 'net must be 0.00 when spending exactly equals income');
});

test('13.3 isDeficit = true when spending exceeds income', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '1000.00', receivedDate: '2026-01-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Overspend', amount: '1500.00', direction: 'debit' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  assert.equal(plan.isDeficit, true, 'spending > income must yield isDeficit: true');
  assert.equal(tocents(plan.spending.total), 150000, 'spending.total must be 150000 cents');
});

test('13.4 credit transactions do NOT inflate totalReceived (income independence)', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '1000.00', receivedDate: '2026-01-01' } });
  // Credit transaction (e.g., credit line draw) — must NOT inflate income
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'Credit draw', amount: '500.00', direction: 'credit' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  // totalReceived = only income entries, not credit transactions
  assert.equal(plan.income.totalReceived, '1000.00', 'credit transaction must NOT inflate totalReceived');
});

test('13.5 plan with zero income and zero spending: net = $0, no deficit', async () => {
  const db = createInMemoryDb();
  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  assert.equal(plan.income.totalReceived, '0.00');
  assert.equal(plan.spending.total, '0.00');
  assert.equal(plan.net, '0.00');
  assert.equal(plan.isDeficit, false);
});

// ---------------------------------------------------------------------------
// SECTION 14: Transfer Neutrality
// ---------------------------------------------------------------------------

test('14.1 internal transfer: no income manufactured (totalReceived stays $0)', async () => {
  const db = createInMemoryDb();
  // Internal transfer = debit from one account + credit to another
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Transfer out', amount: '500.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Transfer in', amount: '500.00', direction: 'credit' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  assert.equal(plan.income.totalReceived, '0.00', 'transfer must not manufacture income');
  assert.equal(plan.spending.total, '500.00', 'debit side must appear in spending.total');
});

test('14.2 internal transfer: debit counted once, credit counted once in list', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Transfer out', amount: '500.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Transfer in', amount: '500.00', direction: 'credit' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(sumDebits(items), 50000, 'transfer debit counted exactly once: 50000 cents');
  assert.equal(sumCredits(items), 50000, 'transfer credit counted exactly once: 50000 cents');
});

test('14.3 transfer amount correction: each side updated independently, no phantom rows', async () => {
  const db = createInMemoryDb();
  const tDebit = await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Transfer out', amount: '500.00', direction: 'debit' } });
  const tCredit = await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Transfer in', amount: '500.00', direction: 'credit' } });

  // Correction: it was $450, not $500
  await updateTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: tDebit.id, userId: USER_ID, input: { amount: '450.00' } });
  await updateTransaction({ db, householdId: HOUSEHOLD_ID, transactionId: tCredit.id, userId: USER_ID, input: { amount: '450.00' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(items.length, 2, 'correction must not create phantom transactions');
  assert.equal(sumDebits(items), 45000, 'corrected debit: 45000 cents');
  assert.equal(sumCredits(items), 45000, 'corrected credit: 45000 cents');
});

// ---------------------------------------------------------------------------
// SECTION 15: Refund and Reversal Conservation
// ---------------------------------------------------------------------------

test('15.1 partial refund: original debit + partial credit — stored independently', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'Purchase', amount: '120.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-12', description: 'Refund', amount: '40.00', direction: 'credit' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  // Independent: debit 12000, credit 4000
  assert.equal(sumDebits(items), 12000, 'original debit must be 12000 cents');
  assert.equal(sumCredits(items), 4000, 'refund credit must be 4000 cents');
});

test('15.2 full reversal: original $200 debit + $200 credit — plan spending still $200', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const cat = cats[0];

  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '1000.00', receivedDate: '2026-01-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'Purchase', amount: '200.00', direction: 'debit', categoryId: cat.id } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-11', description: 'Reversal', amount: '200.00', direction: 'credit', categoryId: cat.id } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  // The debit contributes to spending.total; the credit adds to category budget
  // Plan engine: net = income received - total debits = 1000 - 200 = 800
  assert.equal(tocents(plan.spending.total), 20000, 'debit must appear in spending.total = 20000 cents');
  assert.equal(plan.income.totalReceived, '1000.00');
  assert.equal(plan.net, '800.00', 'net = 1000 - 200 = 800 (credit does not reduce spending.total)');
});

test('15.3 refund exceeds original: no amount clipping occurs', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-10', description: 'Purchase', amount: '50.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-11', description: 'Overpay refund', amount: '75.00', direction: 'credit' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  // Both stored as-is — no clipping, no special handling
  assert.equal(sumDebits(items), 5000, 'original debit: 5000 cents');
  assert.equal(sumCredits(items), 7500, 'oversized refund: 7500 cents — not clipped');
});

// ---------------------------------------------------------------------------
// SECTION 16: Month Boundary Integrity
// ---------------------------------------------------------------------------

test('16.1 Jan 31 transaction: in January, not February', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-31', description: 'Jan end', amount: '100.00', direction: 'debit' } });

  const jan = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } })).items;
  const feb = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-02-01', to: '2026-02-28' } })).items;
  assert.equal(jan.length, 1, 'Jan 31 must be in January');
  assert.equal(feb.length, 0, 'Jan 31 must NOT be in February');
});

test('16.2 Feb 1 transaction: in February, not January', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-02-01', description: 'Feb start', amount: '100.00', direction: 'debit' } });

  const jan = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } })).items;
  const feb = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-02-01', to: '2026-02-28' } })).items;
  assert.equal(jan.length, 0, 'Feb 1 must NOT be in January');
  assert.equal(feb.length, 1, 'Feb 1 must be in February');
});

test('16.3 three months: each transaction appears in exactly one month, correct sum', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Jan', amount: '100.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-02-15', description: 'Feb', amount: '200.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-03-15', description: 'Mar', amount: '300.00', direction: 'debit' } });

  const jan = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } })).items;
  const feb = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-02-01', to: '2026-02-28' } })).items;
  const mar = (await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-03-01', to: '2026-03-31' } })).items;

  assert.equal(jan.length, 1);
  assert.equal(feb.length, 1);
  assert.equal(mar.length, 1);
  assert.equal(sumDebits(jan), 10000, 'Jan = 10000');
  assert.equal(sumDebits(feb), 20000, 'Feb = 20000');
  assert.equal(sumDebits(mar), 30000, 'Mar = 30000');
});

// ---------------------------------------------------------------------------
// SECTION 17: Cent Precision
// ---------------------------------------------------------------------------

test('17.1 $0.01 transaction: stored and summed as exactly 1 cent', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Penny', amount: '0.01', direction: 'debit' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(tocents(items[0].amount), 1, '$0.01 must be stored as 1 cent — not lost, not inflated');
});

test('17.2 $84.22 transaction: no floating-point corruption', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Odd amount', amount: '84.22', direction: 'debit' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(items[0].amount, '84.22', 'amount must be stored as exact string "84.22"');
  assert.equal(tocents(items[0].amount), 8422, '$84.22 = exactly 8422 cents');
});

test('17.3 sum of three $33.33: integer arithmetic, no floating-point drift', async () => {
  const db = createInMemoryDb();
  for (let i = 0; i < 3; i++) {
    await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: `2026-01-${10 + i}`, description: `Third ${i}`, amount: '33.33', direction: 'debit' } });
  }
  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  // Integer arithmetic: 3333 + 3333 + 3333 = 9999 (not 9999.999... )
  assert.equal(sumDebits(items), 9999, 'three $33.33 = 9999 cents exactly');
});

test('17.4 large amount $999999.99: stored and summed correctly', async () => {
  const db = createInMemoryDb();
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Large', amount: '999999.99', direction: 'debit' } });

  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(items[0].amount, '999999.99');
  assert.equal(tocents(items[0].amount), 99999999, '$999999.99 = 99999999 cents');
});

// ---------------------------------------------------------------------------
// SECTION 18: Schema Validation — Boundary Conditions
// ---------------------------------------------------------------------------

test('18.1 zero amount transaction is rejected by schema', async () => {
  const db = createInMemoryDb();
  await assert.rejects(
    () => createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Zero', amount: '0.00', direction: 'debit' } }),
    Error,
    '$0.00 debit must be rejected',
  );
});

test('18.2 zero amount rejection leaves no phantom record', async () => {
  const db = createInMemoryDb();
  try {
    await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Zero', amount: '0.00', direction: 'debit' } });
  } catch {
    // expected rejection
  }
  const { items } = await listTransactions({ db, householdId: HOUSEHOLD_ID, query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(items.length, 0, 'rejected transaction must leave no phantom record');
});

test('18.3 negative debit amount is rejected by schema', async () => {
  const db = createInMemoryDb();
  await assert.rejects(
    () => createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Negative', amount: '-100.00', direction: 'debit' } }),
    Error,
    'negative debit amount must be rejected',
  );
});

test('18.4 empty description is rejected by schema', async () => {
  const db = createInMemoryDb();
  await assert.rejects(
    () => createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: '', amount: '100.00', direction: 'debit' } }),
    Error,
    'empty description must be rejected',
  );
});

test('18.5 invalid direction value is rejected by schema', async () => {
  const db = createInMemoryDb();
  await assert.rejects(
    () => createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Bad dir', amount: '100.00', direction: 'outgoing' } }),
    Error,
    'invalid direction must be rejected',
  );
});

// ---------------------------------------------------------------------------
// SECTION 19: Double-Count Prevention
// ---------------------------------------------------------------------------

test('19.1 split parent not double-counted: spending.total = parent amount only', async () => {
  const db = createInMemoryDb();
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: HOUSEHOLD_ID }));
  const [catA, catB] = cats;

  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  const parent = await createTransaction({
    db, householdId: HOUSEHOLD_ID, userId: USER_ID,
    input: { transactionDate: '2026-01-10', description: 'Dinner', amount: '100.00', direction: 'debit' },
  });
  await setTransactionSplits({
    db, householdId: HOUSEHOLD_ID, transactionId: parent.id,
    splits: [
      { categoryId: catA.id, amount: '60.00' },
      { categoryId: catB.id, amount: '40.00' },
    ],
  });

  // Plan engine must count $100 (parent), NOT $60 + $40 + $100 = $200
  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  assert.equal(plan.spending.total, '100.00', 'splits must not double-count: spending.total must be 100, not 200');
});

test('19.2 idempotent income creation: total allocations = one income worth only', async () => {
  const db = createInMemoryDb();
  const key = 'no-double-alloc';
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' }, idempotencyKey: key });
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-15' }, idempotencyKey: key });

  const state = await getPlanState(db, '2026-01-01');
  // Independent: only one income of 300000 cents → allocations must be exactly 300000
  assert.equal(sumAllocations(state.incomeAllocations), 300000, 'idempotent income must not double-allocate');
  assert.equal(state.incomeEntries.length, 1, 'idempotent call must not create duplicate entry');
});

test('19.3 two distinct incomes: plan engine accumulates both without duplication', async () => {
  const db = createInMemoryDb();
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: '3000.00', receivedDate: '2026-01-01' } });
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Freelance', amount: '500.00', receivedDate: '2026-01-10' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  // Independent: 300000 + 50000 = 350000 = $3500.00
  assert.equal(plan.income.totalReceived, '3500.00', 'two distinct incomes must sum to 3500.00');
  assert.equal(state.incomeEntries.length, 2, 'two distinct incomes = 2 separate entries');
});

// ---------------------------------------------------------------------------
// SECTION 20: Multi-Month Sequence Conservation
// ---------------------------------------------------------------------------

test('20.1 January: income + spending conservation via plan engine', async () => {
  const db = createInMemoryDb();

  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Jan Salary', amount: '3500.00', receivedDate: '2026-01-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-01', description: 'Rent', amount: '1200.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Groceries', amount: '350.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-20', description: 'Utilities', amount: '150.00', direction: 'debit' } });

  const state = await getPlanState(db, '2026-01-01');
  const plan = computePlanResult({ period: '2026-01-01', ...state });
  // Independent: income 350000; spending 120000 + 35000 + 15000 = 170000; net = 180000 = $1800.00
  assert.equal(plan.income.totalReceived, '3500.00');
  assert.equal(plan.spending.total, '1700.00');
  assert.equal(plan.net, '1800.00', 'Jan net = 3500 - 1700 = 1800');
  assert.equal(plan.isDeficit, false);
});

test('20.2 February: bonus income accumulates correctly', async () => {
  const db = createInMemoryDb();

  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Feb Salary', amount: '3500.00', receivedDate: '2026-02-01' } });
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Feb Bonus', amount: '750.00', receivedDate: '2026-02-15' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-02-01', description: 'Rent', amount: '1200.00', direction: 'debit' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-02-10', description: 'Coffee', amount: '5.00', direction: 'debit' } });

  const state = await getPlanState(db, '2026-02-01');
  const plan = computePlanResult({ period: '2026-02-01', ...state });
  // Independent: income 350000 + 75000 = 425000; spending 120000 + 500 = 120500; net = 304500 = $3045.00
  assert.equal(plan.income.totalReceived, '4250.00');
  assert.equal(plan.spending.total, '1205.00');
  assert.equal(plan.net, '3045.00', 'Feb net = 4250 - 1205 = 3045');
});

test('20.3 January and February plans are fully isolated (no cross-month bleed)', async () => {
  const db = createInMemoryDb();

  // January
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Jan Salary', amount: '3500.00', receivedDate: '2026-01-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-01-15', description: 'Jan rent', amount: '1200.00', direction: 'debit' } });

  // February
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Feb Salary', amount: '3500.00', receivedDate: '2026-02-01' } });
  await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: '2026-02-15', description: 'Feb rent', amount: '1200.00', direction: 'debit' } });

  const janState = await getPlanState(db, '2026-01-01');
  const febState = await getPlanState(db, '2026-02-01');
  const janPlan = computePlanResult({ period: '2026-01-01', ...janState });
  const febPlan = computePlanResult({ period: '2026-02-01', ...febState });

  // Each month must see only its own data
  assert.equal(janPlan.income.totalReceived, '3500.00', 'Jan plan must not see Feb income');
  assert.equal(janPlan.spending.total, '1200.00', 'Jan plan must not see Feb spending');
  assert.equal(febPlan.income.totalReceived, '3500.00', 'Feb plan must not see Jan income');
  assert.equal(febPlan.spending.total, '1200.00', 'Feb plan must not see Jan spending');
  assert.equal(janState.incomeEntries.length, 1, 'Jan state: 1 income entry only');
  assert.equal(febState.incomeEntries.length, 1, 'Feb state: 1 income entry only');
});

test('20.4 May late income: not visible in April plan', async () => {
  const db = createInMemoryDb();

  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'April Salary', amount: '3500.00', receivedDate: '2026-04-01' } });
  await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'May Salary', amount: '3500.00', receivedDate: '2026-05-01' } });

  const aprState = await getPlanState(db, '2026-04-01');
  const mayState = await getPlanState(db, '2026-05-01');
  const aprPlan = computePlanResult({ period: '2026-04-01', ...aprState });
  const mayPlan = computePlanResult({ period: '2026-05-01', ...mayState });

  assert.equal(aprPlan.income.totalReceived, '3500.00', 'April plan must not include May income');
  assert.equal(mayPlan.income.totalReceived, '3500.00', 'May plan must include May income');
  assert.equal(aprState.incomeEntries.length, 1, 'April state: exactly 1 income entry');
  assert.equal(mayState.incomeEntries.length, 1, 'May state: exactly 1 income entry');
});

test('20.5 full quarter conservation: 3 months of income and spending, each month independent', async () => {
  const db = createInMemoryDb();

  // Q1 2026
  const months = [
    { period: '2026-01-01', income: '3500.00', spending: '1700.00', net: '1800.00' },
    { period: '2026-02-01', income: '3500.00', spending: '1650.00', net: '1850.00' },
    { period: '2026-03-01', income: '3500.00', spending: '1900.00', net: '1600.00' },
  ];

  for (const m of months) {
    await createIncome({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { sourceName: 'Salary', amount: m.income, receivedDate: m.period } });
    // Replace the day portion only (slice to YYYY-MM- then append day)
    const spendDate = m.period.slice(0, 8) + '05';
    await createTransaction({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { transactionDate: spendDate, description: 'Rent', amount: m.spending, direction: 'debit' } });
  }

  for (const m of months) {
    const state = await getPlanState(db, m.period);
    const plan = computePlanResult({ period: m.period, ...state });
    assert.equal(plan.income.totalReceived, m.income, `${m.period} income must be ${m.income}`);
    assert.equal(plan.spending.total, m.spending, `${m.period} spending must be ${m.spending}`);
    assert.equal(plan.net, m.net, `${m.period} net must be ${m.net}`);
    assert.equal(state.incomeEntries.length, 1, `${m.period}: exactly 1 income entry`);
  }
});
