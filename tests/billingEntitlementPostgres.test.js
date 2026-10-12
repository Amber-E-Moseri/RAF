/**
 * Billing entitlement integrity against REAL PostgreSQL.
 *
 * Proves, at the database level and through the runtime role (raf_app, NOBYPASSRLS):
 *   - no member, admin, or owner can change raf.workspaces.remi_tier through the app role
 *   - no member, admin, or owner can INSERT a workspace with remi_tier='paid'
 *   - the privileged paths still work: the table owner and a member of raf_billing_service
 *   - a login role with identical grants but WITHOUT raf_billing_service membership is rejected
 *   - ordinary workspace edits (name) and the app adapter's updateWorkspace still work,
 *     and a forged remiTier in the patch is ignored
 *   - PATCH /household/subscription (real adapter) cannot set the PDF quota tier
 *   - entitlement fails closed for invited, suspended, non-member, and missing-workspace cases
 *
 * SAFETY GATE. Runs only when ALL of these hold, otherwise the whole file is skipped:
 *   - POSTGRES_CONNECTION_STRING   (table owner / migration role)
 *   - POSTGRES_CONNECTION_STRING_APP (raf_app runtime role)
 *   - both point at 127.0.0.1, localhost, or [::1]
 *   - both database names contain "test" (disposable database, never a production name)
 *
 * Run (disposable local cluster only, never the repo .env):
 *   POSTGRES_CONNECTION_STRING=postgresql://neondb_owner@127.0.0.1:54330/raf_test \
 *   POSTGRES_CONNECTION_STRING_APP=postgresql://raf_app:<pw>@127.0.0.1:54330/raf_test \
 *   RAF_POSTGRES_SSL=false node --experimental-strip-types --test tests/billingEntitlementPostgres.test.js
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import pg from 'pg';

import { ensureUserOnboarded } from '../lib/auth/onboarding.js';
import { getRemiEntitlementForRequest } from '../lib/entitlement/remiEntitlement.js';
import { createPostgresDb } from '../lib/server/postgresDb.js';
import { PATCH as subscriptionPatch, GET as subscriptionGet } from '../app/api/v1/household/subscription/route.js';

const adminUrl = process.env.POSTGRES_CONNECTION_STRING;
const appUrl = process.env.POSTGRES_CONNECTION_STRING_APP;

function isDisposableLocalUrl(value) {
  try {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return local && /test/i.test(dbName);
  } catch {
    return false;
  }
}

const shouldRun = Boolean(adminUrl && appUrl) && isDisposableLocalUrl(adminUrl) && isDisposableLocalUrl(appUrl);
const maybeDescribe = shouldRun ? describe : describe.skip;

const sslOptions = process.env.RAF_POSTGRES_SSL === 'false' ? false : undefined;

const cleanup = { workspaceIds: [], roleNames: [] };
let adminPool;
let appPool;
let appDb;

before(async () => {
  if (!shouldRun) return;
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 3, ssl: sslOptions });
  appPool = new pg.Pool({ connectionString: appUrl, max: 3, ssl: sslOptions });
  appDb = createPostgresDb({ connectionString: appUrl, ssl: false });
});

after(async () => {
  if (!shouldRun) return;
  try {
    if (cleanup.workspaceIds.length > 0) {
      await adminPool.query('DELETE FROM raf.workspaces WHERE id = ANY($1::uuid[])', [cleanup.workspaceIds]);
    }
    for (const role of cleanup.roleNames) {
      await adminPool.query(`DROP OWNED BY ${role}`).catch(() => null);
      await adminPool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => null);
    }
  } finally {
    await appPool?.end();
    await adminPool?.end();
  }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

async function insertUser(label) {
  const id = crypto.randomUUID();
  await adminPool.query('INSERT INTO raf.app_users (id, email) VALUES ($1, $2)', [id, `${label}-${id}@example.test`]);
  return id;
}

/** Owner gets a real workspace (plus household) through the onboarding path. */
async function makeWorkspace(label) {
  const owner = { id: crypto.randomUUID(), email: `${label}-owner-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db: createPostgresDb({ connectionString: adminUrl, ssl: false }), user: owner, workspaceName: label });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  cleanup.workspaceIds.push(workspaceId);
  return { ownerId: owner.id, workspaceId };
}

async function addMember(workspaceId, role, status = 'active') {
  const userId = await insertUser(role);
  await adminPool.query(
    'INSERT INTO raf.workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
    [workspaceId, userId, role, status],
  );
  return userId;
}

async function remiTierOf(workspaceId) {
  const { rows } = await adminPool.query('SELECT remi_tier FROM raf.workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.remi_tier;
}

/**
 * Run `sql` as the runtime role (raf_app) inside its own transaction, with the trusted
 * identity GUCs set the same way the router does. Returns { ok, code, message, rowCount }.
 * Failures are captured, not thrown, so the caller can assert on the exact database error.
 */
async function asAppRole({ userId, workspaceId }, sql, params = []) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('raf.user_id', $1, true)", [userId]);
    await client.query("select set_config('raf.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return { ok: true, rowCount: result.rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    return { ok: false, code: error.code, message: error.message };
  } finally {
    client.release();
  }
}

const SET_TIER_PAID = 'UPDATE raf.workspaces SET remi_tier = $2 WHERE id = $1';

// ── tests ────────────────────────────────────────────────────────────────────

maybeDescribe('runtime role identity', () => {
  test('the app connection really is raf_app with NOBYPASSRLS and NOSUPERUSER', async () => {
    const { rows } = await appPool.query(
      'SELECT current_user, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user',
    );
    assert.equal(rows[0].current_user, 'raf_app', 'APP url must connect as raf_app');
    assert.equal(rows[0].rolbypassrls, false);
    assert.equal(rows[0].rolsuper, false);
  });

  test('raf_app is not a member of raf_billing_service', async () => {
    const { rows } = await adminPool.query(
      "SELECT pg_has_role('raf_app', 'raf_billing_service', 'MEMBER') AS member",
    );
    assert.equal(rows[0].member, false);
  });
});

maybeDescribe('raf.workspaces.remi_tier cannot be forged through the runtime role', () => {
  let ws;
  let member;
  let admin;

  before(async () => {
    ws = await makeWorkspace('billing-tier-guard');
    member = await addMember(ws.workspaceId, 'member');
    admin = await addMember(ws.workspaceId, 'admin');
    assert.equal(await remiTierOf(ws.workspaceId), 'free', 'fixture must start free');
  });

  test('a plain member cannot set remi_tier to paid', async () => {
    const outcome = await asAppRole({ userId: member, workspaceId: ws.workspaceId }, SET_TIER_PAID, [ws.workspaceId, 'paid']);
    assert.ok(outcome.ok === false || outcome.rowCount === 0, `member write must not succeed: ${JSON.stringify(outcome)}`);
    assert.equal(await remiTierOf(ws.workspaceId), 'free');
  });

  test('an admin cannot set remi_tier to paid (trigger rejects with 42501)', async () => {
    const outcome = await asAppRole({ userId: admin, workspaceId: ws.workspaceId }, SET_TIER_PAID, [ws.workspaceId, 'paid']);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, '42501');
    assert.match(outcome.message, /privileged billing service role/);
    assert.equal(await remiTierOf(ws.workspaceId), 'free');
  });

  test('the workspace owner cannot set remi_tier to paid (trigger rejects with 42501)', async () => {
    const outcome = await asAppRole({ userId: ws.ownerId, workspaceId: ws.workspaceId }, SET_TIER_PAID, [ws.workspaceId, 'paid']);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, '42501');
    assert.equal(await remiTierOf(ws.workspaceId), 'free');
  });

  test('the owner cannot self-grant paid even with the workspace GUC pointing at the owned workspace', async () => {
    // Forged session/header-style context: identical identity, explicit workspace GUC.
    const outcome = await asAppRole({ userId: ws.ownerId, workspaceId: ws.workspaceId }, 'UPDATE raf.workspaces SET remi_tier = \'paid\', name = name || \'-x\' WHERE id = $1', [ws.workspaceId]);
    assert.equal(outcome.ok, false, 'the whole statement must fail, including the non-tier column');
    assert.equal(await remiTierOf(ws.workspaceId), 'free');
  });

  test('an owner cannot INSERT a new workspace already marked paid', async () => {
    const owner = await insertUser('self-insert');
    const outcome = await asAppRole(
      { userId: owner, workspaceId: '00000000-0000-0000-0000-000000000000' },
      "INSERT INTO raf.workspaces (name, owner_user_id, remi_tier, raw_json) VALUES ('forged', $1, 'paid', '{}'::jsonb)",
      [owner],
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, '42501');
  });

  test('a workspace inserted by the runtime role with the default tier stays free (sanity)', async () => {
    const owner = await insertUser('default-insert');
    const freshId = crypto.randomUUID();
    cleanup.workspaceIds.push(freshId);
    const outcome = await asAppRole(
      { userId: owner, workspaceId: '00000000-0000-0000-0000-000000000000' },
      "INSERT INTO raf.workspaces (id, name, owner_user_id, raw_json) VALUES ($2, 'fresh', $1, '{}'::jsonb)",
      [owner, freshId],
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(await remiTierOf(freshId), 'free', 'default tier on insert must be free');
  });

  test('ordinary owner/admin edits to other columns still work (no regression)', async () => {
    const outcome = await asAppRole({ userId: ws.ownerId, workspaceId: ws.workspaceId }, 'UPDATE raf.workspaces SET name = $2 WHERE id = $1', [ws.workspaceId, 'renamed by owner']);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.rowCount, 1);
    const adminOutcome = await asAppRole({ userId: admin, workspaceId: ws.workspaceId }, 'UPDATE raf.workspaces SET name = $2 WHERE id = $1', [ws.workspaceId, 'renamed by admin']);
    assert.equal(adminOutcome.ok, true, JSON.stringify(adminOutcome));
  });

  test('the app adapter updateWorkspace ignores a forged remiTier in the patch', async () => {
    const forged = await appDb.transaction(
      (tx) => tx.updateWorkspace({ workspaceId: ws.workspaceId, patch: { name: 'adapter rename', remiTier: 'paid' } }),
      { userId: ws.ownerId, workspaceId: ws.workspaceId },
    );
    assert.ok(forged, 'owner adapter update should succeed');
    assert.equal(await remiTierOf(ws.workspaceId), 'free', 'remiTier in a patch must not reach the column');
  });

  test('the table owner (migration/ops role) can still set remi_tier (privileged path)', async () => {
    await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'paid']);
    assert.equal(await remiTierOf(ws.workspaceId), 'paid');
    await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'free']);
    assert.equal(await remiTierOf(ws.workspaceId), 'free');
  });
});

maybeDescribe('raf_billing_service is the only non-owner path to remi_tier', () => {
  let ws;
  let member;
  const svcRole = `raf_billing_svc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const nonMemberRole = `raf_svc_nonmember_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const password = crypto.randomBytes(12).toString('hex');

  function urlFor(role) {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = password;
    return url.toString();
  }

  before(async () => {
    ws = await makeWorkspace('billing-service-path');
    member = await addMember(ws.workspaceId, 'member');
    cleanup.roleNames.push(svcRole, nonMemberRole);

    // Two login roles with IDENTICAL table/schema grants. The only difference is
    // membership of raf_billing_service, so the test isolates the mechanism.
    for (const role of [svcRole, nonMemberRole]) {
      await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
      await adminPool.query(`GRANT USAGE ON SCHEMA raf TO ${role}`);
      await adminPool.query(`GRANT SELECT, UPDATE ON raf.workspaces TO ${role}`);
      await adminPool.query(`GRANT SELECT ON raf.workspace_members, raf.app_users TO ${role}`);
      await adminPool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA raf TO ${role}`);
    }
    await adminPool.query(`GRANT raf_billing_service TO ${svcRole}`);
  });

  test('a member of raf_billing_service can set remi_tier (the designed privileged path)', async () => {
    const svcPool = new pg.Pool({ connectionString: urlFor(svcRole), max: 1, ssl: sslOptions });
    try {
      const client = await svcPool.connect();
      try {
        await client.query('BEGIN');
        // Owner identity so RLS admits the row; the trigger, not RLS, is what is under test.
        await client.query("select set_config('raf.user_id', $1, true)", [ws.ownerId]);
        await client.query("select set_config('raf.workspace_id', $1, true)", [ws.workspaceId]);
        await client.query(SET_TIER_PAID, [ws.workspaceId, 'paid']);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      assert.equal(await remiTierOf(ws.workspaceId), 'paid');
      await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'free']);
    } finally {
      await svcPool.end();
    }
  });

  test('a role with the same grants but NOT in raf_billing_service is rejected', async () => {
    const nmPool = new pg.Pool({ connectionString: urlFor(nonMemberRole), max: 1, ssl: sslOptions });
    try {
      const client = await nmPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("select set_config('raf.user_id', $1, true)", [ws.ownerId]);
        await client.query("select set_config('raf.workspace_id', $1, true)", [ws.workspaceId]);
        await assert.rejects(
          client.query(SET_TIER_PAID, [ws.workspaceId, 'paid']),
          (error) => error.code === '42501' && /privileged billing service role/.test(error.message),
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      assert.equal(await remiTierOf(ws.workspaceId), 'free');
    } finally {
      await nmPool.end();
    }
  });

  test('a plain member still cannot write, even though members are not privileged', async () => {
    const outcome = await asAppRole({ userId: member, workspaceId: ws.workspaceId }, SET_TIER_PAID, [ws.workspaceId, 'paid']);
    assert.ok(outcome.ok === false || outcome.rowCount === 0);
    assert.equal(await remiTierOf(ws.workspaceId), 'free');
  });
});

