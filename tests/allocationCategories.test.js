import test from 'node:test';
import assert from 'node:assert/strict';

import { GET, PUT } from '../app/api/v1/household/allocation-categories/route.js';
import {
  listHouseholdAllocationCategories,
  replaceHouseholdAllocationCategories,
} from '../lib/household/allocationCategories.js';
import { computeDepositAllocations } from '../lib/raf/computeDepositAllocations.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';

function createDbDouble(categories) {
  const state = {
    categories: categories.map((category) => ({ ...category })),
  };

  const tx = {
    async listAllocationCategories() {
      return state.categories.map((category) => ({ ...category }));
    },
    async replaceAllocationCategories({ items }) {
      const incomingSlugs = new Set(items.map((item) => item.slug));
      state.categories = state.categories.filter((category) => (
        incomingSlugs.has(category.slug)
        || (category.slug !== 'buffer' && category.isSystem === true)
      ));

      const bySlug = new Map(state.categories.map((category) => [category.slug, category]));
      for (const item of items) {
        const existing = bySlug.get(item.slug);
        if (existing) {
          Object.assign(existing, item);
          continue;
        }

        state.categories.push({
          id: `cat_${item.slug}`,
          isSystem: false,
          ...item,
        });
      }
      return tx.listAllocationCategories();
    },
  };

  return {
    state,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

function defaultCategories() {
  return [
    { id: 'cat_savings', slug: 'savings', label: 'Savings', allocationPercent: '0.1000', sortOrder: 1, isSystem: true, isActive: true, isBuffer: false },
    { id: 'cat_bills', slug: 'fixed_bills', label: 'Fixed Bills', allocationPercent: '0.3000', sortOrder: 2, isSystem: true, isActive: true, isBuffer: false },
    { id: 'cat_spending', slug: 'personal_spending', label: 'Personal Spending', allocationPercent: '0.1500', sortOrder: 3, isSystem: true, isActive: true, isBuffer: false },
    { id: 'cat_investment', slug: 'investment', label: 'Investment', allocationPercent: '0.1000', sortOrder: 4, isSystem: false, isActive: true, isBuffer: false },
    { id: 'cat_debt', slug: 'debt_payoff', label: 'Debt Payoff', allocationPercent: '0.1000', sortOrder: 5, isSystem: false, isActive: true, isBuffer: false },
    { id: 'cat_partnership', slug: 'partnership', label: 'Partnership', allocationPercent: '0.1500', sortOrder: 6, isSystem: false, isActive: true, isBuffer: false },
    { id: 'cat_buffer', slug: 'buffer', label: 'Buffer', allocationPercent: '0.1000', sortOrder: 9, isSystem: true, isActive: true, isBuffer: true },
  ];
}

test('listHouseholdAllocationCategories returns formatted category rows', async () => {
  const db = createDbDouble(defaultCategories());

  const result = await listHouseholdAllocationCategories({
    db,
    householdId: 'household_1',
  });

  assert.equal(result.items.length, 7);
  assert.deepEqual(result.items[0], {
    id: 'cat_savings',
    name: 'Savings',
    label: 'Savings',
    slug: 'savings',
    percent: '0.1000',
    allocationPercent: '0.1000',
    isActive: true,
    active: true,
    sortOrder: 1,
    isSystem: true,
    isBuffer: false,
  });
});

test('replaceHouseholdAllocationCategories saves successfully with buffer as a normal category', async () => {
  const db = createDbDouble(defaultCategories());

  const result = await replaceHouseholdAllocationCategories({
    db,
    householdId: 'household_1',
    input: {
      items: [
        { slug: 'savings', label: 'Reserve', allocationPercent: '0.1500', sortOrder: 1, isActive: true },
        { slug: 'fixed_bills', label: 'Fixed Bills', allocationPercent: '0.2500', sortOrder: 2, isActive: true },
        { slug: 'personal_spending', label: 'Daily Spending', allocationPercent: '0.1500', sortOrder: 3, isActive: true },
        { slug: 'investment', label: 'Investing', allocationPercent: '0.1000', sortOrder: 4, isActive: true },
        { slug: 'debt_payoff', label: 'Debt Payoff', allocationPercent: '0.1000', sortOrder: 5, isActive: true },
        { slug: 'buffer', label: 'Operating Buffer', allocationPercent: '0.2500', sortOrder: 6, isActive: true },
      ],
    },
  });

  assert.equal(result.items.find((item) => item.slug === 'buffer').isBuffer, true);
  assert.equal(result.items.find((item) => item.slug === 'buffer').label, 'Operating Buffer');
  assert.equal(result.items.find((item) => item.slug === 'savings').label, 'Reserve');
});

test('replaceHouseholdAllocationCategories saves successfully without a buffer category', async () => {
  const db = createDbDouble(defaultCategories().filter((category) => category.slug !== 'buffer'));

  const result = await replaceHouseholdAllocationCategories({
    db,
    householdId: 'household_1',
    input: {
      items: [
        { slug: 'savings', label: 'Savings', allocationPercent: '0.2000', sortOrder: 1, isActive: true },
        { slug: 'fixed_bills', label: 'Fixed Bills', allocationPercent: '0.3500', sortOrder: 2, isActive: true },
        { slug: 'personal_spending', label: 'Personal Spending', allocationPercent: '0.1500', sortOrder: 3, isActive: true },
        { slug: 'investment', label: 'Investment', allocationPercent: '0.1500', sortOrder: 4, isActive: true },
        { slug: 'debt_payoff', label: 'Debt Payoff', allocationPercent: '0.1500', sortOrder: 5, isActive: true },
      ],
    },
  });

  assert.equal(result.items.some((item) => item.slug === 'buffer'), false);
  assert.equal(result.items.length, 5);
});

test('replaceHouseholdAllocationCategories allows adding a new non-system category', async () => {
  const db = createDbDouble(defaultCategories());

  const result = await replaceHouseholdAllocationCategories({
    db,
    householdId: 'household_1',
    input: {
      items: [
        { slug: 'savings', label: 'Savings', allocationPercent: '0.1000', sortOrder: 1, isActive: true },
        { slug: 'fixed_bills', label: 'Fixed Bills', allocationPercent: '0.3000', sortOrder: 2, isActive: true },
        { slug: 'personal_spending', label: 'Personal Spending', allocationPercent: '0.1500', sortOrder: 3, isActive: true },
        { slug: 'investment', label: 'Investment', allocationPercent: '0.0500', sortOrder: 4, isActive: true },
        { slug: 'debt_payoff', label: 'Debt Payoff', allocationPercent: '0.1000', sortOrder: 5, isActive: true },
        { slug: 'travel', label: 'Travel Fund', allocationPercent: '0.0500', sortOrder: 6, isActive: true },
        { slug: 'buffer', label: 'Buffer', allocationPercent: '0.2500', sortOrder: 9, isActive: true },
      ],
    },
  });

  assert.equal(result.items.some((item) => item.slug === 'travel'), true);
  assert.equal(result.items.find((item) => item.slug === 'travel').label, 'Travel Fund');
  assert.equal(db.state.categories.some((item) => item.slug === 'travel'), true);
});

test('replaceHouseholdAllocationCategories rejects invalid active percentage totals', async () => {
  const db = createDbDouble(defaultCategories());

  await assert.rejects(
    () => replaceHouseholdAllocationCategories({
      db,
      householdId: 'household_1',
      input: {
        items: defaultCategories().map((category) => ({
          slug: category.slug,
          label: category.label,
          allocationPercent: category.slug === 'buffer' ? '0.2000' : category.allocationPercent,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
        })),
      },
    }),
    /must sum to 1\.0000/,
  );
});

test('computeDepositAllocations routes remainder to buffer when present', () => {
  const result = computeDepositAllocations('100.01', [
    { id: 'cat_a', slug: 'primary', allocationPercent: '0.5000', sortOrder: 1, isActive: true },
    { id: 'cat_b', slug: 'buffer', allocationPercent: '0.5000', sortOrder: 2, isActive: true },
  ]);

  assert.deepEqual(result, [
    { categoryId: 'cat_a', slug: 'primary', allocationPercent: '0.5000', allocatedAmount: '50.00' },
    { categoryId: 'cat_b', slug: 'buffer', allocationPercent: '0.5000', allocatedAmount: '50.01' },
  ]);
});

test('computeDepositAllocations routes remainder to the largest category when buffer is absent', () => {
  const result = computeDepositAllocations('100.01', [
    { id: 'cat_a', slug: 'fixed_bills', allocationPercent: '0.5000', sortOrder: 2, isActive: true },
    { id: 'cat_b', slug: 'savings', allocationPercent: '0.3000', sortOrder: 1, isActive: true },
    { id: 'cat_c', slug: 'debt_payoff', allocationPercent: '0.2000', sortOrder: 3, isActive: true },
  ]);

  assert.deepEqual(result, [
    { categoryId: 'cat_b', slug: 'savings', allocationPercent: '0.3000', allocatedAmount: '30.00' },
    { categoryId: 'cat_a', slug: 'fixed_bills', allocationPercent: '0.5000', allocatedAmount: '50.01' },
    { categoryId: 'cat_c', slug: 'debt_payoff', allocationPercent: '0.2000', allocatedAmount: '20.00' },
  ]);
});

test('computeDepositAllocations uses deterministic tie-breaking when buffer is absent', () => {
  const result = computeDepositAllocations('100.01', [
    { id: 'cat_b', slug: 'travel', allocationPercent: '0.5000', sortOrder: 2, isActive: true },
    { id: 'cat_a', slug: 'savings', allocationPercent: '0.5000', sortOrder: 1, isActive: true },
  ]);

  assert.deepEqual(result, [
    { categoryId: 'cat_a', slug: 'savings', allocationPercent: '0.5000', allocatedAmount: '50.01' },
    { categoryId: 'cat_b', slug: 'travel', allocationPercent: '0.5000', allocatedAmount: '50.00' },
  ]);
});

test('household allocation category routes expose GET and PUT payloads', async () => {
  const db = createDbDouble(defaultCategories());

  const getResponse = await GET(
    new Request('http://localhost/api/v1/household/allocation-categories', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );

  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).items.length, 7);

  const putResponse = await PUT(
    new Request('http://localhost/api/v1/household/allocation-categories', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        items: defaultCategories().map((category) => ({
          slug: category.slug,
          label: category.label,
          allocationPercent: category.allocationPercent,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
        })),
      }),
    }),
    { db },
  );

  assert.equal(putResponse.status, 200);
  assert.equal(Array.isArray((await putResponse.json()).items), true);
});

