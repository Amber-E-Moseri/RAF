/**
 * Remi entitlement through the REAL Postgres adapter (raf_app role, RLS active).
 *
 * Regression proof that entitlement works end to end in production wiring:
 *   - membership is resolved with the adapter's real getWorkspaceMember (active only)
 *   - raf.workspaces.remi_tier (the authoritative column) is what getWorkspace reports
 * Gated like the other Postgres tests: DATABASE_URL (owner) + POSTGRES_CONNECTION_STRING_APP
 * (raf_app), local or RAF_CONFIRM_NON_PRODUCTION_DB=true.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { Pool } from 'pg';

import { ensureUserOnboarded } from '../lib/auth/onboarding.js';
import { getRemiEntitlementForRequest } from '../lib/entitlement/remiEntitlement.js';
import { createPostgresDb } from '../lib/server/postgresDb.js';

const adminUrl = process.env.DATABASE_URL;
const appUrl = process.env.POSTGRES_CONNECTION_STRING_APP;
const isLocal = (url) => /@(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url ?? '');
const shouldRun = Boolean(adminUrl && appUrl)
  && ((isLocal(adminUrl) && isLocal(appUrl)) || process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true');
const maybeTest = shouldRun ? test : test.skip;

const adminDb = shouldRun ? createPostgresDb({ connectionString: adminUrl, ssl: false }) : null;
const appDb = shouldRun ? createPostgresDb({ connectionString: appUrl, ssl: false }) : null;
const adminPool = shouldRun ? new Pool({ connectionString: adminUrl, max: 2 }) : null;
const createdWorkspaceIds = [];

after(async () => {
  if (!shouldRun) return;
  if (createdWorkspaceIds.length > 0) {
    await adminPool.query('DELETE FROM raf.workspaces WHERE id = ANY($1::uuid[])', [createdWorkspaceIds]);
  }
  await adminPool.end();
});

async function makeWorkspace(label, tier) {
  const user = { id: crypto.randomUUID(), email: `${label}-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db: adminDb, user, workspaceName: label });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  createdWorkspaceIds.push(workspaceId);
  await adminPool.query('UPDATE raf.workspaces SET remi_tier = $2 WHERE id = $1', [workspaceId, tier]);
  // Same shape the router hands to routes: every transaction carries the trusted context.
  const ctxDb = (userId = user.id) => ({
    transaction: (callback) => appDb.transaction(callback, { userId, workspaceId }),
  });
  return { user, workspaceId, ctxDb };
}

maybeTest('paid workspace (remi_tier column) is authorized for an active member', async () => {
  const ws = await makeWorkspace('remi-paid', 'paid');
  const result = await getRemiEntitlementForRequest(ws.ctxDb(), ws.user.id, ws.workspaceId);
  assert.equal(result.authorized, true, JSON.stringify(result));
  assert.equal(result.remiTier, 'paid');
});

maybeTest('free workspace is not authorized', async () => {
  const ws = await makeWorkspace('remi-free', 'free');
  const result = await getRemiEntitlementForRequest(ws.ctxDb(), ws.user.id, ws.workspaceId);
  assert.equal(result.authorized, false);
  assert.equal(result.remiTier, 'free');
});

maybeTest('a non-member of a paid workspace is not authorized', async () => {
  const paid = await makeWorkspace('remi-paid-target', 'paid');
  const outsider = await makeWorkspace('remi-outsider', 'paid');
  const result = await getRemiEntitlementForRequest(paid.ctxDb(outsider.user.id), outsider.user.id, paid.workspaceId);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'not_member');
});

maybeTest('a suspended member of a paid workspace is not authorized', async () => {
  const ws = await makeWorkspace('remi-suspended', 'paid');
  await adminPool.query(
    `UPDATE raf.workspace_members SET status = 'suspended' WHERE workspace_id = $1 AND user_id = $2`,
    [ws.workspaceId, ws.user.id],
  );
  const result = await getRemiEntitlementForRequest(ws.ctxDb(), ws.user.id, ws.workspaceId);
  assert.equal(result.authorized, false);
});
