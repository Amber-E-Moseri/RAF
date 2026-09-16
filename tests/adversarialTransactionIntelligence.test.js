import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { extractMerchantKey } from '../lib/imports/merchantNormalization.js';
import { matchMerchantRule, createMerchantRule } from '../lib/imports/merchantRules.js';
import { getTransactionSuggestion } from '../lib/transactions/transactionSuggestion.js';

const HOUSEHOLD_A = 'household_p5_intel_a';
const HOUSEHOLD_B = 'household_p5_intel_b';

async function insertTx(db, householdId, fields = {}) {
  return db.transaction(async (tx) => {
    const row = await tx.insertTransaction({
      householdId,
      transactionDate: fields.date ?? '2026-01-15',
      description: fields.description ?? 'Test Purchase',
      merchant: fields.merchant ?? null,
      amount: fields.amount ?? '50.00',
      direction: fields.direction ?? 'debit',
      categoryId: fields.categoryId ?? null,
      source: 'manual',
    });
    return row;
  });
}

async function insertRule(db, householdId, payload) {
  return db.transaction(async (tx) => {
    return tx.upsertImportReviewRule({
      householdId,
      classificationType: payload.classificationType ?? 'transaction',
      categoryId: payload.categoryId ?? null,
      normalizedDescription: payload.normalizedDescription ?? null,
      matchValue: payload.matchValue ?? payload.normalizedDescription ?? null,
      matchType: payload.matchType ?? 'contains',
      ruleType: payload.ruleType ?? 'suggestion',
      autoApply: payload.autoApply ?? false,
    });
  });
}

// ─── Section 1: Merchant Normalization ───────────────────────────────────────

test('1.1 — extractMerchantKey strips PayPal prefix', () => {
  const key = extractMerchantKey('PAYPAL * AMAZON');
  assert.strictEqual(key, 'amazon', 'Payment processor prefix stripped');
});

test('1.2 — extractMerchantKey strips Square (SQ) prefix', () => {
  const key = extractMerchantKey('SQ * Blue Bottle Coffee');
  assert.strictEqual(key, 'blue bottle coffee', 'SQ prefix stripped');
});

test('1.3 — extractMerchantKey strips trailing store number (#1234)', () => {
  const key = extractMerchantKey('Walmart #1234');
  assert.strictEqual(key, 'walmart', 'Trailing store number stripped');
});

test('1.4 — extractMerchantKey strips trailing TLD (.com)', () => {
  const key = extractMerchantKey('netflix.com');
  assert.strictEqual(key, 'netflix', 'Trailing TLD stripped');
});

test('1.5 — extractMerchantKey returns null for empty input', () => {
  const key = extractMerchantKey('');
  assert.strictEqual(key, null, 'Empty input returns null');
});

test('1.6 — extractMerchantKey strips trailing long digit code', () => {
  const key = extractMerchantKey('Shopify 12345678');
  assert.strictEqual(key, 'shopify', 'Trailing long digit code stripped');
});

// ─── Section 2: Merchant Rule Matching ───────────────────────────────────────

