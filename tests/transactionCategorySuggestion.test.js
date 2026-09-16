import test from 'node:test';
import assert from 'node:assert/strict';

import { getTransactionSuggestion } from '../lib/transactions/transactionSuggestion.js';
import { GET } from '../app/api/v1/transactions/[id]/suggestion/route.js';
import { TransactionHttpError } from '../lib/transactions/createTransaction.js';

function makeRule(overrides = {}) {
  return {
    id: 'rule_1',
    normalizedDescription: 'whole foods market',
    normalizedMerchant: 'whole foods',
    classificationType: 'transaction',
    categoryId: 'cat_groceries',
    linkedDebtId: null,
    linkedFixedBillId: null,
    linkedGoalId: null,
    ruleType: 'suggestion',
    matchType: 'contains',
    matchValue: 'whole foods market',
    autoApply: false,
    confirmationCount: 3,
    correctionCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

function makeTransaction(overrides = {}) {
  return {
    id: 'txn_1',
    householdId: 'household_1',
    description: 'Whole Foods Market',
    merchant: null,
    amount: '52.19',
    direction: 'debit',
    categoryId: null,
    linkedDebtId: null,
    linkedGoalId: null,
    ...overrides,
  };
}

function createDbDouble({ transaction = null, rule = null } = {}) {
  const calls = {
    findImportReviewRuleByNormalizedDescription: [],
    findImportReviewRuleByMerchantKey: [],
    touchImportReviewRule: [],
    updateTransaction: [],
  };

  const tx = {
    async getTransactionById({ householdId, transactionId }) {
      if (!transaction) return null;
      if (transaction.householdId !== householdId) return null;
      if (transaction.id !== transactionId) return null;
      return { ...transaction };
    },
    async findImportReviewRuleByNormalizedDescription({ householdId, normalizedDescription }) {
      calls.findImportReviewRuleByNormalizedDescription.push({ householdId, normalizedDescription });
      if (!rule) return null;
      if (rule.normalizedDescription === normalizedDescription) return { ...rule };
      return null;
    },
    async findImportReviewRuleByMerchantKey({ householdId, normalizedMerchant }) {
      calls.findImportReviewRuleByMerchantKey.push({ householdId, normalizedMerchant });
      if (!rule) return null;
      if (rule.normalizedMerchant === normalizedMerchant) return { ...rule };
      return null;
    },
    async touchImportReviewRule({ householdId, ruleId }) {
      calls.touchImportReviewRule.push({ householdId, ruleId });
    },
    async updateTransaction(payload) {
      calls.updateTransaction.push(payload);
    },
  };

  return {
    calls,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

// Test 1: matching description returns suggestion
test('getTransactionSuggestion returns formatted suggestion when description matches a rule', async () => {
  const db = createDbDouble({
    transaction: makeTransaction(),
    rule: makeRule(),
  });

  const result = await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.ok(result.suggestion, 'suggestion should be present');
  assert.equal(result.suggestion.category_id, 'cat_groceries');
  assert.equal(result.suggestion.classification_type, 'transaction');
  assert.equal(result.suggestion.rule_type, 'suggestion');
  assert.equal(result.suggestion.auto_apply, false);
});

// Test 2: no matching rule returns null suggestion
test('getTransactionSuggestion returns null suggestion when no rule matches', async () => {
  const db = createDbDouble({
    transaction: makeTransaction(),
    rule: null,
  });

  const result = await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.deepEqual(result, { suggestion: null });
});

// Test 3: workspace isolation — wrong householdId returns 404, not the other workspace's data
test('getTransactionSuggestion throws 404 when transaction belongs to a different workspace', async () => {
  const db = createDbDouble({
    transaction: makeTransaction({ householdId: 'household_A' }),
    rule: makeRule(),
  });

  await assert.rejects(
    () => getTransactionSuggestion({
      db,
      householdId: 'household_B',
      transactionId: 'txn_1',
    }),
    (err) => {
      assert.ok(err instanceof TransactionHttpError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

// Test 4: transaction not found
test('getTransactionSuggestion throws 404 when transaction does not exist', async () => {
  const db = createDbDouble({ transaction: null, rule: makeRule() });

  await assert.rejects(
    () => getTransactionSuggestion({
      db,
      householdId: 'household_1',
      transactionId: 'txn_missing',
    }),
    (err) => {
      assert.ok(err instanceof TransactionHttpError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

// Test 5: normalization reuse — existing normalizeDescription logic is reused, not duplicated
test('getTransactionSuggestion normalizes description before rule lookup', async () => {
  const db = createDbDouble({
    transaction: makeTransaction({ description: 'WHOLE FOODS  MARKET!!', merchant: null }),
    rule: makeRule({ normalizedDescription: 'whole foods market', normalizedMerchant: null }),
  });

  const result = await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.equal(db.calls.findImportReviewRuleByNormalizedDescription.length, 1);
  assert.equal(db.calls.findImportReviewRuleByNormalizedDescription[0].normalizedDescription, 'whole foods market');
  assert.ok(result.suggestion, 'should match via normalized description');
});

// Test 6: suggestion does not mutate the transaction
test('getTransactionSuggestion never calls updateTransaction', async () => {
  const db = createDbDouble({
    transaction: makeTransaction(),
    rule: makeRule(),
  });

  await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.equal(db.calls.updateTransaction.length, 0, 'updateTransaction must not be called');
});

// Test 7: suggestion is returned as data — no auto-apply side effects
test('getTransactionSuggestion returns suggestion without applying it to the transaction', async () => {
  const db = createDbDouble({
    transaction: makeTransaction({ categoryId: null }),
    rule: makeRule({ autoApply: true }),
  });

  const result = await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.equal(result.suggestion?.auto_apply, true, 'auto_apply flag preserved as data');
  assert.equal(db.calls.updateTransaction.length, 0, 'transaction must not be updated even when auto_apply is true');
});

// Test 8: Accept pattern — service returns suggestion; caller applies to draft without saving
test('getTransactionSuggestion returns category_id for caller to apply to draft', async () => {
  const db = createDbDouble({
    transaction: makeTransaction(),
    rule: makeRule({ categoryId: 'cat_groceries' }),
  });

  const result = await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  assert.equal(result.suggestion?.category_id, 'cat_groceries');
  // Caller applies this to draft state — service itself makes no writes
  assert.equal(db.calls.updateTransaction.length, 0);
});

// Test 9: Dismiss pattern — calling the endpoint again after dismiss still returns null writes
test('getTransactionSuggestion is idempotent and makes no writes on repeated calls', async () => {
  const db = createDbDouble({
    transaction: makeTransaction(),
    rule: makeRule(),
  });

  await getTransactionSuggestion({ db, householdId: 'household_1', transactionId: 'txn_1' });
  await getTransactionSuggestion({ db, householdId: 'household_1', transactionId: 'txn_1' });

  assert.equal(db.calls.updateTransaction.length, 0, 'no writes even on repeated calls');
});

// Test 10: already-matching — suggestion returned even when category matches; UI suppresses display
test('getTransactionSuggestion returns suggestion even when transaction already has matching category', async () => {
  const db = createDbDouble({
    transaction: makeTransaction({ categoryId: 'cat_groceries' }),
    rule: makeRule({ categoryId: 'cat_groceries' }),
  });

  const result = await getTransactionSuggestion({
    db,
    householdId: 'household_1',
    transactionId: 'txn_1',
  });

  // Service returns the suggestion; UI is responsible for suppressing display when already matching
  assert.equal(result.suggestion?.category_id, 'cat_groceries');
});

// Route-level: GET returns 200 with suggestion
test('GET /transactions/:id/suggestion returns 200 and suggestion payload', async () => {
  const db = createDbDouble({
    transaction: makeTransaction(),
    rule: makeRule(),
  });

  const response = await GET(
    new Request('http://localhost/api/v1/transactions/txn_1/suggestion', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db, params: { id: 'txn_1' } },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.suggestion, 'suggestion should be present');
  assert.equal(body.suggestion.category_id, 'cat_groceries');
});

// Route-level: GET returns 404 when transaction missing
test('GET /transactions/:id/suggestion returns 404 when transaction not found', async () => {
  const db = createDbDouble({ transaction: null, rule: null });

  const response = await GET(
    new Request('http://localhost/api/v1/transactions/txn_missing/suggestion', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db, params: { id: 'txn_missing' } },
  );

  assert.equal(response.status, 404);
});
