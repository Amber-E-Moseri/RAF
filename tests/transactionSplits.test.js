/**
 * Split Transactions — unit tests
 * Covers: split domain logic, attribution-replacement invariant,
 * report non-double-counting, workspace isolation, API routes.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { deleteTransaction, updateTransaction } from '../lib/transactions/createTransaction.js';
import { setTransactionSplits, clearTransactionSplits, indexSplitsByTransactionId, TransactionSplitError } from '../lib/transactions/transactionSplits.js';
import { computeBucketBalancesSnapshot, computeMonthlyBucketProgressSnapshot } from '../lib/raf/reporting.js';
import { DELETE as DELETE_SPLITS, GET as GET_SPLITS, POST as POST_SPLITS, PUT as PUT_SPLITS } from '../app/api/v1/transactions/[id]/splits/route.js';

// ── Test doubles ────────────────────────────────────────────────────────────

function makeTransaction(overrides = {}) {
  return {
    id: 'txn-1',
    householdId: 'ws-1',
    transactionDate: '2026-09-01',
    description: 'Grocery run',
    amount: '100.00',
    direction: 'debit',
    categoryId: 'cat-food',
    source: 'manual',
    ...overrides,
  };
}

function makeDbDouble(transaction = makeTransaction(), splits = [], { categories = null } = {}) {
  const state = {
    transaction: { ...transaction },
    splits: [...splits],
    categories: categories ?? [
      { id: 'cat-food', householdId: 'ws-1', slug: 'food' },
      { id: 'cat-house', householdId: 'ws-1', slug: 'household' },
      { id: 'cat-other', householdId: 'ws-1', slug: 'other' },
    ],
    deletedSplitsForTransaction: null,
    insertedSplits: [],
    deletedDebtPaymentByTransactionId: [],
  };

  return {
    state,
    db: {
      async transaction(fn) {
        return fn(this);
      },
      async getTransactionById({ householdId, transactionId }) {
        if (
          state.transaction?.id === transactionId
          && (state.transaction.householdId === householdId || state.transaction.workspaceId === householdId)
        ) {
          return { ...state.transaction };
        }
        return null;
      },
      async updateTransaction({ transactionId, patch }) {
        if (state.transaction?.id !== transactionId) return null;
        state.transaction = { ...state.transaction, ...patch };
        return { ...state.transaction };
      },
      async deleteTransaction({ transactionId }) {
        if (state.transaction?.id === transactionId) {
          state.transaction = null;
        }
        state.splits = state.splits.filter((s) => s.transactionId !== transactionId);
      },
      async deleteDebtPaymentByTransactionId({ transactionId }) {
        state.deletedDebtPaymentByTransactionId.push(transactionId);
      },
      async findDebtById() {
        return null;
      },
      async getGoalById() {
        return null;
      },
      async listAllocationCategories({ householdId }) {
        return state.categories
          .filter((category) => category.householdId == null || category.householdId === householdId)
          .map((category) => ({ ...category }));
      },
      async insertTransactionSplit(payload) {
        const row = { id: `split-${state.splits.length + 1}`, ...payload };
        state.splits.push(row);
        state.insertedSplits.push(row);
        return { ...row };
      },
      async listTransactionSplits({ householdId, transactionId }) {
        return state.splits
          .filter((s) => s.transactionId === transactionId)
          .filter((s) => s.householdId == null || s.householdId === householdId || s.workspaceId === householdId)
          .map((s) => ({ ...s }));
      },
      async deleteTransactionSplits({ householdId, transactionId }) {
        state.deletedSplitsForTransaction = transactionId;
        state.splits = state.splits.filter(
          (s) => !(s.transactionId === transactionId && (s.householdId == null || s.householdId === householdId || s.workspaceId === householdId)),
        );
      },
      async listImportedTransactions() {
        return [];
      },
    },
  };
}

// ── Section 1: setTransactionSplits domain (tests 1–12) ─────────────────────

describe('setTransactionSplits', () => {
  it('1. creates splits for a valid debit transaction', async () => {
    const { db } = makeDbDouble();
    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '60.00', categoryId: 'cat-food', description: 'Groceries' },
        { amount: '40.00', categoryId: 'cat-house', description: 'Cleaning supplies' },
      ],
    });
    assert.equal(splits.length, 2);
  });

  it('2. each split row carries transactionId, amount, categoryId, description', async () => {
    const { db } = makeDbDouble();
    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '60.00', categoryId: 'cat-food', description: 'Groceries' },
        { amount: '40.00', categoryId: 'cat-house', description: 'Cleaning' },
      ],
    });
    assert.equal(splits[0].transactionId, 'txn-1');
    assert.equal(splits[0].amount, '60.00');
    assert.equal(splits[0].categoryId, 'cat-food');
    assert.equal(splits[1].amount, '40.00');
  });

  it('3. rejects when sum of splits exceeds canonical amount', async () => {
    const { db } = makeDbDouble();
    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        splits: [
          { amount: '70.00', categoryId: 'cat-food', description: '' },
          { amount: '50.00', categoryId: 'cat-house', description: '' },
        ],
      }),
      (err) => err instanceof TransactionSplitError && err.message.includes('must equal'),
    );
  });

  it('4. rejects partial split totals below the canonical amount', async () => {
    const { db } = makeDbDouble();
    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        splits: [
          { amount: '40.00', categoryId: 'cat-food', description: '' },
          { amount: '30.00', categoryId: 'cat-house', description: '' },
        ],
      }),
      (err) => err instanceof TransactionSplitError && err.message.includes('must equal'),
    );
  });

  it('5. allows same category to appear in multiple splits', async () => {
    const { db } = makeDbDouble();
    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '50.00', categoryId: 'cat-food', description: 'A' },
        { amount: '50.00', categoryId: 'cat-food', description: 'B' },
      ],
    });
    assert.equal(splits.filter((s) => s.categoryId === 'cat-food').length, 2);
  });

  it('6. rejects fewer than 2 splits', async () => {
    const { db } = makeDbDouble();
    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        splits: [{ amount: '100.00', categoryId: 'cat-food', description: '' }],
      }),
      TransactionSplitError,
    );
  });

  it('7. deletes existing splits before inserting new ones (atomic replace)', async () => {
    const existingSplits = [
      { id: 'old-1', transactionId: 'txn-1', amount: '50.00', categoryId: 'cat-food', description: '' },
      { id: 'old-2', transactionId: 'txn-1', amount: '50.00', categoryId: 'cat-house', description: '' },
    ];
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits);
    await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '60.00', categoryId: 'cat-other', description: '' },
        { amount: '40.00', categoryId: 'cat-food', description: '' },
      ],
    });
    assert.equal(state.deletedSplitsForTransaction, 'txn-1');
    assert.equal(state.splits.filter((s) => s.categoryId === 'cat-other').length, 1);
  });

  it('8. rejects when transaction does not exist', async () => {
    const { db } = makeDbDouble(null);
    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'missing',
        splits: [
          { amount: '50.00', categoryId: 'cat-food', description: '' },
          { amount: '50.00', categoryId: 'cat-house', description: '' },
        ],
      }),
      (err) => err instanceof TransactionSplitError && err.status === 404,
    );
  });

  it('9. rejects splitting a credit transaction', async () => {
    const { db } = makeDbDouble(makeTransaction({ direction: 'credit', amount: '100.00' }));
    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        splits: [
          { amount: '60.00', categoryId: 'cat-food', description: '' },
          { amount: '40.00', categoryId: 'cat-house', description: '' },
        ],
      }),
      (err) => err instanceof TransactionSplitError,
    );
  });

  it('10. allows null categoryId on a split row', async () => {
    const { db } = makeDbDouble();
    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '60.00', categoryId: null, description: 'Uncategorized' },
        { amount: '40.00', categoryId: 'cat-food', description: 'Food' },
      ],
    });
    assert.equal(splits[0].categoryId, null);
  });

  it('10b. rejects a split category from another workspace before replacing existing splits', async () => {
    const existingSplits = [
      { id: 'old-1', transactionId: 'txn-1', amount: '50.00', categoryId: 'cat-food', description: '' },
      { id: 'old-2', transactionId: 'txn-1', amount: '50.00', categoryId: 'cat-house', description: '' },
    ];
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits, {
      categories: [
        { id: 'cat-food', householdId: 'ws-1', slug: 'food' },
        { id: 'cat-foreign', householdId: 'ws-2', slug: 'foreign' },
      ],
    });

    await assert.rejects(
      () => setTransactionSplits({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        splits: [
          { amount: '50.00', categoryId: 'cat-food', description: '' },
          { amount: '50.00', categoryId: 'cat-foreign', description: '' },
        ],
      }),
      /Split category does not belong to this workspace/,
    );

    assert.deepEqual(state.splits, existingSplits);
  });

  it('11. accepts exact-match split total (sum === canonical amount)', async () => {
    const { db } = makeDbDouble();
    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '60.00', categoryId: 'cat-food', description: '' },
        { amount: '40.00', categoryId: 'cat-house', description: '' },
      ],
    });
    assert.equal(splits.length, 2);
  });

  it('12. splits default description to empty string when omitted', async () => {
    const { db } = makeDbDouble();
    const splits = await setTransactionSplits({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      splits: [
        { amount: '50.00', categoryId: 'cat-food' },
        { amount: '50.00', categoryId: 'cat-house' },
      ],
    });
    assert.equal(splits[0].description, '');
  });
});

// ── Section 2: clearTransactionSplits (tests 13–14) ─────────────────────────

describe('clearTransactionSplits', () => {
  it('13. removes all splits for the transaction', async () => {
    const existingSplits = [
      { id: 's1', transactionId: 'txn-1', amount: '50.00', categoryId: 'cat-food', description: '' },
      { id: 's2', transactionId: 'txn-1', amount: '50.00', categoryId: 'cat-house', description: '' },
    ];
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits);
    await clearTransactionSplits({ db, householdId: 'ws-1', transactionId: 'txn-1' });
    assert.equal(state.splits.length, 0);
  });

  it('14. rejects when transaction does not exist', async () => {
    const { db } = makeDbDouble(null);
    await assert.rejects(
      () => clearTransactionSplits({ db, householdId: 'ws-1', transactionId: 'missing' }),
      (err) => err instanceof TransactionSplitError && err.status === 404,
    );
  });
});

// ── Section 3: indexSplitsByTransactionId (tests 15–16) ─────────────────────

describe('indexSplitsByTransactionId', () => {
  it('15. groups splits by transactionId', () => {
    const splits = [
      { transactionId: 'txn-1', amount: '60.00', categoryId: 'cat-food' },
      { transactionId: 'txn-1', amount: '40.00', categoryId: 'cat-house' },
      { transactionId: 'txn-2', amount: '25.00', categoryId: 'cat-food' },
    ];
    const map = indexSplitsByTransactionId(splits);
    assert.equal(map.get('txn-1').length, 2);
    assert.equal(map.get('txn-2').length, 1);
  });

  it('16. returns empty map for empty array', () => {
    const map = indexSplitsByTransactionId([]);
    assert.equal(map.size, 0);
  });
});

// ── Section 4: Report non-double-counting (tests 17–24) ─────────────────────

const bucket = (id, slug) => ({ id, slug, label: slug, isActive: true, sortOrder: 0 });
const allocation = (bucketId, amount) => ({ allocationCategoryId: bucketId, allocatedAmount: amount });

describe('computeBucketBalancesSnapshot with splits', () => {
  it('17. unsplit transaction uses parent category attribution', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '100.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '50.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }], ['cat-house', { id: 'cat-house', slug: 'household' }]]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById });
    const food = balances.find((b) => b.bucket_id === 'cat-food');
    assert.equal(food.balance, '150.00'); // 200 - 50
  });

  it('18. split transaction uses child splits, not parent category', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '100.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }], ['cat-house', { id: 'cat-house', slug: 'household' }]]);
    const splitsByTransactionId = new Map([
      ['txn-1', [
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '60.00' },
        { transactionId: 'txn-1', categoryId: 'cat-house', amount: '40.00' },
      ]],
    ]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    const food = balances.find((b) => b.bucket_id === 'cat-food');
    const house = balances.find((b) => b.bucket_id === 'cat-house');
    assert.equal(food.balance, '140.00');  // 200 - 60
    assert.equal(house.balance, '60.00');  // 100 - 40
  });

  it('19. no double-counting: parent amount not added when splits present', () => {
    const buckets = [bucket('cat-food', 'food')];
    const incomeAllocations = [allocation('cat-food', '200.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }]]);
    const splitsByTransactionId = new Map([
      ['txn-1', [
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '60.00' },
        { transactionId: 'txn-1', categoryId: null, amount: '40.00' },
      ]],
    ]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    const food = balances.find((b) => b.bucket_id === 'cat-food');
    // Parent 100 must NOT be counted; only the split row for cat-food (60) is counted.
    assert.equal(food.balance, '140.00');  // 200 - 60 (not 200 - 100 - 60)
  });

  it('19b. duplicate same-category split rows aggregate without changing total spend', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '100.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-house', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([
      ['cat-food', { id: 'cat-food', slug: 'food' }],
      ['cat-house', { id: 'cat-house', slug: 'household' }],
    ]);
    const splitsByTransactionId = new Map([
      ['txn-1', [
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '35.00' },
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '25.00' },
        { transactionId: 'txn-1', categoryId: 'cat-house', amount: '40.00' },
      ]],
    ]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    const food = balances.find((b) => b.bucket_id === 'cat-food');
    const house = balances.find((b) => b.bucket_id === 'cat-house');
    assert.equal(food.balance, '140.00');  // 200 - (35 + 25)
    assert.equal(house.balance, '60.00');  // 100 - 40
    assert.equal(
      balances.reduce((sum, row) => sum + parseFloat(row.balance), 0).toFixed(2),
      '200.00',
    );
  });

  it('20. unsplit transactions are unaffected when other transactions are split', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '100.00')];
    const transactions = [
      { id: 'txn-1', categoryId: 'cat-food', amount: '100.00', direction: 'debit' },
      { id: 'txn-2', categoryId: 'cat-house', amount: '30.00', direction: 'debit' },
    ];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }], ['cat-house', { id: 'cat-house', slug: 'household' }]]);
    const splitsByTransactionId = new Map([
      ['txn-1', [
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '60.00' },
        { transactionId: 'txn-1', categoryId: 'cat-house', amount: '40.00' },
      ]],
    ]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    const food = balances.find((b) => b.bucket_id === 'cat-food');
    const house = balances.find((b) => b.bucket_id === 'cat-house');
    assert.equal(food.balance, '140.00');   // 200 - 60
    assert.equal(house.balance, '30.00');   // 100 - 40 (split) - 30 (unsplit)
  });
});

describe('computeMonthlyBucketProgressSnapshot with splits', () => {
  it('21. unsplit transaction contributes to used_this_month via parent category', () => {
    const buckets = [bucket('cat-food', 'food')];
    const incomeAllocations = [allocation('cat-food', '200.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '50.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }]]);

    const progress = computeMonthlyBucketProgressSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById });
    const food = progress.find((b) => b.bucket_id === 'cat-food');
    assert.equal(food.used_this_month, '50.00');
  });

  it('22. split transaction distributes used_this_month to split categories', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '100.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }], ['cat-house', { id: 'cat-house', slug: 'household' }]]);
    const splitsByTransactionId = new Map([
      ['txn-1', [
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '60.00' },
        { transactionId: 'txn-1', categoryId: 'cat-house', amount: '40.00' },
      ]],
    ]);

    const progress = computeMonthlyBucketProgressSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    const food = progress.find((b) => b.bucket_id === 'cat-food');
    const house = progress.find((b) => b.bucket_id === 'cat-house');
    assert.equal(food.used_this_month, '60.00');
    assert.equal(house.used_this_month, '40.00');
  });

  it('23. parent amount is not double-counted in used_this_month', () => {
    const buckets = [bucket('cat-food', 'food')];
    const incomeAllocations = [allocation('cat-food', '200.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }]]);
    const splitsByTransactionId = new Map([
      ['txn-1', [
        { transactionId: 'txn-1', categoryId: 'cat-food', amount: '60.00' },
        { transactionId: 'txn-1', categoryId: null, amount: '40.00' },
      ]],
    ]);

    const progress = computeMonthlyBucketProgressSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    const food = progress.find((b) => b.bucket_id === 'cat-food');
    // Only the split row (60) counts, not the parent 100.
    assert.equal(food.used_this_month, '60.00');
  });

  it('24. empty splitsByTransactionId is backward compatible', () => {
    const buckets = [bucket('cat-food', 'food')];
    const incomeAllocations = [allocation('cat-food', '200.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-food', amount: '50.00', direction: 'debit' }];
    const categoryLookupById = new Map([['cat-food', { id: 'cat-food', slug: 'food' }]]);

    // No splitsByTransactionId argument — default behavior unchanged.
    const progress = computeMonthlyBucketProgressSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById });
    const food = progress.find((b) => b.bucket_id === 'cat-food');
    assert.equal(food.used_this_month, '50.00');
  });
});

// ── Section 5: API route handlers (tests 25–29) ─────────────────────────────

describe('parent transaction edit semantics with splits', () => {
  const existingSplits = [
    { id: 's1', transactionId: 'txn-1', amount: '60.00', categoryId: 'cat-food', description: '' },
    { id: 's2', transactionId: 'txn-1', amount: '40.00', categoryId: 'cat-house', description: '' },
  ];

  it('allows amount update when the new parent amount equals split total', async () => {
    const { db, state } = makeDbDouble(makeTransaction({ amount: '99.00' }), existingSplits);
    const result = await updateTransaction({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      input: { amount: '100.00' },
    });

    assert.equal(result.amount, '100.00');
    assert.equal(state.splits.length, 2);
  });

  it('rejects amount update below split total', async () => {
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits);
    const beforeTransaction = { ...state.transaction };
    const beforeSplits = state.splits.map((split) => ({ ...split }));

    await assert.rejects(
      () => updateTransaction({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        input: { amount: '99.99' },
      }),
      /Split transaction amount must equal the current split total/,
    );

    assert.deepEqual(state.transaction, beforeTransaction);
    assert.deepEqual(state.splits, beforeSplits);
  });

  it('rejects amount update above split total', async () => {
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits);

    await assert.rejects(
      () => updateTransaction({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        input: { amount: '100.01' },
      }),
      /Split transaction amount must equal the current split total/,
    );

    assert.equal(state.transaction.amount, '100.00');
    assert.equal(state.splits.length, 2);
  });

  it('rejects changing a split debit transaction to credit', async () => {
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits);

    await assert.rejects(
      () => updateTransaction({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        input: { direction: 'credit' },
      }),
      /Clear transaction splits before changing a split transaction to credit/,
    );

    assert.equal(state.transaction.direction, 'debit');
    assert.equal(state.splits.length, 2);
  });

  it('allows changing parent category while split attribution remains authoritative', async () => {
    const { db, state } = makeDbDouble(makeTransaction({ categoryId: 'cat-food' }), existingSplits);
    const result = await updateTransaction({
      db,
      householdId: 'ws-1',
      transactionId: 'txn-1',
      input: { categoryId: 'cat-other' },
    });

    assert.equal(result.categoryId, 'cat-other');
    assert.equal(state.splits.length, 2);
  });

  it('parent category is ignored in reporting while splits exist', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household'), bucket('cat-other', 'other')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '200.00'), allocation('cat-other', '200.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-other', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([
      ['cat-food', { id: 'cat-food', slug: 'food' }],
      ['cat-house', { id: 'cat-house', slug: 'household' }],
      ['cat-other', { id: 'cat-other', slug: 'other' }],
    ]);
    const splitsByTransactionId = new Map([['txn-1', existingSplits]]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById, splitsByTransactionId });
    assert.equal(balances.find((b) => b.bucket_id === 'cat-other').balance, '200.00');
    assert.equal(balances.find((b) => b.bucket_id === 'cat-food').balance, '140.00');
    assert.equal(balances.find((b) => b.bucket_id === 'cat-house').balance, '160.00');
  });

  it('clearing splits restores parent category attribution', () => {
    const buckets = [bucket('cat-food', 'food'), bucket('cat-house', 'household'), bucket('cat-other', 'other')];
    const incomeAllocations = [allocation('cat-food', '200.00'), allocation('cat-house', '200.00'), allocation('cat-other', '200.00')];
    const transactions = [{ id: 'txn-1', categoryId: 'cat-other', amount: '100.00', direction: 'debit' }];
    const categoryLookupById = new Map([
      ['cat-food', { id: 'cat-food', slug: 'food' }],
      ['cat-house', { id: 'cat-house', slug: 'household' }],
      ['cat-other', { id: 'cat-other', slug: 'other' }],
    ]);

    const balances = computeBucketBalancesSnapshot({ buckets, incomeAllocations, transactions, categoryLookupById });
    assert.equal(balances.find((b) => b.slug === 'other').balance, '100.00');
    assert.equal(balances.find((b) => b.slug === 'food').balance, '200.00');
    assert.equal(balances.find((b) => b.slug === 'household').balance, '200.00');
  });

  it('deleting a parent transaction removes its splits', async () => {
    const { db, state } = makeDbDouble(makeTransaction(), existingSplits);
    await deleteTransaction({ db, householdId: 'ws-1', transactionId: 'txn-1' });

    assert.equal(state.transaction, null);
    assert.equal(state.splits.length, 0);
  });

  it('failed parent update leaves parent and splits unchanged', async () => {
    const { db, state } = makeDbDouble(makeTransaction({ description: 'Before' }), existingSplits);
    const beforeTransaction = { ...state.transaction };
    const beforeSplits = state.splits.map((split) => ({ ...split }));

    await assert.rejects(
      () => updateTransaction({
        db,
        householdId: 'ws-1',
        transactionId: 'txn-1',
        input: { amount: '25.00', description: 'After' },
      }),
      /Split transaction amount must equal the current split total/,
    );

    assert.deepEqual(state.transaction, beforeTransaction);
    assert.deepEqual(state.splits, beforeSplits);
  });
});

function makeApiRequest(body, id = 'txn-1', householdId = 'ws-1') {
  const req = {
    headers: { get: (name) => (name === 'x-household-id' ? householdId : null) },
    async json() { return body; },
  };
  const ctx = {
    params: { id },
    db: makeDbDouble().db,
    householdId,
  };
  ctx.db.transaction = async (fn) => fn(ctx.db);
  return { req, ctx };
}

describe('transaction split API routes', () => {
  it('25. GET returns existing splits for the scoped parent transaction', async () => {
    const { db } = makeDbDouble(makeTransaction(), [
      { id: 's1', householdId: 'ws-1', transactionId: 'txn-1', amount: '60.00', categoryId: 'cat-food', description: 'A' },
      { id: 's2', householdId: 'ws-1', transactionId: 'txn-1', amount: '40.00', categoryId: 'cat-house', description: 'B' },
    ]);
    const req = { headers: { get: () => 'ws-1' } };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await GET_SPLITS(req, ctx);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.splits.length, 2);
  });

  it('26. PUT returns 200 with splits on valid exact-conservation request', async () => {
    const { db } = makeDbDouble();
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '60.00', categoryId: 'cat-food', description: 'A' },
            { amount: '40.00', categoryId: 'cat-house', description: 'B' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await PUT_SPLITS(req, ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.splits.length, 2);
  });

  it('27. POST remains a compatibility alias for exact-conservation replacement', async () => {
    const { db } = makeDbDouble();
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '60.00', categoryId: 'cat-food', description: 'A' },
            { amount: '40.00', categoryId: 'cat-house', description: 'B' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await POST_SPLITS(req, ctx);
    assert.equal(res.status, 200);
  });

  it('28. returns 400 when split sum exceeds transaction amount', async () => {
    const { db } = makeDbDouble();
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '80.00', categoryId: 'cat-food', description: '' },
            { amount: '50.00', categoryId: 'cat-house', description: '' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await POST_SPLITS(req, ctx);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /must equal/);
  });

  it('29. returns 400 when split sum is below transaction amount', async () => {
    const { db } = makeDbDouble();
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '40.00', categoryId: 'cat-food', description: '' },
            { amount: '30.00', categoryId: 'cat-house', description: '' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await PUT_SPLITS(req, ctx);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /must equal/);
  });

  it('30. returns 404 when transaction not found', async () => {
    const { db } = makeDbDouble(null);
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '50.00', categoryId: 'cat-food', description: '' },
            { amount: '50.00', categoryId: 'cat-house', description: '' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'missing' }, db, householdId: 'ws-1' };
    const res = await POST_SPLITS(req, ctx);
    assert.equal(res.status, 404);
  });

  it('31. returns 422 when a split category belongs to another workspace', async () => {
    const { db } = makeDbDouble(makeTransaction(), [], {
      categories: [
        { id: 'cat-food', householdId: 'ws-1', slug: 'food' },
        { id: 'cat-foreign', householdId: 'ws-2', slug: 'foreign' },
      ],
    });
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '50.00', categoryId: 'cat-food', description: '' },
            { amount: '50.00', categoryId: 'cat-foreign', description: '' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await PUT_SPLITS(req, ctx);
    assert.equal(res.status, 422);
  });

  it('32. trusted context household overrides an untrusted workspace header', async () => {
    const { db } = makeDbDouble(makeTransaction({ householdId: 'ws-1' }));
    const req = {
      headers: { get: () => 'ws-2' },
      async json() {
        return {
          splits: [
            { amount: '60.00', categoryId: 'cat-food', description: 'A' },
            { amount: '40.00', categoryId: 'cat-house', description: 'B' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await PUT_SPLITS(req, ctx);
    assert.equal(res.status, 200);
  });

  it('32b. client workspace headers are not trusted without server context', async () => {
    const { db } = makeDbDouble(makeTransaction({ householdId: 'ws-1' }));
    const req = { headers: { get: () => 'ws-1' } };
    const ctx = { params: { id: 'txn-1' }, db };
    const res = await GET_SPLITS(req, ctx);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, 'householdId is required');
  });

  it('33. cross-workspace read is denied by parent ownership check', async () => {
    const { db } = makeDbDouble(makeTransaction({ householdId: 'ws-1' }));
    const req = { headers: { get: () => 'ws-1' } };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-2' };
    const res = await GET_SPLITS(req, ctx);
    assert.equal(res.status, 404);
  });

  it('34. cross-workspace replace is denied by parent ownership check', async () => {
    const { db } = makeDbDouble(makeTransaction({ householdId: 'ws-1' }));
    const req = {
      headers: { get: () => 'ws-1' },
      async json() {
        return {
          splits: [
            { amount: '60.00', categoryId: 'cat-food', description: 'A' },
            { amount: '40.00', categoryId: 'cat-house', description: 'B' },
          ],
        };
      },
    };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-2' };
    const res = await PUT_SPLITS(req, ctx);
    assert.equal(res.status, 404);
  });

  it('35. DELETE returns 204 on successful clear', async () => {
    const { db } = makeDbDouble();
    const req = { headers: { get: () => 'ws-1' } };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-1' };
    const res = await DELETE_SPLITS(req, ctx);
    assert.equal(res.status, 204);
  });

  it('36. cross-workspace delete is denied by parent ownership check', async () => {
    const { db } = makeDbDouble(makeTransaction({ householdId: 'ws-1' }));
    const req = { headers: { get: () => 'ws-1' } };
    const ctx = { params: { id: 'txn-1' }, db, householdId: 'ws-2' };
    const res = await DELETE_SPLITS(req, ctx);
    assert.equal(res.status, 404);
  });

  it('37. returns 404 when clearing splits for non-existent transaction', async () => {
    const { db } = makeDbDouble(null);
    const req = { headers: { get: () => 'ws-1' } };
    const ctx = { params: { id: 'missing' }, db, householdId: 'ws-1' };
    const res = await DELETE_SPLITS(req, ctx);
    assert.equal(res.status, 404);
  });
});
