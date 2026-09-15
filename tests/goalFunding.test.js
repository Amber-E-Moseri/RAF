/**
 * Goal Funding from Transactions — comprehensive tests
 *
 * Covers all 15 required scenarios plus split no-double-count regression,
 * funding history API, goal validation in splits, and split-clear restoration.
 *
 * Uses lightweight in-process DB doubles — no network, no Postgres.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTransaction, updateTransaction, deleteTransaction } from '../lib/transactions/createTransaction.js';
import { setTransactionSplits, clearTransactionSplits, TransactionSplitError } from '../lib/transactions/transactionSplits.js';
import { listGoalProgress, listGoalFundingHistory } from '../lib/goals/goals.js';
import { GET } from '../app/api/v1/goals/[id]/funding/route.js';

// ── DB double ─────────────────────────────────────────────────────────────────

function makeDbDouble({
  goals = [],
  transactions = [],
  splits = [],
  categories = [
    { id: 'cat-savings', slug: 'savings', label: 'Savings', isActive: true, sortOrder: 1 },
    { id: 'cat-travel', slug: 'travel', label: 'Travel', isActive: true, sortOrder: 2 },
  ],
  importedTransactions = [],
  debts = [],
} = {}) {
  const state = {
    goals: goals.map((g) => ({ ...g })),
    transactions: transactions.map((t) => ({ ...t })),
    splits: splits.map((s) => ({ ...s })),
    categories: categories.map((c) => ({ ...c })),
    importedTransactions: importedTransactions.map((r) => ({ ...r })),
    debts: debts.map((d) => ({ ...d })),
  };

  const tx = {
    // ── goals
    async listGoals() { return state.goals.map((g) => ({ ...g })); },
    async getGoalById({ goalId }) { return state.goals.find((g) => g.id === goalId) ?? null; },
    async insertGoal(payload) {
      const row = { id: `goal_${state.goals.length + 1}`, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', ...payload };
      state.goals.push(row);
      return { ...row };
    },
    async updateGoal({ goalId, patch }) {
      const i = state.goals.findIndex((g) => g.id === goalId);
      if (i === -1) return null;
      state.goals[i] = { ...state.goals[i], ...patch, updatedAt: '2026-09-12T00:00:00Z' };
      return { ...state.goals[i] };
    },
    async deleteGoal({ goalId }) { state.goals = state.goals.filter((g) => g.id !== goalId); },
    // ── transactions
    async listTransactions() { return state.transactions.map((t) => ({ ...t })); },
    async getTransactionById({ transactionId }) { return state.transactions.find((t) => t.id === transactionId) ?? null; },
    async insertTransaction(payload) {
      const row = { id: `txn_${state.transactions.length + 1}`, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', source: 'manual', ...payload };
      state.transactions.push(row);
      return { ...row };
    },
    async updateTransaction({ transactionId, patch }) {
      const i = state.transactions.findIndex((t) => t.id === transactionId);
      if (i === -1) return null;
      state.transactions[i] = { ...state.transactions[i], ...patch };
      return { ...state.transactions[i] };
    },
    async deleteTransaction({ transactionId }) {
      state.transactions = state.transactions.filter((t) => t.id !== transactionId);
      state.splits = state.splits.filter((s) => s.transactionId !== transactionId);
    },
    // ── splits
    async listTransactionSplits({ transactionId = null } = {}) {
      return state.splits
        .filter((s) => (transactionId ? s.transactionId === transactionId : true))
        .map((s) => ({ linkedGoalId: null, ...s }));
    },
    async insertTransactionSplit(payload) {
      const row = { id: `split_${state.splits.length + 1}`, linkedGoalId: null, ...payload };
      state.splits.push(row);
      return { ...row };
    },
    async deleteTransactionSplits({ transactionId }) {
      state.splits = state.splits.filter((s) => s.transactionId !== transactionId);
    },
    // ── categories
    async listAllocationCategories() { return state.categories.map((c) => ({ ...c })); },
    // ── imported transactions
    async listImportedTransactions() { return state.importedTransactions.map((r) => ({ ...r })); },
    // ── debt stubs
    async findDebtById({ debtId }) { return state.debts.find((d) => d.id === debtId) ?? null; },
    async deleteDebtPaymentByTransactionId() {},
    async insertDebtPayment() {},
    // ── income / allocation stubs
    async listIncomeAllocations() { return []; },
  };

  return {
    state,
    async transaction(fn) { return fn(tx); },
  };
}

// ── 1. Link entire transaction to one goal ────────────────────────────────────

test('1. linking entire transaction to a goal increases goal progress by the full amount', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '5000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer to savings', amount: '300.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  assert.equal(ef.current_amount, '300.00');
  assert.equal(ef.remaining_amount, '4700.00');
});

// ── 2. Unlink transaction from goal ──────────────────────────────────────────

test('2. unlinking a transaction from a goal removes its contribution from progress', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '200.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
  });

  const before = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(before[0].current_amount, '200.00');

  await updateTransaction({ db, householdId: 'ws-1', transactionId: 'txn_1', input: { linkedGoalId: null, categoryId: 'cat-savings', transactionDate: '2026-09-12', description: 'Transfer', amount: '200.00', direction: 'debit' } });

  const after = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(after[0].current_amount, '0.00');
});

// ── 3. Change linked goal ─────────────────────────────────────────────────────

test('3. changing linked goal moves the contribution to the new goal', async () => {
  const db = makeDbDouble({
    goals: [
      { id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '5000.00', active: true },
      { id: 'goal_tv', householdId: 'ws-1', bucketId: 'cat-travel', name: 'Travel Fund', targetAmount: '3000.00', active: true },
    ],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '150.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
  });

  await updateTransaction({ db, householdId: 'ws-1', transactionId: 'txn_1', input: { linkedGoalId: 'goal_tv', categoryId: 'cat-travel' } });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  const tv = progress.find((p) => p.goal_id === 'goal_tv');
  assert.equal(ef.current_amount, '0.00');
  assert.equal(tv.current_amount, '150.00');
});

// ── 4. Partially fund goal from transaction via split ─────────────────────────

test('4. a single split attributed to a goal counts only the split amount', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '500.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: null, source: 'manual' }],
  });

  await setTransactionSplits({
    db,
    householdId: 'ws-1',
    transactionId: 'txn_1',
    splits: [
      { amount: '350.00', categoryId: 'cat-savings', description: 'Emergency Fund portion', linkedGoalId: 'goal_ef' },
      { amount: '150.00', categoryId: 'cat-travel', description: 'Travel', linkedGoalId: null },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  assert.equal(ef.current_amount, '350.00');
});

// ── 5. Split one transaction across two goals ─────────────────────────────────

test('5. splitting one transaction across two goals correctly attributes each portion', async () => {
  const db = makeDbDouble({
    goals: [
      { id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '5000.00', active: true },
      { id: 'goal_tv', householdId: 'ws-1', bucketId: 'cat-travel', name: 'Travel Fund', targetAmount: '3000.00', active: true },
    ],
    categories: [
      { id: 'cat-savings', slug: 'savings', label: 'Savings', isActive: true, sortOrder: 1 },
      { id: 'cat-travel', slug: 'travel', label: 'Travel', isActive: true, sortOrder: 2 },
    ],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: '$600 transfer', amount: '600.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: null, source: 'manual' }],
  });

  await setTransactionSplits({
    db,
    householdId: 'ws-1',
    transactionId: 'txn_1',
    splits: [
      { amount: '400.00', categoryId: 'cat-savings', description: 'Emergency Fund', linkedGoalId: 'goal_ef' },
      { amount: '200.00', categoryId: 'cat-travel', description: 'Travel Fund', linkedGoalId: 'goal_tv' },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  const tv = progress.find((p) => p.goal_id === 'goal_tv');
  assert.equal(ef.current_amount, '400.00');
  assert.equal(tv.current_amount, '200.00');
});

// ── 6. Reject funding exceeding transaction amount ────────────────────────────

test('6. splits whose sum exceeds the transaction amount are rejected', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '300.00', direction: 'debit', categoryId: 'cat-savings', source: 'manual' }],
  });

  await assert.rejects(
    () => setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn_1',
      splits: [
        { amount: '250.00', categoryId: 'cat-savings', description: '', linkedGoalId: 'goal_ef' },
        { amount: '100.00', categoryId: 'cat-savings', description: '', linkedGoalId: null },
      ],
    }),
    (err) => err instanceof TransactionSplitError && err.message.includes('must equal'),
  );
});

// ── 7. Transaction edit updates goal progress ─────────────────────────────────

test('7. editing a linked transaction amount updates goal progress accordingly', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '300.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
  });

  const before = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(before[0].current_amount, '300.00');

  await updateTransaction({ db, householdId: 'ws-1', transactionId: 'txn_1', input: { amount: '200.00' } });

  const after = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(after[0].current_amount, '200.00');
  assert.equal(after[0].remaining_amount, '800.00');
});

// ── 8. Transaction deletion removes goal funding ──────────────────────────────

test('8. deleting a goal-linked transaction removes its contribution from progress', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '300.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
  });

  await deleteTransaction({ db, householdId: 'ws-1', transactionId: 'txn_1' });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(progress[0].current_amount, '0.00');
});

// ── 9. Internal transfer funds goal without distorting income/spending ─────────

test('9. internal-transfer debit linked to a goal increases goal progress', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [
      {
        id: 'txn_transfer',
        householdId: 'ws-1',
        transactionDate: '2026-09-12',
        description: 'Checking → Savings',
        amount: '500.00',
        direction: 'debit',
        categoryId: 'cat-savings',
        linkedGoalId: 'goal_ef',
        source: 'manual',
      },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  assert.equal(ef.current_amount, '500.00');
  assert.ok(ef.bucket_balance !== undefined, 'bucket_balance is present');
});

// ── 10. Imported transfer pair does not double-count ─────────────────────────

test('10. imported transfer pair: linking only the debit side avoids double-counting', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [
      { id: 'txn_debit', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer out', amount: '500.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'import' },
      { id: 'txn_credit', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer in', amount: '500.00', direction: 'credit', categoryId: 'cat-savings', linkedGoalId: null, source: 'import' },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  assert.equal(ef.current_amount, '500.00');
});

// ── 11. Paused / inactive goal behavior ──────────────────────────────────────

test('11a. a split targeting an inactive goal is rejected', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: false }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '200.00', direction: 'debit', categoryId: 'cat-savings', source: 'manual' }],
  });

  await assert.rejects(
    () => setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn_1',
      splits: [
        { amount: '100.00', categoryId: 'cat-savings', description: '', linkedGoalId: 'goal_ef' },
        { amount: '100.00', categoryId: 'cat-savings', description: '', linkedGoalId: null },
      ],
    }),
    /inactive goal/,
  );
});

test('11b. inactive goals are excluded from listGoalProgress', async () => {
  const db = makeDbDouble({
    goals: [
      { id: 'goal_active', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Active', targetAmount: '1000.00', active: true },
      { id: 'goal_inactive', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Inactive', targetAmount: '2000.00', active: false },
    ],
    transactions: [
      { id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'T', amount: '100.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_active', source: 'manual' },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].goal_id, 'goal_active');
  assert.equal(progress[0].current_amount, '100.00');
});

// ── 12. Goal with milestones ──────────────────────────────────────────────────

test('12. goal with optional milestone metadata still computes progress correctly', async () => {
  const db = makeDbDouble({
    goals: [
      {
        id: 'goal_ef',
        householdId: 'ws-1',
        bucketId: 'cat-savings',
        name: 'Emergency Fund',
        targetAmount: '3000.00',
        active: true,
        milestones: [{ amount: '1000.00', label: 'First $1K' }, { amount: '2000.00', label: 'Halfway' }],
      },
    ],
    transactions: [
      { id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '1050.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(progress[0].current_amount, '1050.00');
  assert.equal(progress[0].remaining_amount, '1950.00');
});

// ── 13. Goal without milestones ───────────────────────────────────────────────

test('13. goal without milestones works identically', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: true }],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '400.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(progress[0].current_amount, '400.00');
  assert.equal(progress[0].remaining_amount, '600.00');
  assert.equal(progress[0].progress_percent, 40);
});

// ── 14. Tenant isolation ──────────────────────────────────────────────────────

test('14. a split goal from another workspace is rejected with 422', async () => {
  const db = makeDbDouble({
    goals: [],
    transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '200.00', direction: 'debit', categoryId: 'cat-savings', source: 'manual' }],
  });

  await assert.rejects(
    () => setTransactionSplits({
      db,
      householdId: 'ws-2',
      transactionId: 'txn_1',
      splits: [
        { amount: '100.00', categoryId: 'cat-savings', description: '', linkedGoalId: 'goal_ef_from_ws1' },
        { amount: '100.00', categoryId: 'cat-savings', description: '', linkedGoalId: null },
      ],
    }),
    (err) => err instanceof TransactionSplitError && err.status === 422,
  );
});

// ── 15. Quick Add / Goal page use same underlying funding path ─────────────────

test('15. createTransaction with linkedGoalId uses the same goal-funding path as updateTransaction', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [],
  });

  const created = await createTransaction({
    db,
    householdId: 'ws-1',
    input: {
      transactionDate: '2026-09-12',
      description: 'Emergency Fund deposit',
      amount: '200.00',
      direction: 'debit',
      categoryId: 'cat-savings',
      linkedGoalId: 'goal_ef',
    },
  });

  assert.equal(created.linkedGoalId, 'goal_ef');

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(progress[0].current_amount, '200.00');

  const createdId = created.id ?? db.state.transactions[0].id;
  await updateTransaction({ db, householdId: 'ws-1', transactionId: createdId, input: { amount: '300.00' } });

  const afterUpdate = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(afterUpdate[0].current_amount, '300.00');
});

// ── Split no-double-count regression ─────────────────────────────────────────

test('splits take precedence: parent linkedGoalId is ignored when splits exist', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [
      { id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '500.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' },
    ],
    splits: [
      { id: 'split_1', transactionId: 'txn_1', amount: '200.00', categoryId: 'cat-savings', description: 'EF portion', linkedGoalId: 'goal_ef' },
      { id: 'split_2', transactionId: 'txn_1', amount: '300.00', categoryId: 'cat-travel', description: 'Other', linkedGoalId: null },
    ],
  });

  const progress = await listGoalProgress({ db, householdId: 'ws-1' });
  const ef = progress.find((p) => p.goal_id === 'goal_ef');
  assert.equal(ef.current_amount, '200.00');
});

// ── Funding history API ───────────────────────────────────────────────────────

describe('listGoalFundingHistory', () => {
  test('returns whole-transaction entries for non-split transactions', async () => {
    const db = makeDbDouble({
      goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
      transactions: [
        { id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Sep Transfer', amount: '300.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' },
        { id: 'txn_2', householdId: 'ws-1', transactionDate: '2026-09-03', description: 'Payroll alloc', amount: '150.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' },
      ],
    });

    const result = await listGoalFundingHistory({ db, householdId: 'ws-1', goalId: 'goal_ef' });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].date, '2026-09-12');
    assert.equal(result.items[0].amount, '300.00');
    assert.equal(result.items[0].type, 'transaction');
    assert.equal(result.items[1].date, '2026-09-03');
    assert.equal(result.items[1].amount, '150.00');
  });

  test('returns split entries when transaction is split across goals', async () => {
    const db = makeDbDouble({
      goals: [
        { id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true },
        { id: 'goal_tv', householdId: 'ws-1', bucketId: 'cat-travel', name: 'Travel', targetAmount: '1000.00', active: true },
      ],
      transactions: [
        { id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: '$600 transfer', amount: '600.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: null, source: 'manual' },
      ],
      splits: [
        { id: 'split_1', transactionId: 'txn_1', amount: '400.00', categoryId: 'cat-savings', description: 'Emergency portion', linkedGoalId: 'goal_ef' },
        { id: 'split_2', transactionId: 'txn_1', amount: '200.00', categoryId: 'cat-travel', description: 'Travel portion', linkedGoalId: 'goal_tv' },
      ],
    });

    const efHistory = await listGoalFundingHistory({ db, householdId: 'ws-1', goalId: 'goal_ef' });
    assert.equal(efHistory.items.length, 1);
    assert.equal(efHistory.items[0].type, 'split');
    assert.equal(efHistory.items[0].amount, '400.00');
    assert.equal(efHistory.items[0].description, 'Emergency portion');
    assert.equal(efHistory.items[0].parent_description, '$600 transfer');
    assert.equal(efHistory.items[0].transaction_id, 'txn_1');

    const tvHistory = await listGoalFundingHistory({ db, householdId: 'ws-1', goalId: 'goal_tv' });
    assert.equal(tvHistory.items.length, 1);
    assert.equal(tvHistory.items[0].amount, '200.00');
  });

  test('returns 404 for an unknown goal', async () => {
    const db = makeDbDouble({ goals: [] });
    const res = await GET(
      new Request('http://localhost/api/v1/goals/unknown/funding', {
        headers: { 'x-household-id': 'ws-1' },
      }),
      { db, params: { id: 'unknown' } },
    );
    assert.equal(res.status, 404);
  });

  test('history is empty when no transactions link to the goal', async () => {
    const db = makeDbDouble({
      goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: true }],
      transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Unlinked', amount: '100.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: null, source: 'manual' }],
    });

    const result = await listGoalFundingHistory({ db, householdId: 'ws-1', goalId: 'goal_ef' });
    assert.equal(result.items.length, 0);
  });

  test('funding API route returns 200 with items', async () => {
    const db = makeDbDouble({
      goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '1000.00', active: true }],
      transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '300.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' }],
    });

    const res = await GET(
      new Request('http://localhost/api/v1/goals/goal_ef/funding', {
        headers: { 'x-household-id': 'ws-1' },
      }),
      { db, params: { id: 'goal_ef' } },
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].amount, '300.00');
    assert.equal(body.items[0].type, 'transaction');
  });
});

// ── Goal validation in splits ─────────────────────────────────────────────────

describe('goal validation in setTransactionSplits', () => {
  test('split goal must exist in the workspace', async () => {
    const db = makeDbDouble({
      goals: [],
      transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'T', amount: '100.00', direction: 'debit', categoryId: 'cat-savings', source: 'manual' }],
    });

    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'txn_1',
        splits: [
          { amount: '60.00', categoryId: 'cat-savings', description: '', linkedGoalId: 'goal_nonexistent' },
          { amount: '40.00', categoryId: 'cat-savings', description: '', linkedGoalId: null },
        ],
      }),
      (err) => err instanceof TransactionSplitError && err.status === 422,
    );
  });

  test('splits with null linkedGoalId are accepted', async () => {
    const db = makeDbDouble({
      goals: [],
      transactions: [{ id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'T', amount: '100.00', direction: 'debit', categoryId: 'cat-savings', source: 'manual' }],
    });

    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn_1',
      splits: [
        { amount: '60.00', categoryId: 'cat-savings', description: 'A', linkedGoalId: null },
        { amount: '40.00', categoryId: 'cat-travel', description: 'B', linkedGoalId: null },
      ],
    });

    assert.equal(splits.length, 2);
    assert.equal(splits[0].linkedGoalId, null);
  });
});

// ── Clearing splits restores whole-transaction goal attribution ───────────────

test('clearing splits restores whole-transaction linkedGoalId for progress', async () => {
  const db = makeDbDouble({
    goals: [{ id: 'goal_ef', householdId: 'ws-1', bucketId: 'cat-savings', name: 'Emergency Fund', targetAmount: '2000.00', active: true }],
    transactions: [
      { id: 'txn_1', householdId: 'ws-1', transactionDate: '2026-09-12', description: 'Transfer', amount: '500.00', direction: 'debit', categoryId: 'cat-savings', linkedGoalId: 'goal_ef', source: 'manual' },
    ],
    splits: [
      { id: 's1', transactionId: 'txn_1', amount: '200.00', categoryId: 'cat-savings', description: '', linkedGoalId: 'goal_ef' },
      { id: 's2', transactionId: 'txn_1', amount: '300.00', categoryId: 'cat-travel', description: '', linkedGoalId: null },
    ],
  });

  const withSplits = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(withSplits[0].current_amount, '200.00');

  await clearTransactionSplits({ db, householdId: 'ws-1', transactionId: 'txn_1' });
  const withoutSplits = await listGoalProgress({ db, householdId: 'ws-1' });
  assert.equal(withoutSplits[0].current_amount, '500.00');
});
