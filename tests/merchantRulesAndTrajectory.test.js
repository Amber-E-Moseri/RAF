import test from 'node:test';
import assert from 'node:assert/strict';

import { GET as getMerchantRulesRoute, POST as postMerchantRuleRoute } from '../app/api/v1/merchant-rules/route.js';
import { DELETE as deleteMerchantRuleRoute, PATCH as patchMerchantRuleRoute } from '../app/api/v1/merchant-rules/[id]/route.js';
import { POST as applyMonthlyReviewRoute } from '../app/api/v1/monthly-reviews/apply/route.js';
import {
  createMerchantRule,
  deleteMerchantRule,
  listMerchantRules,
  matchMerchantRule,
  updateMerchantRule,
} from '../lib/imports/merchantRules.js';

function createDbDouble({
  merchantRules = [],
  household = { id: 'household_1', activeMonth: '2026-03-01' },
  incomeEntries = [],
  transactions = [],
  debtPayments = [],
  allocationCategories = [],
  monthlyReviews = [],
  surplusSplitRules = [],
} = {}) {
  const state = {
    merchantRules: merchantRules.map((rule) => ({ ...rule })),
    transactions: transactions.map((transaction) => ({ ...transaction })),
    monthlyReviews: monthlyReviews.map((review) => ({ ...review })),
    deletedRuleId: null,
  };

  const tx = {
    async listMerchantRules() {
      return [...state.merchantRules];
    },
    async insertMerchantRule(payload) {
      const rule = { id: `rule_${state.merchantRules.length + 1}`, ...payload };
      state.merchantRules.push(rule);
      return rule;
    },
    async getMerchantRuleById({ ruleId }) {
      return state.merchantRules.find((rule) => rule.id === ruleId) ?? null;
    },
    async updateMerchantRule({ ruleId, patch }) {
      const index = state.merchantRules.findIndex((rule) => rule.id === ruleId);
      state.merchantRules[index] = { ...state.merchantRules[index], ...patch };
      return state.merchantRules[index];
    },
    async deleteMerchantRule({ ruleId }) {
      state.deletedRuleId = ruleId;
      state.merchantRules = state.merchantRules.filter((rule) => rule.id !== ruleId);
    },
    async getHousehold() {
      return household;
    },
    async listIncomeEntries() {
      return incomeEntries;
    },
    async listTransactions() {
      return state.transactions;
    },
    async listDebtPayments() {
      return debtPayments;
    },
    async listAllocationCategories() {
      return allocationCategories;
    },
    async listMonthlyReviews() {
      return state.monthlyReviews;
    },
    async listSurplusSplitRules() {
      return surplusSplitRules;
    },
    async getMonthlyReviewByMonth({ reviewMonth }) {
      return state.monthlyReviews.find((row) => row.reviewMonth === reviewMonth) ?? null;
    },
    async insertMonthlyReview(payload) {
      const review = { id: `review_${state.monthlyReviews.length + 1}`, ...payload };
      state.monthlyReviews.push(review);
      return review;
    },
    async insertTransaction(payload) {
      const transaction = { id: `txn_${state.transactions.length + 1}`, ...payload };
      state.transactions.push(transaction);
      return transaction;
    },
  };

  return {
    state,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

test('merchant rules CRUD supports list, create, patch, and delete', async () => {
  const db = createDbDouble({
    merchantRules: [{ id: 'rule_1', matchType: 'contains', matchValue: 'coffee', categoryId: 'cat_food', priority: 2 }],
  });

  const listed = await listMerchantRules({ db, householdId: 'household_1' });
  assert.equal(listed.items.length, 1);

  const created = await createMerchantRule({
    db,
    householdId: 'household_1',
    input: { matchType: 'starts_with', matchValue: 'Hydro One', categoryId: 'cat_bills', priority: 5 },
  });
  assert.equal(created.id, 'rule_2');
  assert.equal(created.matchType, 'starts_with');
  assert.equal(created.matchValue, 'Hydro One');

  const updated = await updateMerchantRule({
    db,
    householdId: 'household_1',
    ruleId: 'rule_1',
    input: { priority: 10 },
  });
  assert.equal(updated.priority, 10);

  await deleteMerchantRule({ db, householdId: 'household_1', ruleId: 'rule_2' });
  assert.equal(db.state.deletedRuleId, 'rule_2');
});

test('merchant rule matching prefers higher priority, ignores disabled rules, and is case-insensitive', () => {
  const rules = [
    { id: 'rule_1', matchType: 'contains', matchValue: 'coffee', categoryId: 'cat_food', priority: 1, enabled: true, createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'rule_2', matchType: 'exact', matchValue: 'COFFEE SHOP TORONTO', categoryId: 'cat_exact', priority: 10, enabled: true, createdAt: '2026-03-04T00:00:00.000Z' },
    { id: 'rule_3', matchType: 'starts_with', matchValue: 'COFFEE SHOP', categoryId: 'cat_premium', priority: 10, enabled: true, createdAt: '2026-03-02T00:00:00.000Z' },
    { id: 'rule_4', matchType: 'contains', matchValue: 'coffee', categoryId: 'cat_disabled', priority: 100, enabled: false, createdAt: '2026-03-03T00:00:00.000Z' },
  ];

  const matched = matchMerchantRule(rules, 'Coffee Shop Toronto');
  assert.equal(matched.id, 'rule_2');
  assert.equal(matched.categoryId, 'cat_exact');
});

test('merchant rule matching supports regex patterns', () => {
  const matched = matchMerchantRule(
    [
      { id: 'rule_1', matchType: 'regex', matchValue: '^uber\\s+trip$', categoryId: 'cat_transport', priority: 1, createdAt: '2026-03-01T00:00:00.000Z' },
    ],
    'Uber Trip',
  );

  assert.equal(matched.id, 'rule_1');
  assert.equal(matched.categoryId, 'cat_transport');
});

test('merchant rules, trajectory, and monthly review apply routes expose payloads', async () => {
  const db = createDbDouble({
    merchantRules: [{ id: 'rule_1', matchType: 'contains', matchValue: 'coffee', categoryId: 'cat_food', priority: 2 }],
    incomeEntries: [{ receivedDate: '2026-03-10', amount: '1000.00' }],
    transactions: [{ transactionDate: '2026-03-12', amount: '500.00', direction: 'debit' }],
    surplusSplitRules: [{ slug: 'emergency_fund', splitPercent: '1.0000', sortOrder: 1, isActive: true, destinationBucketSlug: 'emergency_fund' }],
    allocationCategories: [{ id: 'cat_ef', slug: 'emergency_fund', label: 'Emergency Fund', allocationPercent: '1.0000', sortOrder: 1, isActive: true }],
  });

  const getResponse = await getMerchantRulesRoute(
    new Request('http://localhost/api/v1/merchant-rules', { headers: { 'x-household-id': 'household_1' } }),
    { db },
  );
  assert.equal(getResponse.status, 200);

  const postResponse = await postMerchantRuleRoute(
    new Request('http://localhost/api/v1/merchant-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-household-id': 'household_1' },
      body: JSON.stringify({ matchType: 'contains', matchValue: 'Hydro', categoryId: 'cat_bills' }),
    }),
    { db },
  );
  assert.equal(postResponse.status, 201);

  const patchResponse = await patchMerchantRuleRoute(
    new Request('http://localhost/api/v1/merchant-rules/rule_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-household-id': 'household_1' },
      body: JSON.stringify({ priority: 4 }),
    }),
    { db, params: { id: 'rule_1' } },
  );
  assert.equal(patchResponse.status, 200);

  const deleteResponse = await deleteMerchantRuleRoute(
    new Request('http://localhost/api/v1/merchant-rules/rule_1', {
      method: 'DELETE',
      headers: { 'x-household-id': 'household_1' },
    }),
    { db, params: { id: 'rule_1' } },
  );
  assert.equal(deleteResponse.status, 204);

  const applyResponse = await applyMonthlyReviewRoute(
    new Request('http://localhost/api/v1/monthly-reviews/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-household-id': 'household_1' },
      body: JSON.stringify({ reviewMonth: '2026-03-01' }),
    }),
    { db },
  );
  assert.equal(applyResponse.status, 201);
});