test('2.1 — matchMerchantRule: exact match returns the matching rule', () => {
  const rules = [
    { id: 'r1', matchType: 'exact', matchValue: 'starbucks', categoryId: 'cat_coffee', priority: 1, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const match = matchMerchantRule(rules, 'Starbucks');
  assert.ok(match, 'Rule found');
  assert.strictEqual(match.categoryId, 'cat_coffee');
});

test('2.2 — matchMerchantRule: contains match (default) finds partial merchant name', () => {
  const rules = [
    { id: 'r1', matchType: 'contains', matchValue: 'grocery', categoryId: 'cat_food', priority: 1, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const match = matchMerchantRule(rules, 'Metro Grocery Store');
  assert.ok(match, 'Contains rule matched');
  assert.strictEqual(match.categoryId, 'cat_food');
});

test('2.3 — matchMerchantRule: higher priority rule wins over lower', () => {
  const rules = [
    { id: 'r1', matchType: 'contains', matchValue: 'amazon', categoryId: 'cat_shopping', priority: 1, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'r2', matchType: 'contains', matchValue: 'amazon', categoryId: 'cat_streaming', priority: 5, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const match = matchMerchantRule(rules, 'Amazon Prime');
  assert.strictEqual(match.categoryId, 'cat_streaming', 'Higher priority rule wins');
});

test('2.4 — matchMerchantRule: disabled rule is not matched', () => {
  const rules = [
    { id: 'r1', matchType: 'contains', matchValue: 'netflix', categoryId: 'cat_streaming', priority: 1, enabled: false, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const match = matchMerchantRule(rules, 'Netflix');
  assert.strictEqual(match, null, 'Disabled rule should not match');
});

test('2.5 — matchMerchantRule: starts_with match works', () => {
  const rules = [
    { id: 'r1', matchType: 'starts_with', matchValue: 'uber', categoryId: 'cat_transport', priority: 1, enabled: true, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const match = matchMerchantRule(rules, 'Uber Eats');
  assert.ok(match, 'starts_with matched');
  assert.strictEqual(match.categoryId, 'cat_transport');
});

// ─── Section 3: Suggestion Recall ────────────────────────────────────────────

test('3.1 — getTransactionSuggestion returns matching importReviewRule by description', async () => {
  const db = createInMemoryDb();

  // Create a rule for 'grocery store'
  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'grocery store',
    matchValue: 'grocery store',
    categoryId: 'cat_food',
    classificationType: 'transaction',
  });

  // Create an authoritative transaction with matching description
  const tx = await insertTx(db, HOUSEHOLD_A, {
    description: 'Grocery Store',
    merchant: null,
  });

  const result = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_A, transactionId: tx.id });
  assert.ok(result.suggestion, 'Suggestion returned');
  assert.strictEqual(result.suggestion.category_id, 'cat_food', 'Suggestion category matches rule');
});

test('3.2 — getTransactionSuggestion returns suggestion via merchant field (rawDescription fallback)', async () => {
  const db = createInMemoryDb();

  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'costco',
    matchValue: 'costco',
    categoryId: 'cat_groceries',
    classificationType: 'transaction',
  });

  // Transaction has merchant field that normalizes to contain 'costco'
  const tx = await insertTx(db, HOUSEHOLD_A, {
    description: 'POS Purchase XXXX',
    merchant: 'Costco Wholesale',
  });

  const result = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_A, transactionId: tx.id });
  assert.ok(result.suggestion, 'Suggestion found via merchant field');
  assert.strictEqual(result.suggestion.category_id, 'cat_groceries');
});

test('3.3 — getTransactionSuggestion returns null suggestion when no rule matches', async () => {
  const db = createInMemoryDb();

  const tx = await insertTx(db, HOUSEHOLD_A, {
    description: 'Obscure Merchant No Rule',
  });

  const result = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_A, transactionId: tx.id });
  assert.strictEqual(result.suggestion, null, 'No matching rule → suggestion is null');
});

test('3.4 — getTransactionSuggestion is READ-ONLY: does not mutate transaction fields', async () => {
  const db = createInMemoryDb();

  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'restaurant',
    matchValue: 'restaurant',
    categoryId: 'cat_dining',
    classificationType: 'transaction',
  });

  const tx = await insertTx(db, HOUSEHOLD_A, {
    description: 'Fine Restaurant',
    categoryId: null,
  });

  await getTransactionSuggestion({ db, householdId: HOUSEHOLD_A, transactionId: tx.id });

  // Verify transaction category was NOT changed by the suggestion lookup
  const unchanged = await db.transaction(async (dbTx) =>
    dbTx.getTransactionById({ householdId: HOUSEHOLD_A, transactionId: tx.id }),
  );
  assert.strictEqual(unchanged.categoryId, null, 'Suggestion fetch must not mutate categoryId — advisory only');
});

// ─── Section 4: Tenant Isolation ─────────────────────────────────────────────

test('4.1 — Suggestion rules from household A not returned for household B', async () => {
  const db = createInMemoryDb();

  // Create rule only for household A
  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'pharmacy',
    matchValue: 'pharmacy',
    categoryId: 'cat_health',
    classificationType: 'transaction',
  });

  // Household B transaction with same description
  const txB = await insertTx(db, HOUSEHOLD_B, {
    description: 'Pharmacy Purchase',
  });

  const result = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_B, transactionId: txB.id });
  assert.strictEqual(
    result.suggestion,
    null,
    'SECURITY_DEFECT: household A suggestion rule must not be returned for household B',
  );
});

