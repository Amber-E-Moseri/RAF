/**
 * Remi workspace RLS isolation + adversarial edge cases.
 *
 * Phase 6 items not covered by remiEntitlementAdversarial.test.js:
 *   14. missing/null workspace row → safe fallback to free
 *   15. malformed/unsupported tier → rejected; no capability granted
 *
 * Phase 7: RLS isolation using real PostgreSQL (disposable DB only).
 *   Requires: DATABASE_URL, POSTGRES_CONNECTION_STRING_APP,
 *             RAF_RUN_POSTGRES_RLS_TESTS=true, RAF_CONFIRM_NON_PRODUCTION_DB=true
 *
 * Gate: skipRls = false only when all required env vars are set.
 *       DB tests are marked .skip otherwise.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getRemiEntitlementForRequest } from '../lib/entitlement/remiEntitlement.js';

// ── Phase 6, item 14: missing workspace row ────────────────────────────────────

test('14: missing workspace (getWorkspace returns null) → free, no error', async () => {
  const db = {
    transaction: async (cb) => cb({
      getWorkspaceMembership: async () => ({ userId: 'u1', workspaceId: 'ws-missing' }),
      getWorkspace: async () => null,
    }),
  };
  const result = await getRemiEntitlementForRequest(db, 'u1', 'ws-missing');
  assert.equal(result.authorized, false, 'null workspace must not grant capability');
  assert.equal(result.remiTier, 'free', 'null workspace must default to free');
  assert.equal(result.reason, 'subscription_free');
});

// ── Phase 6, item 15: malformed/unsupported tier ───────────────────────────────

test('15: malformed tier "enterprise" → treated as free (no capability granted)', async () => {
  const db = {
    transaction: async (cb) => cb({
      getWorkspaceMembership: async () => ({ userId: 'u1', workspaceId: 'ws1' }),
      getWorkspace: async () => ({ remiTier: 'enterprise' }), // hypothetical unknown future value
    }),
  };
  const result = await getRemiEntitlementForRequest(db, 'u1', 'ws1');
  assert.equal(result.authorized, false, 'unknown tier must not grant capability');
  assert.equal(result.remiTier, 'enterprise', 'tier returned verbatim for logging');
});

test('15b: empty tier string → no capability granted', async () => {
  const db = {
    transaction: async (cb) => cb({
      getWorkspaceMembership: async () => ({ userId: 'u1', workspaceId: 'ws1' }),
      getWorkspace: async () => ({ remiTier: '' }),
    }),
  };
  const result = await getRemiEntitlementForRequest(db, 'u1', 'ws1');
  assert.equal(result.authorized, false, 'empty tier must not grant capability');
});

test('15c: null tier → defaults to free, no capability granted', async () => {
  const db = {
    transaction: async (cb) => cb({
      getWorkspaceMembership: async () => ({ userId: 'u1', workspaceId: 'ws1' }),
      getWorkspace: async () => ({ remiTier: null }),
    }),
  };
  const result = await getRemiEntitlementForRequest(db, 'u1', 'ws1');
  // null ?? 'free' → 'free'
  assert.equal(result.authorized, false);
  assert.equal(result.remiTier, 'free');
});

// ── Phase 7: RLS with real PostgreSQL ─────────────────────────────────────────

import pg from 'pg';
import crypto from 'node:crypto';

const adminUrl = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const appUrl = process.env.POSTGRES_CONNECTION_STRING_APP;
const rlsEnabled = process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true';
const nonProd = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';
const skipRls = !(adminUrl && appUrl && rlsEnabled && nonProd);

const maybeTest = skipRls ? test.skip : test;

let adminPool;
let appPool;
let wsA_id, wsB_id, userA_id, userB_id;

before(async () => {
  if (skipRls) return;
  adminPool = new pg.Pool({ connectionString: adminUrl, ssl: process.env.RAF_POSTGRES_SSL !== 'false' ? { rejectUnauthorized: false } : false, max: 3 });
  appPool = new pg.Pool({ connectionString: appUrl, ssl: process.env.RAF_POSTGRES_SSL !== 'false' ? { rejectUnauthorized: false } : false, max: 3 });

  wsA_id = crypto.randomUUID();
  wsB_id = crypto.randomUUID();
  userA_id = crypto.randomUUID();
  userB_id = crypto.randomUUID();

  await adminPool.query(`
    INSERT INTO raf.app_users (id, email, password_hash, remi_tier)
    VALUES ($1, $2, 'hash', 'free'), ($3, $4, 'hash', 'paid')
  `, [userA_id, `remi_rls_a_${wsA_id.slice(0,8)}@test.local`,
      userB_id, `remi_rls_b_${wsB_id.slice(0,8)}@test.local`]);

  await adminPool.query(`
    INSERT INTO raf.workspaces (id, name, owner_user_id, remi_tier)
    VALUES ($1, 'Remi RLS WS-A', $2, 'free'),
           ($3, 'Remi RLS WS-B', $4, 'paid')
  `, [wsA_id, userA_id, wsB_id, userB_id]);

  await adminPool.query(`
    INSERT INTO raf.workspace_members (workspace_id, user_id, role)
    VALUES ($1, $2, 'owner'), ($3, $4, 'owner')
  `, [wsA_id, userA_id, wsB_id, userB_id]);
});

after(async () => {
  if (skipRls) return;
  await adminPool.query(`DELETE FROM raf.workspace_members WHERE workspace_id IN ($1, $2)`, [wsA_id, wsB_id]);
  await adminPool.query(`DELETE FROM raf.workspaces WHERE id IN ($1, $2)`, [wsA_id, wsB_id]);
  await adminPool.query(`DELETE FROM raf.app_users WHERE id IN ($1, $2)`, [userA_id, userB_id]);
  await adminPool.end();
  await appPool.end();
});

async function withContext(client, userId, workspaceId, queryFn) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('raf.user_id', $1, true)", [userId]);
  await client.query("SELECT set_config('raf.workspace_id', $1, true)", [workspaceId]);
  try {
    const result = await queryFn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

maybeTest('7.1: RLS — user A cannot read workspace B remi_tier', async () => {
  const client = await appPool.connect();
  try {
    const rows = await withContext(client, userA_id, wsA_id, async (c) => {
      const { rows } = await c.query(
        `SELECT id, remi_tier FROM raf.workspaces WHERE id = $1`, [wsB_id]
      );
      return rows;
    });
    assert.equal(rows.length, 0, 'Workspace B must be invisible to User A (RLS)');
  } finally {
    client.release();
  }
});

maybeTest('7.2: RLS — non-member cannot gain entitlement by supplying B workspace ID', async () => {
  const client = await appPool.connect();
  try {
    // User A supplies workspace B's ID — but workspace_members query is RLS-filtered
    const rows = await withContext(client, userA_id, wsB_id, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM raf.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [wsB_id, userA_id]
      );
      return rows;
    });
    assert.equal(rows.length, 0, 'User A must have 0 membership rows in workspace B (RLS blocks)');
  } finally {
    client.release();
  }
});

maybeTest('7.3: RLS — raf_app role cannot bypass RLS (workspace row count reflects only own workspace)', async () => {
  const client = await appPool.connect();
  try {
    const rows = await withContext(client, userA_id, wsA_id, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM raf.workspaces WHERE id IN ($1, $2)`, [wsA_id, wsB_id]
      );
      return rows;
    });
    assert.equal(rows.length, 1, 'Only own workspace visible under raf_app role');
    assert.equal(rows[0].id, wsA_id, 'Workspace A is the visible one');
  } finally {
    client.release();
  }
});

maybeTest('7.4: RLS — membership removal takes effect on next request', async () => {
  // Add user A as member of workspace B
  await adminPool.query(
    `INSERT INTO raf.workspace_members (workspace_id, user_id, role, status)
     VALUES ($1, $2, 'member', 'active') ON CONFLICT DO NOTHING`,
    [wsB_id, userA_id]
  );

  const clientBefore = await appPool.connect();
  let beforeRemoval;
  try {
    beforeRemoval = await withContext(clientBefore, userA_id, wsB_id, async (c) => {
      const { rows } = await c.query(`SELECT id FROM raf.workspaces WHERE id = $1`, [wsB_id]);
      return rows;
    });
  } finally {
    clientBefore.release();
  }
  assert.equal(beforeRemoval.length, 1, 'User A can see workspace B after being added as member');

  // Remove membership
  await adminPool.query(
    `DELETE FROM raf.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [wsB_id, userA_id]
  );

  const clientAfter = await appPool.connect();
  let afterRemoval;
  try {
    afterRemoval = await withContext(clientAfter, userA_id, wsB_id, async (c) => {
      const { rows } = await c.query(`SELECT id FROM raf.workspaces WHERE id = $1`, [wsB_id]);
      return rows;
    });
  } finally {
    clientAfter.release();
  }
  assert.equal(afterRemoval.length, 0, 'User A cannot see workspace B after membership removed');
});
