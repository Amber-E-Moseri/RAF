import test from 'node:test';
import assert from 'node:assert/strict';

import { GET as getImportRoute } from '../app/api/v1/imports/[id]/route.js';
import { POST as classifyImportRoute } from '../app/api/v1/imports/[id]/classify/route.js';
import { POST as ignoreImportRoute } from '../app/api/v1/imports/[id]/ignore/route.js';
import { POST as unprocessImportRoute } from '../app/api/v1/imports/[id]/unprocess/route.js';
import { POST as unignoreImportRoute } from '../app/api/v1/imports/[id]/unignore/route.js';
import { GET as listImportsRoute } from '../app/api/v1/imports/route.js';
import { DELETE as deleteImportRuleRoute, PATCH as patchImportRuleRoute } from '../app/api/v1/import-rules/[id]/route.js';
import { GET as listImportRulesRoute } from '../app/api/v1/import-rules/route.js';
import {
  classifyImportedTransaction,
  getImportedTransaction,
  ignoreImportedTransaction,
  listReviewedImportedTransactions,
  reopenIgnoredImportedTransaction,
  unprocessImportedTransaction,
} from '../lib/imports/reviewImportedTransactions.js';
import {
  deleteImportReviewRule,
  listImportReviewRules,
  updateImportReviewRule,
} from '../lib/imports/importReviewRules.js';