test('4.2 — Cross-tenant collision: same merchant, different categories per tenant', async () => {
  const db = createInMemoryDb();

  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'amazon',
    matchValue: 'amazon',
    categoryId: 'cat_shopping_a',
    classificationType: 'transaction',
  });

  await insertRule(db, HOUSEHOLD_B, {
    normalizedDescription: 'amazon',
    matchValue: 'amazon',
    categoryId: 'cat_shopping_b',
    classificationType: 'transaction',
  });

  const txA = await insertTx(db, HOUSEHOLD_A, { description: 'Amazon Order' });
  const txB = await insertTx(db, HOUSEHOLD_B, { description: 'Amazon Order' });

  const resultA = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_A, transactionId: txA.id });
  const resultB = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_B, transactionId: txB.id });

  assert.strictEqual(resultA.suggestion?.category_id, 'cat_shopping_a', 'Household A gets its own rule');
  assert.strictEqual(resultB.suggestion?.category_id, 'cat_shopping_b', 'Household B gets its own rule — no cross-tenant bleed');
});

// ─── Section 5: Auto-Apply and Correction Counting ───────────────────────────

test('5.1 — Rule with autoApply=true returns suggestion.auto_apply=true', async () => {
  const db = createInMemoryDb();

  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'netflix',
    matchValue: 'netflix',
    categoryId: 'cat_streaming',
    classificationType: 'transaction',
    autoApply: true,
  });

  const tx = await insertTx(db, HOUSEHOLD_A, { description: 'Netflix Monthly' });
  const result = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_A, transactionId: tx.id });

  assert.strictEqual(result.suggestion?.auto_apply, true, 'auto_apply flag propagated from rule');
});

test('5.2 — upsertImportReviewRule increments confirmationCount on same-category re-use', async () => {
  const db = createInMemoryDb();

  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'coffee shop',
    matchValue: 'coffee shop',
    categoryId: 'cat_coffee',
    classificationType: 'transaction',
  });
  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'coffee shop',
    matchValue: 'coffee shop',
    categoryId: 'cat_coffee',
    classificationType: 'transaction',
  });

  const rules = await db.transaction(async (tx) => tx.listImportReviewRules({ householdId: HOUSEHOLD_A }));
  assert.strictEqual(rules.length, 1, 'Upsert does not create a duplicate rule');
  assert.strictEqual(rules[0].confirmationCount, 2, 'confirmationCount incremented on re-use');
});

test('5.3 — upsertImportReviewRule increments correctionCount when category changes', async () => {
  const db = createInMemoryDb();

  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'uber',
    matchValue: 'uber',
    categoryId: 'cat_transport',
    classificationType: 'transaction',
  });
  // User changes their mind: same merchant, different category
  await insertRule(db, HOUSEHOLD_A, {
    normalizedDescription: 'uber',
    matchValue: 'uber',
    categoryId: 'cat_food_delivery',
    classificationType: 'transaction',
  });

  const rules = await db.transaction(async (tx) => tx.listImportReviewRules({ householdId: HOUSEHOLD_A }));
  assert.strictEqual(rules.length, 1, 'Still one rule');
  assert.ok(rules[0].correctionCount >= 1, 'correctionCount incremented when category changed');
  assert.strictEqual(rules[0].categoryId, 'cat_food_delivery', 'Rule updated to new category');
});

// ─── Section 6: Suggestion Boundary ──────────────────────────────────────────

test('6.1 — getTransactionSuggestion throws 404 for non-existent transaction', async () => {
  const db = createInMemoryDb();

  const err = await getTransactionSuggestion({
    db,
    householdId: HOUSEHOLD_A,
    transactionId: 'tx_nonexistent',
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Non-existent transaction must throw');
  assert.match(String(err.status ?? err.message), /404|not found/i, '404 for missing transaction');
});

test('6.2 — getTransactionSuggestion returns no suggestion for cross-tenant transaction', async () => {
  const db = createInMemoryDb();

  // Insert transaction in household A
  const txA = await insertTx(db, HOUSEHOLD_A, { description: 'Private Purchase' });

  // Household B tries to get suggestion for household A's transaction
  const err = await getTransactionSuggestion({
    db,
    householdId: HOUSEHOLD_B,
    transactionId: txA.id,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Cross-tenant transaction access must throw — SECURITY_DEFECT if succeeds');
});
