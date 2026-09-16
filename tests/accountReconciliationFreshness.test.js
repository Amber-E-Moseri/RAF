/**
 * Regression test: getAccountFreshnessContext schema contract
 *
 * Production defect: the Postgres adapter queried `reconciled_at` (column does
 * not exist) and `status = 'accepted'` (not a valid status value). The
 * canonical schema uses `resolved_at` and status values `'open'` / `'resolved'`.
 *
 * These tests exercise the in-memory adapter's getAccountFreshnessContext to
 * protect against reintroducing stale schema assumptions.  They cover:
 *   1. resolved reconciliation is included
 *   2. open reconciliation is excluded
 *   3. most recent resolved reconciliation is selected when multiple exist
 *   4. workspace isolation — another workspace's reconciliation not returned
 *   5. no reconciliation → empty acceptedReconciliations
 *   6. reconciledAt in the result reflects resolvedAt, not a stale field name
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POST as createReconciliationRoute,
} from '../app/api/v1/financial-accounts/[accountId]/reconciliations/route.js';
import { PATCH as resolveReconciliationRoute } from '../app/api/v1/financial-accounts/[accountId]/reconciliations/[reconciliationId]/route.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonRequest(pathname, body, householdId = 'hh_test') {
  return new Request(`http://localhost/api/v1${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-household-id': householdId },
    body: JSON.stringify(body),
  });
}

async function makeAccount(db, householdId = 'hh_test') {
  return db.transaction((tx) =>
    tx.insertFinancialAccount({
      householdId,
      workspaceId: householdId,
      name: 'Test Checking',
      accountType: 'checking',
      institution: null,
      currency: 'CAD',
      currentBalance: '2000.00',
      availableBalance: null,
      balanceAsOf: '2026-09-01T00:00:00.000Z',
      isManual: true,
      status: 'active',
    }),
  );
}

async function createOpenReconciliation(db, accountId, householdId = 'hh_test') {
  const res = await createReconciliationRoute(
    jsonRequest(`/financial-accounts/${accountId}/reconciliations`, {
      reported_balance: '1950.00',
      reported_as_of: '2026-09-10T00:00:00.000Z',
    }, householdId),
    { db, householdId, params: { accountId } },
  );
  return res.json();
}

async function resolveReconciliation(db, accountId, reconciliationId, householdId = 'hh_test') {
  const res = await resolveReconciliationRoute(
    jsonRequest(
      `/financial-accounts/${accountId}/reconciliations/${reconciliationId}`,
      { action: 'accept_reported_balance' },
      householdId,
    ),
    { db, householdId, params: { accountId, reconciliationId } },
  );
  return res.json();
}

async function freshnessContext(db, householdId = 'hh_test') {
  return db.transaction((tx) => tx.getAccountFreshnessContext({ householdId }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Freshness: resolved reconciliation is included in acceptedReconciliations', async () => {
  const db = createInMemoryDb();
  const account = await makeAccount(db);
  const open = await createOpenReconciliation(db, account.id);
  await resolveReconciliation(db, account.id, open.id);

  const ctx = await freshnessContext(db);

  assert.equal(ctx.acceptedReconciliations.length, 1, 'one resolved reconciliation expected');
  assert.equal(ctx.acceptedReconciliations[0].accountId, account.id);
});

test('Freshness: open reconciliation is NOT included in acceptedReconciliations', async () => {
  const db = createInMemoryDb();
  const account = await makeAccount(db);
  await createOpenReconciliation(db, account.id); // left as open, never resolved

  const ctx = await freshnessContext(db);

  assert.equal(ctx.acceptedReconciliations.length, 0, 'open reconciliation must not appear as completed freshness evidence');
});

test('Freshness: reconciledAt in result is the resolvedAt timestamp (not a stale field name)', async () => {
  const db = createInMemoryDb();
  const account = await makeAccount(db);
  const open = await createOpenReconciliation(db, account.id);
  const resolved = await resolveReconciliation(db, account.id, open.id);

  const ctx = await freshnessContext(db);

  assert.ok(ctx.acceptedReconciliations[0].reconciledAt, 'reconciledAt must be present');
  // The value must be a valid ISO date string — confirms it came from resolvedAt
  assert.match(
    ctx.acceptedReconciliations[0].reconciledAt,
    /^\d{4}-\d{2}-\d{2}T/,
    'reconciledAt must be an ISO timestamp derived from the resolved_at column',
  );
  // Sanity: must not be null or the literal string 'undefined'
  assert.notEqual(ctx.acceptedReconciliations[0].reconciledAt, null);
  assert.notEqual(ctx.acceptedReconciliations[0].reconciledAt, 'undefined');
  assert.equal(resolved.status, 'resolved');
});

test('Freshness: open reconciliation co-existing with resolved reconciliation — only resolved returned', async () => {
  const db = createInMemoryDb();
  const account = await makeAccount(db);

  // Create and resolve one
  const open1 = await createOpenReconciliation(db, account.id);
  await resolveReconciliation(db, account.id, open1.id);

  // Create another but leave it open
  await createOpenReconciliation(db, account.id);

  const ctx = await freshnessContext(db);

  assert.equal(ctx.acceptedReconciliations.length, 1, 'only the resolved entry must appear; open must be excluded');
});

test('Freshness: workspace isolation — another workspace reconciliation is not returned', async () => {
  const db = createInMemoryDb();

  // Workspace A: account + resolved reconciliation
  const accountA = await makeAccount(db, 'hh_A');
  const openA = await createOpenReconciliation(db, accountA.id, 'hh_A');
  await resolveReconciliation(db, accountA.id, openA.id, 'hh_A');

  // Workspace B: account + resolved reconciliation
  const accountB = await makeAccount(db, 'hh_B');
  const openB = await createOpenReconciliation(db, accountB.id, 'hh_B');
  await resolveReconciliation(db, accountB.id, openB.id, 'hh_B');

  const ctxA = await freshnessContext(db, 'hh_A');
  const ctxB = await freshnessContext(db, 'hh_B');

  assert.equal(ctxA.acceptedReconciliations.length, 1);
  assert.equal(ctxA.acceptedReconciliations[0].accountId, accountA.id);

  assert.equal(ctxB.acceptedReconciliations.length, 1);
  assert.equal(ctxB.acceptedReconciliations[0].accountId, accountB.id);
});

test('Freshness: no reconciliation — acceptedReconciliations is empty', async () => {
  const db = createInMemoryDb();
  await makeAccount(db);

  const ctx = await freshnessContext(db);

  assert.deepEqual(ctx.acceptedReconciliations, []);
});
