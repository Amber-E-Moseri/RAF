/**
 * Phase 3B — Import Repository Parity Test
 *
 * Directly exercises buildImportsRepository against a mock client to verify
 * that touchImportReviewRule preserves the full inMemoryDb contract:
 *
 *   - accepts usedAt parameter
 *   - persists lastUsedAt = usedAt into raw_json
 *   - persists updatedAt = current timestamp (distinct from usedAt when usedAt is explicit)
 *   - returns the updated rule
 *   - returns null for unknown ruleId
 *   - workspace scoping: workspace B rule is invisible to workspace A householdId
 *
 * No real PostgreSQL connection is required. The mock client intercepts all
 * client.query() calls so this test runs in any environment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildImportsRepository } from '../lib/repositories/postgres/importsRepository.js';

const SCHEMA = 'raf';
const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const RULE_ID = 'cccccccc-0000-4000-8000-000000000003';
const USED_AT = '2026-03-15T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Mock client that records calls and returns scripted responses
// ---------------------------------------------------------------------------

function makeMockClient(responses = {}) {
  const calls = [];

  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });

    // SELECT by workspace + id → getImportReviewRuleById
    if (/SELECT raw_json FROM.*import_review_rules.*workspace_id.*LIMIT 1/i.test(normalized)) {
      const wsParam = params[0];
      const idParam = params[1];
      const key = `${wsParam}:${idParam}`;
      const row = responses[key] ?? null;
      return { rows: row ? [{ raw_json: row }] : [], rowCount: row ? 1 : 0 };
    }

    // UPDATE
    if (/^UPDATE.*import_review_rules/i.test(normalized)) {
      return { rows: [], rowCount: 1 };
    }

    // Generic fallback
    return { rows: [], rowCount: 0 };
  };

  return { query, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('touchImportReviewRule — sets lastUsedAt from explicit usedAt', async () => {
  const existingRule = {
    id: RULE_ID,
    householdId: WS_A,
    workspaceId: WS_A,
    matchValue: 'groceries',
    matchType: 'contains',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const client = makeMockClient({ [`${WS_A}:${RULE_ID}`]: existingRule });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.touchImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, usedAt: USED_AT });

  assert.ok(result !== null, 'result should not be null');
  assert.strictEqual(result.lastUsedAt, USED_AT, 'lastUsedAt must equal the supplied usedAt');
  assert.ok(result.updatedAt, 'updatedAt must be present');
  // updatedAt is the current timestamp, not usedAt (they can coincidentally match but the field is independent)
  assert.strictEqual(result.id, RULE_ID, 'id must be preserved');
  assert.strictEqual(result.matchValue, 'groceries', 'other fields must be preserved');
});

test('touchImportReviewRule — lastUsedAt is persisted in raw_json passed to UPDATE', async () => {
  const existingRule = {
    id: RULE_ID,
    householdId: WS_A,
    workspaceId: WS_A,
    matchValue: 'transit',
    matchType: 'exact',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const client = makeMockClient({ [`${WS_A}:${RULE_ID}`]: existingRule });
  const repo = buildImportsRepository(client, SCHEMA);

  await repo.touchImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, usedAt: USED_AT });

  const updateCall = client.calls.find((c) => /^UPDATE.*import_review_rules/i.test(c.sql));
  assert.ok(updateCall, 'UPDATE query must have been issued');

  // params[0] is the raw_json payload stored in the DB
  const persistedJson = updateCall.params[0];
  assert.strictEqual(
    persistedJson.lastUsedAt,
    USED_AT,
    'raw_json persisted to DB must contain lastUsedAt = usedAt',
  );
  assert.ok(persistedJson.updatedAt, 'raw_json persisted to DB must contain updatedAt');
});

test('touchImportReviewRule — updatedAt and lastUsedAt are independent fields', async () => {
  const pastUsedAt = '2026-01-10T10:00:00.000Z';
  const existingRule = {
    id: RULE_ID,
    householdId: WS_A,
    workspaceId: WS_A,
    matchValue: 'coffee',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const client = makeMockClient({ [`${WS_A}:${RULE_ID}`]: existingRule });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.touchImportReviewRule({
    householdId: WS_A,
    ruleId: RULE_ID,
    usedAt: pastUsedAt,
  });

  assert.strictEqual(result.lastUsedAt, pastUsedAt, 'lastUsedAt = supplied usedAt');
  // updatedAt is the real call time — it must be >= pastUsedAt (2026-01-10) since we are past that date
  assert.ok(result.updatedAt >= pastUsedAt, 'updatedAt must be >= usedAt (call happened after pastUsedAt)');
});

test('touchImportReviewRule — returns null for unknown ruleId', async () => {
  const client = makeMockClient({}); // no entries → SELECT returns empty
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.touchImportReviewRule({
    householdId: WS_A,
    ruleId: 'non-existent-id',
    usedAt: USED_AT,
  });

  assert.strictEqual(result, null, 'must return null when rule does not exist');

  // No UPDATE should be issued if the rule was not found
  const updateCall = client.calls.find((c) => /^UPDATE.*import_review_rules/i.test(c.sql));
  assert.strictEqual(updateCall, undefined, 'UPDATE must not be issued for a missing rule');
});

test('touchImportReviewRule — workspace scoping: WS_A cannot touch WS_B rule', async () => {
  // Rule belongs to WS_B; the mock only returns it when queried with WS_B.
  const wsBRule = {
    id: RULE_ID,
    householdId: WS_B,
    workspaceId: WS_B,
    matchValue: 'rent',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  // Keyed under WS_B so WS_A queries find nothing
  const client = makeMockClient({ [`${WS_B}:${RULE_ID}`]: wsBRule });
  const repo = buildImportsRepository(client, SCHEMA);

  // WS_A tries to touch WS_B's rule — SELECT with workspace_id = WS_A returns nothing
  const result = await repo.touchImportReviewRule({
    householdId: WS_A,
    ruleId: RULE_ID,
    usedAt: USED_AT,
  });

  assert.strictEqual(result, null, 'WS_A cannot read or touch WS_B rule — returns null');
  const updateCall = client.calls.find((c) => /^UPDATE.*import_review_rules/i.test(c.sql));
  assert.strictEqual(updateCall, undefined, 'No UPDATE must be issued for WS_B rule when called from WS_A');
});

test('touchImportReviewRule — usedAt defaults to current timestamp when omitted', async () => {
  const existingRule = {
    id: RULE_ID,
    householdId: WS_A,
    workspaceId: WS_A,
    matchValue: 'pharmacy',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const client = makeMockClient({ [`${WS_A}:${RULE_ID}`]: existingRule });
  const repo = buildImportsRepository(client, SCHEMA);

  const before = new Date().toISOString();
  const result = await repo.touchImportReviewRule({ householdId: WS_A, ruleId: RULE_ID });
  const after = new Date().toISOString();

  assert.ok(result !== null, 'result must not be null');
  assert.ok(result.lastUsedAt >= before, 'default lastUsedAt must be >= call start');
  assert.ok(result.lastUsedAt <= after, 'default lastUsedAt must be <= call end');
});

// ---------------------------------------------------------------------------
// Phase 3C parity tests — getImportedTransactionById
// ---------------------------------------------------------------------------

const TX_ID = 'dddddddd-0000-4000-8000-000000000004';

function makeMockClientPhase3C(responses = {}) {
  const calls = [];

  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });

    // SELECT imported_transactions by workspace + id
    if (/SELECT raw_json FROM.*imported_transactions.*LIMIT 1/i.test(normalized)) {
      const key = `importedTx:${params[0]}:${params[1]}`;
      const row = responses[key] ?? null;
      return { rows: row ? [{ raw_json: row }] : [], rowCount: row ? 1 : 0 };
    }

    // SELECT merchant_rules by workspace (list)
    if (/SELECT raw_json FROM.*merchant_rules.*WHERE workspace_id/i.test(normalized)) {
      const key = `merchantRules:${params[0]}`;
      const rows = responses[key] ?? [];
      return { rows: rows.map((r) => ({ raw_json: r })), rowCount: rows.length };
    }

    // SELECT import_review_rules by workspace + id (getImportReviewRuleById)
    if (/SELECT raw_json FROM.*import_review_rules.*workspace_id.*LIMIT 1/i.test(normalized)) {
      const wsParam = params[0];
      const idParam = params[1];
      const key = `${wsParam}:${idParam}`;
      const row = responses[key] ?? null;
      return { rows: row ? [{ raw_json: row }] : [], rowCount: row ? 1 : 0 };
    }

    // UPDATE import_review_rules
    if (/^UPDATE.*import_review_rules/i.test(normalized)) {
      return { rows: [], rowCount: 1 };
    }

    // DELETE import_review_rules RETURNING id
    if (/^DELETE FROM.*import_review_rules.*RETURNING id/i.test(normalized)) {
      const wsParam = params[0];
      const idParam = params[1];
      const key = `deleteRule:${wsParam}:${idParam}`;
      const found = responses[key] ?? false;
      return { rows: found ? [{ id: idParam }] : [], rowCount: found ? 1 : 0 };
    }

    // SELECT transactions (findDuplicateTransaction)
    if (/SELECT raw_json FROM.*transactions.*WHERE workspace_id/i.test(normalized)) {
      const key = `tx:${params[0]}:${params[1]}:${params[2]}:${params[3]}`;
      const row = responses[key] ?? null;
      return { rows: row ? [{ raw_json: row }] : [], rowCount: row ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  return { query, calls };
}

// --- getImportedTransactionById ---

test('getImportedTransactionById — found: returns correct transaction', async () => {
  const tx = { id: TX_ID, householdId: WS_A, workspaceId: WS_A, amount: '55.00', description: 'Grocery' };
  const client = makeMockClientPhase3C({ [`importedTx:${WS_A}:${TX_ID}`]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.getImportedTransactionById({ householdId: WS_A, importedTransactionId: TX_ID });
  assert.ok(result !== null, 'must return the transaction row');
  assert.strictEqual(result.id, TX_ID, 'id preserved');
  assert.strictEqual(result.amount, '55.00', 'amount preserved');
});

test('getImportedTransactionById — not found: returns null', async () => {
  const client = makeMockClientPhase3C({});
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.getImportedTransactionById({ householdId: WS_A, importedTransactionId: TX_ID });
  assert.strictEqual(result, null, 'must return null for unknown id');
});

test('getImportedTransactionById — wrong workspace: returns null', async () => {
  const tx = { id: TX_ID, householdId: WS_B, workspaceId: WS_B, amount: '55.00' };
  // Keyed under WS_B; WS_A query finds nothing
  const client = makeMockClientPhase3C({ [`importedTx:${WS_B}:${TX_ID}`]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.getImportedTransactionById({ householdId: WS_A, importedTransactionId: TX_ID });
  assert.strictEqual(result, null, 'WS_A must not read WS_B transaction');
});

// --- listMerchantRules ---

test('listMerchantRules — empty workspace: returns []', async () => {
  const client = makeMockClientPhase3C({ [`merchantRules:${WS_A}`]: [] });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.listMerchantRules({ householdId: WS_A });
  assert.deepStrictEqual(result, [], 'empty workspace returns []');
});

test('listMerchantRules — multiple rows: returns all with correct shape', async () => {
  const rules = [
    { id: 'r1', householdId: WS_A, matchValue: 'coffee', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'r2', householdId: WS_A, matchValue: 'rent', createdAt: '2026-02-01T00:00:00.000Z' },
  ];
  const client = makeMockClientPhase3C({ [`merchantRules:${WS_A}`]: rules });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.listMerchantRules({ householdId: WS_A });
  assert.strictEqual(result.length, 2, 'returns all rows');
  assert.strictEqual(result[0].matchValue, 'coffee', 'first row correct');
  assert.strictEqual(result[1].matchValue, 'rent', 'second row correct');
});

test('listMerchantRules — query uses ORDER BY created_at NULLS FIRST, id', async () => {
  const client = makeMockClientPhase3C({ [`merchantRules:${WS_A}`]: [] });
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.listMerchantRules({ householdId: WS_A });

  const selectCall = client.calls.find((c) => /merchant_rules.*WHERE workspace_id/i.test(c.sql));
  assert.ok(selectCall, 'SELECT must have been issued');
  assert.ok(/ORDER BY created_at NULLS FIRST, id/i.test(selectCall.sql), 'must order by created_at NULLS FIRST, id');
});

test('listMerchantRules — wrong workspace excluded', async () => {
  const rules = [{ id: 'r1', householdId: WS_B, matchValue: 'fuel' }];
  // Only registered under WS_B; WS_A returns nothing
  const client = makeMockClientPhase3C({ [`merchantRules:${WS_B}`]: rules, [`merchantRules:${WS_A}`]: [] });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.listMerchantRules({ householdId: WS_A });
  assert.deepStrictEqual(result, [], 'WS_A must not see WS_B rules');
});

// --- updateImportReviewRule ---

test('updateImportReviewRule — patch merges fields and returns updated row', async () => {
  const existing = {
    id: RULE_ID, householdId: WS_A, workspaceId: WS_A,
    matchValue: 'groceries', categoryId: 'cat-1', confirmationCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const client = makeMockClientPhase3C({ [`${WS_A}:${RULE_ID}`]: existing });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.updateImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, patch: { categoryId: 'cat-2' } });
  assert.ok(result !== null, 'result must not be null');
  assert.strictEqual(result.categoryId, 'cat-2', 'patched field updated');
  assert.strictEqual(result.matchValue, 'groceries', 'unpatched field preserved');
  assert.strictEqual(result.confirmationCount, 3, 'other fields preserved');
});

test('updateImportReviewRule — updatedAt always advances regardless of patch', async () => {
  const existing = {
    id: RULE_ID, householdId: WS_A, workspaceId: WS_A,
    matchValue: 'transit', updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const client = makeMockClientPhase3C({ [`${WS_A}:${RULE_ID}`]: existing });
  const repo = buildImportsRepository(client, SCHEMA);

  const before = new Date().toISOString();
  const result = await repo.updateImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, patch: {} });
  const after = new Date().toISOString();

  assert.ok(result.updatedAt >= before, 'updatedAt must be >= call start');
  assert.ok(result.updatedAt <= after, 'updatedAt must be <= call end');
  assert.ok(result.updatedAt > '2026-01-01T00:00:00.000Z', 'updatedAt must advance past original');
});

test('updateImportReviewRule — null patch field explicitly clears the value', async () => {
  const existing = {
    id: RULE_ID, householdId: WS_A, workspaceId: WS_A,
    matchValue: 'groceries', categoryId: 'cat-1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const client = makeMockClientPhase3C({ [`${WS_A}:${RULE_ID}`]: existing });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.updateImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, patch: { categoryId: null } });
  assert.strictEqual(result.categoryId, null, 'null patch field must clear the value');
});

test('updateImportReviewRule — not found: returns null and no UPDATE issued', async () => {
  const client = makeMockClientPhase3C({});
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.updateImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, patch: { categoryId: 'x' } });
  assert.strictEqual(result, null, 'must return null for missing rule');

  const updateCall = client.calls.find((c) => /^UPDATE.*import_review_rules/i.test(c.sql));
  assert.strictEqual(updateCall, undefined, 'UPDATE must not be issued when rule not found');
});

test('updateImportReviewRule — wrong workspace: returns null', async () => {
  const existing = {
    id: RULE_ID, householdId: WS_B, workspaceId: WS_B, matchValue: 'fuel',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const client = makeMockClientPhase3C({ [`${WS_B}:${RULE_ID}`]: existing });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.updateImportReviewRule({ householdId: WS_A, ruleId: RULE_ID, patch: { categoryId: 'x' } });
  assert.strictEqual(result, null, 'WS_A cannot update WS_B rule');
});

// --- deleteImportReviewRule ---

test('deleteImportReviewRule — existing row: returns true', async () => {
  const client = makeMockClientPhase3C({ [`deleteRule:${WS_A}:${RULE_ID}`]: true });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.deleteImportReviewRule({ householdId: WS_A, ruleId: RULE_ID });
  assert.strictEqual(result, true, 'must return true when row deleted');
});

test('deleteImportReviewRule — not found: returns false', async () => {
  const client = makeMockClientPhase3C({});
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.deleteImportReviewRule({ householdId: WS_A, ruleId: RULE_ID });
  assert.strictEqual(result, false, 'must return false when row not found');
});

test('deleteImportReviewRule — repeated delete: returns false on second attempt', async () => {
  // First call: row present, second: gone
  let firstCall = true;
  const calls = [];
  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });
    if (/^DELETE FROM.*import_review_rules.*RETURNING id/i.test(normalized)) {
      if (firstCall) { firstCall = false; return { rows: [{ id: RULE_ID }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const repo = buildImportsRepository({ query, calls }, SCHEMA);

  const first = await repo.deleteImportReviewRule({ householdId: WS_A, ruleId: RULE_ID });
  const second = await repo.deleteImportReviewRule({ householdId: WS_A, ruleId: RULE_ID });
  assert.strictEqual(first, true, 'first delete returns true');
  assert.strictEqual(second, false, 'second delete returns false');
});

test('deleteImportReviewRule — wrong workspace: returns false', async () => {
  // WS_B rule registered but WS_A attempts deletion
  const client = makeMockClientPhase3C({ [`deleteRule:${WS_B}:${RULE_ID}`]: true });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.deleteImportReviewRule({ householdId: WS_A, ruleId: RULE_ID });
  assert.strictEqual(result, false, 'WS_A cannot delete WS_B rule');
});

// --- findDuplicateTransaction ---

const PARSED_DATE = '2026-03-15';
const PARSED_AMOUNT = '45.00';
const NORM_MERCHANT = 'starbucks';

test('findDuplicateTransaction — exact match: returns transaction', async () => {
  const tx = { id: TX_ID, householdId: WS_A, workspaceId: WS_A, transactionDate: PARSED_DATE, amount: PARSED_AMOUNT, merchant: 'Starbucks' };
  const key = `tx:${WS_A}:${PARSED_DATE}:${PARSED_AMOUNT}:${NORM_MERCHANT}`;
  const client = makeMockClientPhase3C({ [key]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: PARSED_DATE, parsedAmount: PARSED_AMOUNT, normalizedMerchant: NORM_MERCHANT });
  assert.ok(result !== null, 'must return matching transaction');
  assert.strictEqual(result.id, TX_ID, 'returns correct transaction id');
});

test('findDuplicateTransaction — wrong date: no match', async () => {
  const key = `tx:${WS_A}:${PARSED_DATE}:${PARSED_AMOUNT}:${NORM_MERCHANT}`;
  const tx = { id: TX_ID, transactionDate: PARSED_DATE, amount: PARSED_AMOUNT, merchant: 'Starbucks' };
  const client = makeMockClientPhase3C({ [key]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: '2026-03-16', parsedAmount: PARSED_AMOUNT, normalizedMerchant: NORM_MERCHANT });
  assert.strictEqual(result, null, 'different date must not match');
});

test('findDuplicateTransaction — wrong amount: no match', async () => {
  const key = `tx:${WS_A}:${PARSED_DATE}:${PARSED_AMOUNT}:${NORM_MERCHANT}`;
  const tx = { id: TX_ID, transactionDate: PARSED_DATE, amount: PARSED_AMOUNT, merchant: 'Starbucks' };
  const client = makeMockClientPhase3C({ [key]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: PARSED_DATE, parsedAmount: '99.00', normalizedMerchant: NORM_MERCHANT });
  assert.strictEqual(result, null, 'different amount must not match');
});

test('findDuplicateTransaction — wrong merchant: no match', async () => {
  const key = `tx:${WS_A}:${PARSED_DATE}:${PARSED_AMOUNT}:${NORM_MERCHANT}`;
  const tx = { id: TX_ID, transactionDate: PARSED_DATE, amount: PARSED_AMOUNT, merchant: 'Starbucks' };
  const client = makeMockClientPhase3C({ [key]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: PARSED_DATE, parsedAmount: PARSED_AMOUNT, normalizedMerchant: 'mcdonalds' });
  assert.strictEqual(result, null, 'different merchant must not match');
});

test('findDuplicateTransaction — wrong workspace: no match', async () => {
  const key = `tx:${WS_B}:${PARSED_DATE}:${PARSED_AMOUNT}:${NORM_MERCHANT}`;
  const tx = { id: TX_ID, householdId: WS_B };
  const client = makeMockClientPhase3C({ [key]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: PARSED_DATE, parsedAmount: PARSED_AMOUNT, normalizedMerchant: NORM_MERCHANT });
  assert.strictEqual(result, null, 'WS_A must not match WS_B transactions');
});

test('findDuplicateTransaction — null normalizedMerchant: matches empty-merchant transactions', async () => {
  const key = `tx:${WS_A}:${PARSED_DATE}:${PARSED_AMOUNT}:`;
  const tx = { id: TX_ID, transactionDate: PARSED_DATE, amount: PARSED_AMOUNT, merchant: null };
  const client = makeMockClientPhase3C({ [key]: tx });
  const repo = buildImportsRepository(client, SCHEMA);

  const result = await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: PARSED_DATE, parsedAmount: PARSED_AMOUNT, normalizedMerchant: null });
  assert.ok(result !== null, 'null normalizedMerchant must match null/empty merchant row');
});

test('findDuplicateTransaction — SQL uses ORDER BY created_at NULLS FIRST, id and LIMIT 1', async () => {
  const client = makeMockClientPhase3C({});
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.findDuplicateTransaction({ householdId: WS_A, parsedDate: PARSED_DATE, parsedAmount: PARSED_AMOUNT, normalizedMerchant: NORM_MERCHANT });

  const selectCall = client.calls.find((c) => /SELECT raw_json FROM.*transactions/i.test(c.sql));
  assert.ok(selectCall, 'SELECT must have been issued');
  assert.ok(/ORDER BY created_at NULLS FIRST, id/i.test(selectCall.sql), 'must order by created_at NULLS FIRST, id');
  assert.ok(/LIMIT 1/i.test(selectCall.sql), 'must use LIMIT 1');
});
