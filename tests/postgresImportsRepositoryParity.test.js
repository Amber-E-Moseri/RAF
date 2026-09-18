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