function createDbDouble({
  importedTransactions = [],
  debts = [],
  fixedBills = [],
  goals = [],
  categories = [
    { id: 'bucket_living', slug: 'living', label: 'Living', isActive: true, sortOrder: 1, allocationPercent: '0.7000' },
    { id: 'bucket_savings', slug: 'savings', label: 'Savings', isActive: true, sortOrder: 2, allocationPercent: '0.2000' },
    { id: 'bucket_debt_payoff', slug: 'debt_payoff', label: 'Debt Payoff', isActive: true, sortOrder: 3, allocationPercent: '0.1000' },
  ],
  importReviewRules = [],
} = {}) {
  const state = {
    importedTransactions: importedTransactions.map((row) => ({ ...row })),
    transactions: [],
    debtPayments: [],
    incomeEntries: [],
    incomeAllocations: [],
    importReviewRules: importReviewRules.map((row) => ({ ...row })),
  };

  const tx = {
    async listImportedTransactions({ householdId }) {
      return state.importedTransactions.filter((row) => row.householdId === householdId).map((row) => ({ ...row }));
    },
    async getImportedTransactionById({ householdId, importedTransactionId }) {
      return state.importedTransactions.find((row) => row.householdId === householdId && row.id === importedTransactionId) ?? null;
    },
    async updateImportedTransaction({ householdId, importedTransactionId, patch }) {
      const index = state.importedTransactions.findIndex((row) => row.householdId === householdId && row.id === importedTransactionId);
      state.importedTransactions[index] = {
        ...state.importedTransactions[index],
        ...patch,
        updatedAt: '2026-03-14T00:00:00.000Z',
      };
      return { ...state.importedTransactions[index] };
    },
    async insertTransaction(payload) {
      const row = { id: `txn_${state.transactions.length + 1}`, ...payload };
      state.transactions.push(row);
      return { ...row };
    },
    async getTransactionById({ householdId, transactionId }) {
      return state.transactions.find((row) => row.householdId === householdId && row.id === transactionId) ?? null;
    },
    async deleteTransaction({ householdId, transactionId }) {
      state.transactions = state.transactions.filter((row) => !(row.householdId === householdId && row.id === transactionId));
    },
    async insertDebtPayment(payload) {
      const row = { id: `dp_${state.debtPayments.length + 1}`, ...payload };
      state.debtPayments.push(row);
      return { ...row };
    },
    async insertIncomeEntry(payload) {
      const row = { id: `income_${state.incomeEntries.length + 1}`, ...payload };
      state.incomeEntries.push(row);
      return { ...row };
    },
    async insertIncomeAllocations(rows) {
      const inserted = rows.map((row, index) => ({
        id: `alloc_${state.incomeAllocations.length + index + 1}`,
        ...row,
      }));
      state.incomeAllocations.push(...inserted);
      return inserted.map((row) => ({ ...row }));
    },
    async getIncomeEntryById({ householdId, incomeId }) {
      return state.incomeEntries.find((row) => row.householdId === householdId && row.id === incomeId) ?? null;
    },
    async deleteIncomeEntry({ householdId, incomeId }) {
      state.incomeEntries = state.incomeEntries.filter((row) => !(row.householdId === householdId && row.id === incomeId));
      state.incomeAllocations = state.incomeAllocations.filter((row) => !(row.householdId === householdId && row.incomeEntryId === incomeId));
    },
    async deleteDebtPaymentByTransactionId({ householdId, transactionId }) {
      state.debtPayments = state.debtPayments.filter((row) => !(row.householdId === householdId && row.transactionId === transactionId));
    },
    async getDebtById({ householdId, debtId }) {
      return debts.find((row) => row.householdId === householdId && row.id === debtId) ?? null;
    },
    async getFixedBillById({ householdId, fixedBillId }) {
      return fixedBills.find((row) => row.householdId === householdId && row.id === fixedBillId) ?? null;
    },
    async getGoalById({ householdId, goalId }) {
      return goals.find((row) => row.householdId === householdId && row.id === goalId) ?? null;
    },
    async listAllocationCategories({ householdId }) {
      return categories.filter((row) => row.householdId == null || row.householdId === householdId).map((row) => ({ ...row }));
    },
    async findImportReviewRuleByNormalizedDescription({ householdId, normalizedDescription }) {
      return state.importReviewRules.find(
        (row) => row.householdId === householdId
          && normalizedDescription.includes(row.matchValue ?? row.normalizedDescription),
      ) ?? null;
    },
    async upsertImportReviewRule(payload) {
      const index = state.importReviewRules.findIndex(
        (row) => row.householdId === payload.householdId
          && (row.matchType ?? 'contains') === (payload.matchType ?? 'contains')
          && String(row.matchValue ?? row.normalizedDescription ?? '') === String(payload.matchValue ?? payload.normalizedDescription ?? ''),
      );
      if (index >= 0) {
        state.importReviewRules[index] = {
          ...state.importReviewRules[index],
          ...payload,
          updatedAt: '2026-03-14T00:00:00.000Z',
        };
        return { ...state.importReviewRules[index] };
      }

      const row = {
        id: `rule_${state.importReviewRules.length + 1}`,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:00:00.000Z',
        ...payload,
      };
      state.importReviewRules.push(row);
      return { ...row };
    },
    async listImportReviewRules({ householdId }) {
      return state.importReviewRules.filter((row) => row.householdId === householdId).map((row) => ({ ...row }));
    },
    async getImportReviewRuleById({ householdId, ruleId }) {
      return state.importReviewRules.find((row) => row.householdId === householdId && row.id === ruleId) ?? null;
    },
    async updateImportReviewRule({ householdId, ruleId, patch }) {
      const index = state.importReviewRules.findIndex((row) => row.householdId === householdId && row.id === ruleId);
      if (index < 0) {
        return null;
      }

      state.importReviewRules[index] = {
        ...state.importReviewRules[index],
        ...patch,
        updatedAt: '2026-03-15T00:00:00.000Z',
      };
      return { ...state.importReviewRules[index] };
    },
    async deleteImportReviewRule({ householdId, ruleId }) {
      const index = state.importReviewRules.findIndex((row) => row.householdId === householdId && row.id === ruleId);
      if (index < 0) {
        return false;
      }

      state.importReviewRules.splice(index, 1);
      return true;
    },
    async touchImportReviewRule({ householdId, ruleId }) {
      const index = state.importReviewRules.findIndex((row) => row.householdId === householdId && row.id === ruleId);
      if (index < 0) {
        return null;
      }

      state.importReviewRules[index] = {
        ...state.importReviewRules[index],
        lastUsedAt: '2026-03-15T00:00:00.000Z',
        updatedAt: '2026-03-15T00:00:00.000Z',
      };
      return { ...state.importReviewRules[index] };
    },
  };

  return {
    state,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

function importedRow(overrides = {}) {
  return {
    id: 'import_1',
    householdId: 'household_1',
    date: '2026-03-10',
    description: 'Coffee Shop',
    amount: '-12.99',
    currency: 'USD',
    source: 'bank_import',
    rawDescription: 'Coffee Shop',
    referenceNumber: null,
    balanceAfterTransaction: null,
    status: 'unreviewed',
    classificationType: null,
    linkedTransactionId: null,
    linkedIncomeEntryId: null,
    linkedDebtId: null,
    linkedFixedBillId: null,
    linkedGoalId: null,
    normalizedDescription: 'coffee shop',
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-03-13T00:00:00.000Z',
    updatedAt: '2026-03-13T00:00:00.000Z',
    ...overrides,
  };
}

test('listing imports returns imported transactions with review status and suggestions', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow()],
    importReviewRules: [{
      id: 'rule_1',
      householdId: 'household_1',
      normalizedDescription: 'coffee shop',
      classificationType: 'transaction',
      categoryId: 'bucket_living',
      linkedDebtId: null,
      linkedFixedBillId: null,
      linkedGoalId: null,
      matchType: 'contains',
      matchValue: 'coffee shop',
      ruleType: 'suggestion',
      autoApply: false,
      createdAt: '2026-03-13T00:00:00.000Z',
      updatedAt: '2026-03-13T00:00:00.000Z',
    }],
  });

  const result = await listReviewedImportedTransactions({
    db,
    householdId: 'household_1',
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'unreviewed');
  assert.equal(result.items[0].suggestion?.classification_type, 'transaction');
  assert.equal(result.items[0].suggestion?.category_id, 'bucket_living');
  assert.equal(result.items[0].suggestion?.rule_type, 'suggestion');
});