maybeDescribe('PATCH /household/subscription through the real adapter', () => {
  let ws;
  let member;

  before(async () => {
    ws = await makeWorkspace('billing-subscription-route');
    member = await addMember(ws.workspaceId, 'member');
  });

  function ctxFor(userId) {
    return {
      db: { transaction: (callback) => appDb.transaction(callback, { userId, workspaceId: ws.workspaceId }) },
      householdId: ws.workspaceId,
      workspaceId: ws.workspaceId,
      userId,
    };
  }

  async function householdQuota() {
    const { rows } = await adminPool.query(
      'SELECT pdf_import_quota_tier, raw_json FROM raf.households WHERE workspace_id = $1',
      [ws.workspaceId],
    );
    return { column: rows[0]?.pdf_import_quota_tier, raw: rows[0]?.raw_json?.pdfImportQuotaTier };
  }

  test('a member PATCH with tier=paid returns 501 and the household quota is unchanged', async () => {
    const before = await householdQuota();
    assert.equal(before.column, 'free');

    const res = await subscriptionPatch(
      new Request('http://localhost/api/v1/household/subscription', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'paid', expiresAt: '2099-01-01T00:00:00.000Z' }),
      }),
      ctxFor(member),
    );
    assert.equal(res.status, 501);

    const after = await householdQuota();
    assert.deepEqual(after, before, 'quota column and raw_json must be unchanged');
  });

  test('the owner PATCH with tier=paid is also 501 (no route sets the quota tier)', async () => {
    const res = await subscriptionPatch(
      new Request('http://localhost/api/v1/household/subscription', { method: 'PATCH', body: JSON.stringify({ tier: 'paid' }) }),
      ctxFor(ws.ownerId),
    );
    assert.equal(res.status, 501);
    assert.equal((await householdQuota()).column, 'free');
  });

  test('GET quota status still works and reports free', async () => {
    const res = await subscriptionGet(new Request('http://localhost/api/v1/household/subscription'), ctxFor(member));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'free');
  });
});

