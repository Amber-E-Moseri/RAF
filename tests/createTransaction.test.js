import test from 'node:test';
import assert from 'node:assert/strict';

import { GET, POST } from '../app/api/v1/transactions/route.js';
import { DELETE, PATCH } from '../app/api/v1/transactions/[id]/route.js';
import {
  createTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
} from '../lib/transactions/createTransaction.js';

function createDbDouble({ debt = null, goal = null, transactions = [], debtPayments = [], importedTransactions = [] } = {}) {
  const state = {
    transactions: transactions.map((transaction) => ({ ...transaction })),
    debtPayments: debtPayments.map((payment) => ({ ...payment })),
    importedTransactions: importedTransactions.map((row) => ({ ...row })),
    insertedTransaction: null,
    updatedTransaction: null,
    insertedDebtPayment: null,
    deletedDebtPaymentByTransactionId: [],
    deletedTransactionId: null,
  };

  const tx = {
    async findDebtById({ debtId }) {
      if (debt && debt.id === debtId) {
        return debt;
      }

      return null;
    },
    async getGoalById({ goalId }) {
      if (goal && goal.id === goalId) {
        return goal;
      }

      return null;
    },
    async insertTransaction(payload) {
      state.insertedTransaction = payload;
      const transaction = { id: `txn_${state.transactions.length + 1}`, ...payload };
      state.transactions.push(transaction);
      return transaction;
    },
    async insertDebtPayment(payload) {
      state.insertedDebtPayment = payload;
      state.debtPayments.push(payload);
      return { id: `dp_${state.debtPayments.length}` };
    },
    async listTransactions({ from, to, categoryId, direction, cursor, limit }) {
      let items = state.transactions.filter(
        (transaction) => transaction.transactionDate >= from && transaction.transactionDate <= to,
      );

      if (categoryId) {
        items = items.filter((transaction) => transaction.categoryId === categoryId);
      }

      if (direction) {
        items = items.filter((transaction) => transaction.direction === direction);
      }

      if (cursor) {
        items = items.filter((transaction) => transaction.id > cursor);
      }

      const page = items.slice(0, limit);
      return {
        items: page,
        nextCursor: items.length > limit ? page.at(-1)?.id ?? null : null,
      };
    },
    async getTransactionById({ transactionId }) {
      return state.transactions.find((transaction) => transaction.id === transactionId) ?? null;
    },
    async updateTransaction({ transactionId, patch }) {
      const index = state.transactions.findIndex((transaction) => transaction.id === transactionId);
      state.transactions[index] = {
        ...state.transactions[index],
        ...patch,
      };
      state.updatedTransaction = state.transactions[index];
      return state.transactions[index];
    },
    async deleteDebtPaymentByTransactionId({ transactionId }) {
      state.deletedDebtPaymentByTransactionId.push(transactionId);
      state.debtPayments = state.debtPayments.filter((payment) => payment.transactionId !== transactionId);
    },
    async deleteTransaction({ transactionId }) {
      state.deletedTransactionId = transactionId;
      state.transactions = state.transactions.filter((transaction) => transaction.id !== transactionId);
    },
    async listImportedTransactions() {
      return state.importedTransactions.map((row) => ({ ...row }));
    },
    async updateImportedTransaction({ importedTransactionId, patch }) {
      const index = state.importedTransactions.findIndex((row) => row.id === importedTransactionId);
      state.importedTransactions[index] = {
        ...state.importedTransactions[index],
        ...patch,
      };
      return state.importedTransactions[index];
    },
  };

  return {
    state,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

test('createTransaction creates a normal transaction without a debt payment row', async () => {
  const db = createDbDouble();

  const result = await createTransaction({
    db,
    householdId: 'household_1',
    input: {
      transactionDate: '2026-03-12',
      description: 'Groceries',
      amount: '52.19',
      direction: 'debit',
    },
  });

  assert.equal(result.id, 'txn_1');
  assert.equal(db.state.insertedDebtPayment, null);
  assert.equal(result.source, 'manual');
});

test('createTransaction creates a debt payment row in the same transaction when linkedDebtId is present', async () => {
  const db = createDbDouble({
    debt: { id: 'debt_1', name: 'Visa' },
  });

  const result = await createTransaction({
    db,
    householdId: 'household_1',
    input: {
      transactionDate: '2026-03-12',
      description: 'Visa payment',
      merchant: 'Bank transfer',
      amount: '250.00',
      direction: 'debit',
      linkedDebtId: 'debt_1',
    },
  });

  assert.equal(result.id, 'txn_1');
  assert.deepEqual(db.state.insertedDebtPayment, {
    householdId: 'household_1',
    debtId: 'debt_1',
    transactionId: 'txn_1',
    paymentDate: '2026-03-12',
    amount: '250.00',
  });
  assert.equal(result.source, 'manual');
});

test('createTransaction returns 404 when linked debt is missing', async () => {
  const db = createDbDouble();

  await assert.rejects(
    () =>
      createTransaction({
        db,
        householdId: 'household_1',
        input: {
          transactionDate: '2026-03-12',
          description: 'Loan payment',
          amount: '100.00',
          direction: 'debit',
          linkedDebtId: 'missing_debt',
        },
      }),
    /linked debt not found/,
  );
});

test('createTransaction persists linkedGoalId when the goal matches the selected bucket', async () => {
  const db = createDbDouble({
    goal: { id: 'goal_1', bucketId: 'bucket_savings', active: true, name: 'Emergency Fund' },
  });

  const result = await createTransaction({
    db,
    householdId: 'household_1',
    input: {
      transactionDate: '2026-03-12',
      description: 'Emergency fund transfer',
      amount: '200.00',
      direction: 'credit',
      categoryId: 'bucket_savings',
      linkedGoalId: 'goal_1',
    },
  });

  assert.equal(result.linkedGoalId, 'goal_1');
  assert.equal(db.state.insertedTransaction.linkedGoalId, 'goal_1');
  assert.equal(result.source, 'manual');
});

test('createTransaction rejects linked goals that do not match the selected bucket', async () => {
  const db = createDbDouble({
    goal: { id: 'goal_1', bucketId: 'bucket_emergency', active: true, name: 'Emergency Fund' },
  });

  await assert.rejects(
    () =>
      createTransaction({
        db,
        householdId: 'household_1',
        input: {
          transactionDate: '2026-03-12',
          description: 'Emergency fund transfer',
          amount: '200.00',
          direction: 'credit',
          categoryId: 'bucket_savings',
          linkedGoalId: 'goal_1',
        },
      }),
    /linked goal must match the selected bucket/,
  );
});

test('updateTransaction removes the debt payment when linkedDebtId is removed', async () => {
  const db = createDbDouble({
    transactions: [
      {
        id: 'txn_1',
        transactionDate: '2026-03-12',
        description: 'Visa payment',
        merchant: null,
        amount: '100.00',
        direction: 'debit',
        categoryId: null,
        linkedDebtId: 'debt_1',
      },
    ],
    debtPayments: [
      {
        householdId: 'household_1',
        debtId: 'debt_1',
        transactionId: 'txn_1',
        paymentDate: '2026-03-12',
        amount: '100.00',
      },
    ],
  });

  const result = await updateTransaction({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
    input: {
      linkedDebtId: null,
    },
  });

  assert.equal(result.linkedDebtId, null);
  assert.deepEqual(db.state.deletedDebtPaymentByTransactionId, ['txn_1']);
  assert.equal(db.state.debtPayments.length, 0);
  assert.equal(result.source, 'manual');
});

test('deleteTransaction removes the corresponding debt payment in the same transaction', async () => {
  const db = createDbDouble({
    transactions: [
      {
        id: 'txn_1',
        transactionDate: '2026-03-12',
        description: 'Visa payment',
        merchant: null,
        amount: '100.00',
        direction: 'debit',
        categoryId: null,
        linkedDebtId: 'debt_1',
      },
    ],
    debtPayments: [
      {
        householdId: 'household_1',
        debtId: 'debt_1',
        transactionId: 'txn_1',
        paymentDate: '2026-03-12',
        amount: '100.00',
      },
    ],
  });

  await deleteTransaction({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.deepEqual(db.state.deletedDebtPaymentByTransactionId, ['txn_1']);
  assert.equal(db.state.deletedTransactionId, 'txn_1');
});

test('deleteTransaction reopens the linked imported row when the deleted transaction came from import review', async () => {
  const db = createDbDouble({
    transactions: [
      {
        id: 'txn_1',
        transactionDate: '2026-03-12',
        description: 'Imported payment',
        merchant: null,
        amount: '100.00',
        direction: 'debit',
        categoryId: 'cat_fixed',
        linkedDebtId: null,
        linkedGoalId: null,
        source: 'import',
      },
    ],
    importedTransactions: [
      {
        id: 'import_1',
        linkedTransactionId: 'txn_1',
        status: 'classified',
        classificationType: 'transaction',
        linkedDebtId: null,
        linkedFixedBillId: null,
        linkedGoalId: null,
        reviewedAt: '2026-03-12T00:00:00.000Z',
        reviewNote: 'Saved',
      },
    ],
  });

  await deleteTransaction({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.equal(db.state.deletedTransactionId, 'txn_1');
  assert.deepEqual(db.state.importedTransactions[0], {
    id: 'import_1',
    linkedTransactionId: null,
    status: 'unreviewed',
    classificationType: null,
    linkedDebtId: null,
    linkedFixedBillId: null,
    linkedGoalId: null,
    reviewedAt: null,
    reviewNote: null,
  });
});

test('listTransactions returns items and nextCursor', async () => {
  const db = createDbDouble({
    transactions: [
      {
        id: 'txn_1',
        transactionDate: '2026-03-12',
        description: 'Groceries',
        merchant: null,
        amount: '52.19',
        direction: 'debit',
        categoryId: 'cat_food',
        linkedDebtId: null,
        linkedGoalId: null,
        source: 'manual',
      },
      {
        id: 'txn_2',
        transactionDate: '2026-03-13',
        description: 'Refund',
        merchant: null,
        amount: '-10.00',
        direction: 'credit',
        categoryId: null,
        linkedDebtId: null,
        linkedGoalId: null,
        source: 'manual',
      },
    ],
  });

  const result = await listTransactions({
    db,
    householdId: 'household_1',
    query: {
      from: '2026-03-01',
      to: '2026-03-31',
      categoryId: null,
      direction: null,
      cursor: null,
      limit: 50,
    },
  });

  assert.deepEqual(result, {
    items: [
      {
        id: 'txn_1',
        transactionDate: '2026-03-12',
        description: 'Groceries',
        merchant: null,
        amount: '52.19',
        direction: 'debit',
        categoryId: 'cat_food',
        linkedDebtId: null,
        linkedGoalId: null,
        accountId: null,
        source: 'manual',
        reviewedAt: null,
        reviewedBy: null,
      },
      {
        id: 'txn_2',
        transactionDate: '2026-03-13',
        description: 'Refund',
        merchant: null,
        amount: '-10.00',
        direction: 'credit',
        categoryId: null,
        linkedDebtId: null,
        linkedGoalId: null,
        accountId: null,
        source: 'manual',
        reviewedAt: null,
        reviewedBy: null,
      },
    ],
    nextCursor: null,
  });
});

test('transaction routes cover POST, GET, PATCH, and DELETE', async () => {
  const db = createDbDouble({
    debt: { id: 'debt_1', name: 'Visa' },
    transactions: [
      {
        id: 'txn_existing',
        transactionDate: '2026-03-12',
        description: 'Visa payment',
        merchant: null,
        amount: '75.00',
        direction: 'debit',
        categoryId: null,
        linkedDebtId: 'debt_1',
      },
    ],
    debtPayments: [
      {
        householdId: 'household_1',
        debtId: 'debt_1',
        transactionId: 'txn_existing',
        paymentDate: '2026-03-12',
        amount: '75.00',
      },
    ],
  });

  const postResponse = await POST(
    new Request('http://localhost/api/v1/transactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        transactionDate: '2026-03-14',
        description: 'Groceries',
        amount: '25.00',
        direction: 'debit',
      }),
    }),
    { db },
  );

  assert.equal(postResponse.status, 201);

  const getResponse = await GET(
    new Request('http://localhost/api/v1/transactions?from=2026-03-01&to=2026-03-31', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );

  assert.equal(getResponse.status, 200);

  const patchResponse = await PATCH(
    new Request('http://localhost/api/v1/transactions/txn_existing', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        linkedDebtId: null,
      }),
    }),
    { db, params: { id: 'txn_existing' } },
  );

  assert.equal(patchResponse.status, 200);
  assert.equal((await patchResponse.json()).linkedDebtId, null);

  const deleteResponse = await DELETE(
    new Request('http://localhost/api/v1/transactions/txn_existing', {
      method: 'DELETE',
      headers: {
        'x-household-id': 'household_1',
      },
    }),
    { db, params: { id: 'txn_existing' } },
  );

  assert.equal(deleteResponse.status, 204);
});