test('GET /household/allocation-categories returns the historical snapshot for asOf dates', async () => {
  const db = createInMemoryDb();

  await replaceHouseholdAllocationCategories({
    db,
    householdId: db.defaultHouseholdId,
    effectiveDate: '2026-03-01',
    input: {
      items: [
        { slug: 'savings', label: 'Savings', allocationPercent: '0.2000', sortOrder: 1, isActive: true },
        { slug: 'fixed_bills', label: 'Fixed Bills', allocationPercent: '0.2500', sortOrder: 2, isActive: true },
        { slug: 'personal_spending', label: 'Personal Spending', allocationPercent: '0.1500', sortOrder: 3, isActive: true },
        { slug: 'investment', label: 'Investment', allocationPercent: '0.0500', sortOrder: 4, isActive: true },
        { slug: 'debt_payoff', label: 'Debt Payoff', allocationPercent: '0.1000', sortOrder: 5, isActive: true },
        { slug: 'buffer', label: 'Buffer', allocationPercent: '0.2500', sortOrder: 9, isActive: true },
      ],
    },
  });

  const currentResponse = await GET(
    new Request('http://localhost/api/v1/household/allocation-categories', {
      headers: { 'x-household-id': db.defaultHouseholdId },
    }),
    { db },
  );
  const historicalResponse = await GET(
    new Request('http://localhost/api/v1/household/allocation-categories?asOf=2026-02-15', {
      headers: { 'x-household-id': db.defaultHouseholdId },
    }),
    { db },
  );

  const current = await currentResponse.json();
  const historical = await historicalResponse.json();

  assert.equal(current.items.find((item) => item.slug === 'savings').allocationPercent, '0.2000');
  assert.equal(historical.items.find((item) => item.slug === 'savings').allocationPercent, '0.1000');
  assert.equal(Array.isArray(current.history), true);
});