maybeDescribe('entitlement fails closed against the real adapter', () => {
  let ws;
  let active;
  let invited;
  let suspended;
  let outsider;

  before(async () => {
    ws = await makeWorkspace('billing-fail-closed');
    await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'paid']);
    active = await addMember(ws.workspaceId, 'member', 'active');
    invited = await addMember(ws.workspaceId, 'member', 'invited');
    suspended = await addMember(ws.workspaceId, 'member', 'suspended');
    outsider = await insertUser('outsider');
  });

  after(async () => {
    if (ws) await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'free']).catch(() => null);
  });

  function ctxDb(userId) {
    return { transaction: (callback) => appDb.transaction(callback, { userId, workspaceId: ws.workspaceId }) };
  }

  test('control: active member of the paid workspace is authorized', async () => {
    const r = await getRemiEntitlementForRequest(ctxDb(active), active, ws.workspaceId);
    assert.equal(r.authorized, true);
    assert.equal(r.remiTier, 'paid');
  });

  test('invited member -> free', async () => {
    const r = await getRemiEntitlementForRequest(ctxDb(invited), invited, ws.workspaceId);
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
    assert.equal(r.reason, 'not_member');
  });

  test('suspended member -> free', async () => {
    const r = await getRemiEntitlementForRequest(ctxDb(suspended), suspended, ws.workspaceId);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'not_member');
  });

  test('user with no membership row -> free', async () => {
    const r = await getRemiEntitlementForRequest(ctxDb(outsider), outsider, ws.workspaceId);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'not_member');
  });

  test('a workspace id that does not exist -> free', async () => {
    const r = await getRemiEntitlementForRequest(ctxDb(active), active, crypto.randomUUID());
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
  });

  test('missing userId -> free without touching the database', async () => {
    const r = await getRemiEntitlementForRequest(ctxDb(active), null, ws.workspaceId);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'invalid_context');
  });
});

maybeDescribe('membership status column is authoritative over raw_json', () => {
  test('a member suspended in the status column stays free even if raw_json still says active', async () => {
    const ws = await makeWorkspace('billing-status-authority');
    await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'paid']);
    const userId = await insertUser('stale-json');
    await adminPool.query(
      `INSERT INTO raf.workspace_members (workspace_id, user_id, role, status, raw_json)
       VALUES ($1, $2, 'member', 'suspended', $3::jsonb)`,
      [ws.workspaceId, userId, JSON.stringify({ userId, workspaceId: ws.workspaceId, role: 'member', status: 'active' })],
    );
    const adapter = {
      transaction: (callback) => appDb.transaction(callback, { userId, workspaceId: ws.workspaceId }),
    };
    const r = await getRemiEntitlementForRequest(adapter, userId, ws.workspaceId);
    assert.equal(r.authorized, false, 'stale raw_json status must not grant Remi');
    assert.equal(r.reason, 'not_member');
    await adminPool.query(SET_TIER_PAID, [ws.workspaceId, 'free']);
  });
});