test('classifying an imported row into a normal transaction creates traceable RAF data and remembers review choice', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow()],
  });

  const result = await classifyImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'transaction',
      category_id: 'bucket_living',
      review_note: 'Reviewed as spending',
      remember_choice: true,
    },
  });

  assert.equal(result.status, 'classified');
  assert.equal(result.classification_type, 'transaction');
  assert.equal(result.linked_transaction_id, 'txn_1');
  assert.equal(db.state.transactions.length, 1);
  assert.equal(db.state.transactions[0].categoryId, 'bucket_living');
  assert.equal(db.state.importReviewRules.length, 1);
  assert.equal(db.state.importReviewRules[0].normalizedDescription, 'coffee shop');
  assert.equal(db.state.importReviewRules[0].ruleType, 'suggestion');
});

test('classifying a positive imported credit as income creates an income entry and allocations', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ amount: '1200.00', description: 'Payroll Deposit', rawDescription: 'Payroll Deposit', normalizedDescription: 'payroll deposit' })],
  });

  const result = await classifyImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'income',
      review_note: 'Imported payroll',
    },
  });

  assert.equal(result.status, 'classified');
  assert.equal(result.classification_type, 'income');
  assert.equal(result.linked_income_entry_id, 'income_1');
  assert.equal(db.state.transactions.length, 0);
  assert.equal(db.state.incomeEntries.length, 1);
  assert.equal(db.state.incomeEntries[0].sourceName, 'Payroll Deposit');
  assert.equal(db.state.incomeAllocations.length > 0, true);
});

test('transaction approval requires an allocation bucket', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow()],
  });

  await assert.rejects(
    () => classifyImportedTransaction({
      db,
      householdId: 'household_1',
      importedTransactionId: 'import_1',
      input: {
        classification_type: 'transaction',
      },
    }),
    /category_id is required/,
  );
});

test('classifying an imported row into a debt payment creates a linked debt payment record', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ amount: '-100.00', description: 'Visa payment', rawDescription: 'Visa payment', normalizedDescription: 'visa payment' })],
    debts: [{ id: 'debt_1', householdId: 'household_1', name: 'Visa' }],
  });

  const result = await classifyImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'debt_payment',
      debt_id: 'debt_1',
    },
  });

  assert.equal(result.linked_debt_id, 'debt_1');
  assert.equal(result.linked_transaction_id, 'txn_1');
  assert.equal(db.state.debtPayments.length, 1);
  assert.equal(db.state.debtPayments[0].debtId, 'debt_1');
  assert.equal(db.state.transactions[0].categoryId, 'bucket_debt_payoff');
  // Auto-learning creates a rule for every classification, including debt payments.
  assert.equal(db.state.importReviewRules.length, 1);
  assert.equal(db.state.importReviewRules[0].classificationType, 'debt_payment');
});

test('goal funding classification converts a savings transfer into a goal contribution credit', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ amount: '-250.00', description: 'Transfer to Savings', rawDescription: 'Transfer to Savings', normalizedDescription: 'transfer to savings' })],
    goals: [{ id: 'goal_1', householdId: 'household_1', bucketId: 'bucket_savings', name: 'Emergency Fund', active: true }],
  });

  const result = await classifyImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'goal_funding',
      goal_id: 'goal_1',
    },
  });

  assert.equal(result.linked_goal_id, 'goal_1');
  assert.equal(result.linked_transaction_id, 'txn_1');
  assert.equal(db.state.transactions[0].categoryId, 'bucket_savings');
  assert.equal(db.state.transactions[0].linkedGoalId, 'goal_1');
  assert.equal(db.state.transactions[0].direction, 'credit');
  assert.equal(db.state.transactions[0].amount, '250.00');
  assert.equal(db.state.transactions[0].description, 'Contribution to Emergency Fund');
});

test('duplicate and transfer review actions do not create RAF records', async () => {
  const duplicateDb = createDbDouble({
    importedTransactions: [importedRow()],
  });
  const transferDb = createDbDouble({
    importedTransactions: [importedRow({ id: 'import_2' })],
  });

  const duplicate = await classifyImportedTransaction({
    db: duplicateDb,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'duplicate',
      remember_choice: true,
    },
  });
  const transfer = await classifyImportedTransaction({
    db: transferDb,
    householdId: 'household_1',
    importedTransactionId: 'import_2',
    input: {
      classification_type: 'transfer',
    },
  });

  assert.equal(duplicate.classification_type, 'duplicate');
  assert.equal(transfer.classification_type, 'transfer');
  assert.equal(duplicateDb.state.transactions.length, 0);
  assert.equal(transferDb.state.transactions.length, 0);
});

test('ignoring an imported row marks it ignored without creating RAF records', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow()],
  });

  const result = await ignoreImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      review_note: 'Not relevant',
    },
  });

  assert.equal(result.status, 'ignored');
  assert.equal(result.classification_type, 'ignore');
  assert.equal(db.state.transactions.length, 0);
});

test('ignored imported rows can be reopened and reviewed again', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ status: 'ignored', classificationType: 'ignore', reviewedAt: '2026-03-13T00:00:00.000Z' })],
  });

  const reopened = await reopenIgnoredImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
  });

  assert.equal(reopened.status, 'unreviewed');
  assert.equal(reopened.classification_type, null);

  const classified = await classifyImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'transaction',
      category_id: 'bucket_living',
    },
  });

  assert.equal(classified.status, 'classified');
  assert.equal(classified.linked_transaction_id, 'txn_1');
});

test('processed imported rows can be unprocessed and their linked RAF transaction is reversed', async () => {
  const db = createDbDouble({
    importedTransactions: [
      importedRow({
        status: 'classified',
        classificationType: 'goal_funding',
        linkedTransactionId: 'txn_1',
        linkedGoalId: 'goal_1',
        reviewedAt: '2026-03-13T00:00:00.000Z',
      }),
    ],
  });
  db.state.transactions.push({
    id: 'txn_1',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Contribution to Emergency Fund',
    merchant: 'Transfer to Savings',
    amount: '250.00',
    direction: 'credit',
    categoryId: 'bucket_savings',
    linkedDebtId: null,
    source: 'import',
  });

  const reopened = await unprocessImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
  });

  assert.equal(reopened.status, 'unreviewed');
  assert.equal(reopened.classification_type, null);
  assert.equal(reopened.linked_transaction_id, null);
  assert.equal(reopened.linked_goal_id, null);
  assert.equal(db.state.transactions.length, 0);
});

test('unprocessing an income-classified import deletes the linked income entry and allocations', async () => {
  const db = createDbDouble({
    importedTransactions: [
      importedRow({
        status: 'classified',
        classificationType: 'income',
        linkedIncomeEntryId: 'income_1',
        reviewedAt: '2026-03-13T00:00:00.000Z',
      }),
    ],
  });
  db.state.incomeEntries.push({
    id: 'income_1',
    householdId: 'household_1',
    sourceName: 'Payroll Deposit',
    amount: '1200.00',
    receivedDate: '2026-03-10',
    notes: 'Imported payroll',
  });
  db.state.incomeAllocations.push({
    id: 'alloc_1',
    householdId: 'household_1',
    incomeEntryId: 'income_1',
    allocationCategoryId: 'bucket_living',
    allocationPercent: '0.5000',
    allocatedAmount: '600.00',
  });

  const reopened = await unprocessImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
  });

  assert.equal(reopened.status, 'unreviewed');
  assert.equal(reopened.linked_income_entry_id, null);
  assert.equal(db.state.incomeEntries.length, 0);
  assert.equal(db.state.incomeAllocations.length, 0);
});

test('import review rules can be listed, edited, and deleted', async () => {
  const db = createDbDouble({
    importReviewRules: [{
      id: 'rule_1',
      householdId: 'household_1',
      normalizedDescription: 'spotify',
      matchType: 'contains',
      matchValue: 'spotify',
      classificationType: 'transaction',
      categoryId: 'bucket_living',
      linkedDebtId: null,
      linkedFixedBillId: null,
      linkedGoalId: null,
      ruleType: 'reusable_rule',
      autoApply: true,
      createdAt: '2026-03-13T00:00:00.000Z',
      updatedAt: '2026-03-13T00:00:00.000Z',
      lastUsedAt: null,
    }],
  });

  const listed = await listImportReviewRules({
    db,
    householdId: 'household_1',
  });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].rule_type, 'reusable_rule');

  const updated = await updateImportReviewRule({
    db,
    householdId: 'household_1',
    ruleId: 'rule_1',
    input: {
      auto_apply: false,
      rule_type: 'suggestion',
      match_value: 'spotify family',
    },
  });
  assert.equal(updated.auto_apply, false);
  assert.equal(updated.rule_type, 'suggestion');
  assert.equal(updated.match_value, 'spotify family');

  const deleted = await deleteImportReviewRule({
    db,
    householdId: 'household_1',
    ruleId: 'rule_1',
  });
  assert.deepEqual(deleted, { success: true });
  assert.equal(db.state.importReviewRules.length, 0);
});

test('duplicate classification is prevented', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ status: 'classified', classificationType: 'transaction', linkedTransactionId: 'txn_existing' })],
  });

  await assert.rejects(
    () => classifyImportedTransaction({
      db,
      householdId: 'household_1',
      importedTransactionId: 'import_1',
      input: {
        classification_type: 'transaction',
      },
    }),
    /already been reviewed/,
  );
});

test('imported transaction review respects household scoping', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ householdId: 'household_2' })],
  });

  await assert.rejects(
    () => getImportedTransaction({
      db,
      householdId: 'household_1',
      importedTransactionId: 'import_1',
    }),
    /not found/,
  );
});

test('fixed bill payment classification traces to both transaction and fixed bill', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow({ amount: '-80.00', description: 'Phone bill' })],
    fixedBills: [{ id: 'bill_1', householdId: 'household_1', name: 'Phone', categorySlug: 'living' }],
  });

  const result = await classifyImportedTransaction({
    db,
    householdId: 'household_1',
    importedTransactionId: 'import_1',
    input: {
      classification_type: 'fixed_bill_payment',
      fixed_bill_id: 'bill_1',
    },
  });

  assert.equal(result.linked_fixed_bill_id, 'bill_1');
  assert.equal(result.linked_transaction_id, 'txn_1');
  assert.equal(db.state.transactions[0].categoryId, 'bucket_living');
});

test('import review routes expose list, single fetch, classify, and ignore', async () => {
  const db = createDbDouble({
    importedTransactions: [importedRow()],
    debts: [{ id: 'debt_1', householdId: 'household_1', name: 'Visa' }],
  });

  const listResponse = await listImportsRoute(
    new Request('http://localhost/api/v1/imports', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );
  assert.equal(listResponse.status, 200);

  const getResponse = await getImportRoute(
    new Request('http://localhost/api/v1/imports/import_1', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db, params: { id: 'import_1' } },
  );
  assert.equal(getResponse.status, 200);

  const classifyResponse = await classifyImportRoute(
    new Request('http://localhost/api/v1/imports/import_1/classify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        classification_type: 'debt_payment',
        debt_id: 'debt_1',
      }),
    }),
    { db, params: { id: 'import_1' } },
  );
  assert.equal(classifyResponse.status, 200);

  const ignoreDb = createDbDouble({
    importedTransactions: [importedRow()],
  });

  const ignoreResponse = await ignoreImportRoute(
    new Request('http://localhost/api/v1/imports/import_1/ignore', {
      method: 'POST',
      headers: { 'x-household-id': 'household_1' },
      body: JSON.stringify({ review_note: 'ignore' }),
    }),
    { db: ignoreDb, params: { id: 'import_1' } },
  );
  assert.equal(ignoreResponse.status, 200);

  const unignoreDb = createDbDouble({
    importedTransactions: [importedRow({ status: 'ignored', classificationType: 'ignore' })],
  });

  const unignoreResponse = await unignoreImportRoute(
    new Request('http://localhost/api/v1/imports/import_1/unignore', {
      method: 'POST',
      headers: { 'x-household-id': 'household_1' },
    }),
    { db: unignoreDb, params: { id: 'import_1' } },
  );
  assert.equal(unignoreResponse.status, 200);

  const unprocessDb = createDbDouble({
    importedTransactions: [importedRow({ status: 'classified', classificationType: 'transaction', linkedTransactionId: 'txn_1' })],
  });
  unprocessDb.state.transactions.push({
    id: 'txn_1',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Coffee Shop',
    merchant: 'Coffee Shop',
    amount: '12.99',
    direction: 'debit',
    categoryId: 'bucket_living',
    linkedDebtId: null,
    source: 'import',
  });

  const unprocessResponse = await unprocessImportRoute(
    new Request('http://localhost/api/v1/imports/import_1/unprocess', {
      method: 'POST',
      headers: { 'x-household-id': 'household_1' },
    }),
    { db: unprocessDb, params: { id: 'import_1' } },
  );
  assert.equal(unprocessResponse.status, 200);
});

test('import rule routes expose list, update, and delete', async () => {
  const db = createDbDouble({
    importReviewRules: [{
      id: 'rule_1',
      householdId: 'household_1',
      normalizedDescription: 'spotify',
      matchType: 'contains',
      matchValue: 'spotify',
      classificationType: 'transaction',
      categoryId: 'bucket_living',
      linkedDebtId: null,
      linkedFixedBillId: null,
      linkedGoalId: null,
      ruleType: 'reusable_rule',
      autoApply: true,
      createdAt: '2026-03-13T00:00:00.000Z',
      updatedAt: '2026-03-13T00:00:00.000Z',
      lastUsedAt: null,
    }],
  });

  const listResponse = await listImportRulesRoute(
    new Request('http://localhost/api/v1/import-rules', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );
  assert.equal(listResponse.status, 200);

  const patchResponse = await patchImportRuleRoute(
    new Request('http://localhost/api/v1/import-rules/rule_1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        auto_apply: false,
        rule_type: 'suggestion',
      }),
    }),
    { db, params: { id: 'rule_1' } },
  );
  assert.equal(patchResponse.status, 200);

  const deleteResponse = await deleteImportRuleRoute(
    new Request('http://localhost/api/v1/import-rules/rule_1', {
      method: 'DELETE',
      headers: { 'x-household-id': 'household_1' },
    }),
    { db, params: { id: 'rule_1' } },
  );
  assert.equal(deleteResponse.status, 200);
});
