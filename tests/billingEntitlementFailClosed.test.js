/**
 * Billing and Remi entitlement: fail-closed and privilege-escalation tests (no database).
 *
 * Covers:
 *   - PATCH /household/subscription is not a self-service paid path (501, quota unchanged)
 *   - the Stripe webhook is an explicit 501 and processes nothing
 *   - every fail-closed case of getRemiEntitlementForRequest / getRemiEntitlementStatus
 *   - forged body / header / session-style values have no effect on entitlement
 *
 * DB-level enforcement of raf.workspaces.remi_tier is covered by
 * tests/billingEntitlementPostgres.test.js (disposable Postgres only).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { PATCH as subscriptionPatch, GET as subscriptionGet } from '../app/api/v1/household/subscription/route.js';
import { POST as webhookPost } from '../app/api/v1/billing/webhook/route.js';
import { POST as chatPost } from '../app/api/v1/remi/chat/route.js';
import { GET as summaryGet } from '../app/api/v1/remi/summary/route.js';
import { getRemiEntitlementForRequest, getRemiEntitlementStatus } from '../lib/entitlement/remiEntitlement.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const ACTIVE = 'active';

/** Build a db whose transaction() hands the given tx double to the callback. */
function dbWith(tx) {
  return { transaction: async (callback) => callback(tx) };
}

/** A tx double whose membership and workspace answers are configurable. */
function txWith({ member = { userId: 'u1', workspaceId: 'ws1', status: ACTIVE }, workspace = { remiTier: 'paid' } } = {}) {
  // Membership only exists for the member userId, like a real adapter.
  return {
    getWorkspaceMember: async ({ userId }) => (userId === member?.userId ? member : null),
    getWorkspace: async () => workspace,
  };
}

function req(path, { method = 'GET', body, headers = {} } = {}) {
  return new Request(`http://localhost/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Trusted server context, as produced by the router after verifying the session. */
function trustedCtx(db, { userId = 'u1', workspaceId = 'ws1' } = {}) {
  return { db, userId, workspaceId, householdId: workspaceId, anthropicApiKey: null, params: {} };
}

// ── PATCH /household/subscription: no self-service paid tier ─────────────────

describe('PATCH /household/subscription', () => {
  function quotaSpyDb() {
    const calls = { writes: [] };
    const tx = {
      getPdfImportQuotaStatus: async () => ({ tier: 'free', remaining: 3, canImport: true, reason: 'under_limit' }),
      updateHouseholdPdfQuotaTier: async (args) => {
        calls.writes.push(args);
        return { pdfImportQuotaTier: args.tier };
      },
    };
    return { db: dbWith(tx), calls, tx };
  }

  test('member setting tier=paid gets 501 and no quota write happens', async () => {
    const { db, calls } = quotaSpyDb();
    const res = await subscriptionPatch(
      req('/household/subscription', { method: 'PATCH', body: { tier: 'paid' } }),
      trustedCtx(db, { userId: 'member-1' }),
    );
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.code, 'BILLING_NOT_ACTIVE');
    assert.match(body.error, /Billing is not active/);
    assert.match(body.error, /Stripe/);
    assert.equal(calls.writes.length, 0, 'no quota write may reach the adapter');
  });

  test('tier=paid with expiresAt in the future still gets 501 and no write', async () => {
    const { db, calls } = quotaSpyDb();
    const res = await subscriptionPatch(
      req('/household/subscription', { method: 'PATCH', body: { tier: 'paid', expiresAt: '2099-01-01T00:00:00.000Z' } }),
      trustedCtx(db),
    );
    assert.equal(res.status, 501);
    assert.equal(calls.writes.length, 0);
  });

  test('malformed body still gets 501, never 400 that echoes a write path', async () => {
    const { db, calls } = quotaSpyDb();
    const res = await subscriptionPatch(
      req('/household/subscription', { method: 'PATCH', body: { tier: 'enterprise', expiresAt: 'not-a-date' } }),
      trustedCtx(db),
    );
    assert.equal(res.status, 501);
    assert.equal(calls.writes.length, 0);
  });

  test('forged quota tier in headers and body does not change the quota', async () => {
    const { db, calls } = quotaSpyDb();
    const res = await subscriptionPatch(
      req('/household/subscription', {
        method: 'PATCH',
        headers: { 'x-pdf-import-quota-tier': 'paid', 'x-role': 'owner', 'x-user-id': 'someone-else' },
        body: { tier: 'paid', pdfImportQuotaTier: 'paid', role: 'owner', userId: 'someone-else' },
      }),
      trustedCtx(db, { userId: 'member-1' }),
    );
    assert.equal(res.status, 501);
    assert.equal(calls.writes.length, 0);
  });

  test('GET quota status still works and reports the unchanged free quota', async () => {
    const { db } = quotaSpyDb();
    const res = await subscriptionGet(req('/household/subscription'), trustedCtx(db));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'free');
    assert.equal(body.remaining, 3);
    assert.equal(body.canImport, true);
  });
});

// ── Stripe webhook: explicit 501, nothing processed ──────────────────────────

describe('POST /billing/webhook', () => {
  test('any request returns 501 and is not processed, even with a signature header', async () => {
    const res = await webhookPost(
      req('/billing/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=forged' },
        body: { type: 'checkout.session.completed', data: { object: { metadata: { workspaceId: 'ws1' } } } },
      }),
      {},
    );
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.processed, false);
    assert.match(body.error, /not implemented/);
    assert.match(body.error, /no charges occur/);
  });

  test('a request without a signature also gets 501 (no misleading 200)', async () => {
    const res = await webhookPost(req('/billing/webhook', { method: 'POST', body: {} }), {});
    assert.equal(res.status, 501);
  });
});

// ── Entitlement: fail-closed matrix ──────────────────────────────────────────

describe('getRemiEntitlementForRequest fails closed', () => {
  test('missing userId -> free (invalid_context)', async () => {
    const r = await getRemiEntitlementForRequest(dbWith(txWith()), undefined, 'ws1');
    assert.deepEqual(r, { authorized: false, remiTier: 'free', reason: 'invalid_context' });
  });

  test('empty userId -> free', async () => {
    const r = await getRemiEntitlementForRequest(dbWith(txWith()), '', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
  });

  test('missing workspaceId -> free (invalid_context)', async () => {
    const r = await getRemiEntitlementForRequest(dbWith(txWith()), 'u1', null);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'invalid_context');
  });

  test('no membership row -> free (not_member)', async () => {
    const r = await getRemiEntitlementForRequest(dbWith(txWith({ member: null })), 'u1', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
    assert.equal(r.reason, 'not_member');
  });

  test('invited member of a paid workspace -> free (not_member)', async () => {
    const r = await getRemiEntitlementForRequest(
      dbWith(txWith({ member: { userId: 'u1', workspaceId: 'ws1', status: 'invited' } })), 'u1', 'ws1',
    );
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'not_member');
  });

  test('suspended member of a paid workspace -> free (not_member)', async () => {
    const r = await getRemiEntitlementForRequest(
      dbWith(txWith({ member: { userId: 'u1', workspaceId: 'ws1', status: 'suspended' } })), 'u1', 'ws1',
    );
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'not_member');
  });

  test('member with status missing -> free (only status active counts)', async () => {
    const r = await getRemiEntitlementForRequest(
      dbWith(txWith({ member: { userId: 'u1', workspaceId: 'ws1' } })), 'u1', 'ws1',
    );
    assert.equal(r.authorized, false);
  });

  test('missing workspace row (getWorkspace returns null) -> free', async () => {
    const r = await getRemiEntitlementForRequest(dbWith(txWith({ workspace: null })), 'u1', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
    assert.equal(r.reason, 'subscription_free');
  });

  for (const tier of ['free', 'Paid', 'PAID', 'paid ', ' paid', 'enterprise', '', null, undefined, true, 1]) {
    test(`remi_tier ${JSON.stringify(tier)} -> free`, async () => {
      const r = await getRemiEntitlementForRequest(dbWith(txWith({ workspace: { remiTier: tier } })), 'u1', 'ws1');
      assert.equal(r.authorized, false);
      assert.equal(r.remiTier, 'free', 'unknown tier must be reported as free, not echoed');
    });
  }

  test('adapter without getWorkspaceMember -> free (not_member)', async () => {
    const tx = { getWorkspace: async () => ({ remiTier: 'paid' }) };
    const r = await getRemiEntitlementForRequest(dbWith(tx), 'u1', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'not_member');
  });

  test('adapter without getWorkspace -> free', async () => {
    const tx = { getWorkspaceMember: async () => ({ userId: 'u1', status: ACTIVE }) };
    const r = await getRemiEntitlementForRequest(dbWith(tx), 'u1', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
  });

  test('legacy getWorkspaceMembership-only adapter is NOT trusted (fallback removed) -> free', async () => {
    const tx = {
      getWorkspaceMembership: async () => ({ userId: 'u1', workspaceId: 'ws1' }),
      getWorkspace: async () => ({ remiTier: 'paid' }),
    };
    const r = await getRemiEntitlementForRequest(dbWith(tx), 'u1', 'ws1');
    assert.equal(r.authorized, false, 'a membership method that skips the active check must never grant access');
    assert.equal(r.reason, 'not_member');
  });

  test('thrown error inside the membership lookup -> free, no throw', async () => {
    const tx = {
      getWorkspaceMember: async () => { throw new Error('connection reset'); },
      getWorkspace: async () => ({ remiTier: 'paid' }),
    };
    const r = await getRemiEntitlementForRequest(dbWith(tx), 'u1', 'ws1');
    assert.deepEqual(r, { authorized: false, remiTier: 'free', reason: 'entitlement_error' });
  });

  test('thrown error inside the workspace lookup -> free, no throw', async () => {
    const tx = {
      getWorkspaceMember: async () => ({ userId: 'u1', status: ACTIVE }),
      getWorkspace: async () => { throw new Error('relation does not exist'); },
    };
    const r = await getRemiEntitlementForRequest(dbWith(tx), 'u1', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.remiTier, 'free');
    assert.equal(r.reason, 'entitlement_error');
  });

  test('db.transaction itself throws -> free, no throw', async () => {
    const db = { transaction: async () => { throw new Error('pool exhausted'); } };
    const r = await getRemiEntitlementForRequest(db, 'u1', 'ws1');
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'entitlement_error');
  });

  test('control: active member + paid workspace IS authorized', async () => {
    const r = await getRemiEntitlementForRequest(dbWith(txWith()), 'u1', 'ws1');
    assert.equal(r.authorized, true);
    assert.equal(r.remiTier, 'paid');
    assert.equal(r.reason, null);
  });
});

describe('getRemiEntitlementStatus fails closed', () => {
  test('missing workspace id -> free', async () => {
    const s = await getRemiEntitlementStatus(dbWith(txWith()), undefined);
    assert.equal(s.tier, 'free');
  });

  test('adapter without getWorkspace -> free', async () => {
    const s = await getRemiEntitlementStatus(dbWith({}), 'ws1');
    assert.equal(s.tier, 'free');
  });

  test('thrown error -> free, no throw', async () => {
    const db = { transaction: async () => { throw new Error('boom'); } };
    const s = await getRemiEntitlementStatus(db, 'ws1');
    assert.equal(s.tier, 'free');
  });

  test('unknown tier value -> free', async () => {
    const s = await getRemiEntitlementStatus(dbWith(txWith({ workspace: { remiTier: 'enterprise' } })), 'ws1');
    assert.equal(s.tier, 'free');
  });

  test('paid workspace -> paid (informational only)', async () => {
    const s = await getRemiEntitlementStatus(dbWith(txWith()), 'ws1');
    assert.equal(s.tier, 'paid');
  });
});

// ── Forgery: client-supplied tier / user / workspace have no effect ─────────

describe('forged client values cannot grant Remi', () => {
  // Workspace is FREE in the (authoritative) database. Every forged value the client
  // controls points at a paid state. None of them may change the outcome.
  // Summary needs the financial-context readers. Return empty collections, free workspace.
  const fullFreeDb = () => dbWith({
    ...txWith({ workspace: { remiTier: 'free' } }),
    getHousehold: async () => ({ id: 'ws1', name: 'Test', activeMonth: '2026-03-01' }),
    listTransactions: async () => [],
    listIncomeEntries: async () => [],
    listDebts: async () => [],
    listDebtPayments: async () => [],
    listGoals: async () => [],
    listMonthlyReviews: async () => [],
  });

  const freeDb = () => dbWith(txWith({
    member: { userId: 'u1', workspaceId: 'ws1', status: ACTIVE },
    workspace: { remiTier: 'free' },
  }));

  test('chat: body remiTier/tier/userId and headers x-remi-tier / x-user-id are ignored', async () => {
    const res = await chatPost(
      req('/remi/chat', {
        method: 'POST',
        headers: {
          'x-remi-tier': 'paid',
          'x-user-id': 'admin-user',
          'x-workspace-id': 'ws-paid-elsewhere',
          'x-household-id': 'ws-paid-elsewhere',
        },
        body: { message: 'hello', tier: 'paid', remiTier: 'paid', userId: 'admin-user', workspaceId: 'ws-paid-elsewhere', authorized: true },
      }),
      trustedCtx(freeDb(), { userId: 'u1', workspaceId: 'ws1' }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'free', 'forged client tier must not change the answer');
    assert.equal(body.reply !== undefined, true);
  });

  test('summary: forged x-remi-tier and tier query params do not unlock the paid summary', async () => {
    const url = 'http://localhost/api/v1/remi/summary?month=2026-03&tier=paid&authorized=true';
    const res = await summaryGet(
      new Request(url, { headers: { 'x-remi-tier': 'paid', 'x-user-id': 'admin-user' } }),
      trustedCtx(fullFreeDb(), { userId: 'u1', workspaceId: 'ws1' }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'free');
  });

  test('a forged user id in context-less requests resolves to local-user, which is not a member -> free', async () => {
    // With no trusted userId, the route falls back to 'local-user'. That identity is
    // never a member, so the result must be free even if the db would say paid.
    const res = await chatPost(
      req('/remi/chat', { method: 'POST', headers: { 'x-user-id': 'u1' }, body: { message: 'hi', userId: 'u1' } }),
      { db: freeDb(), workspaceId: 'ws1', householdId: 'ws1', anthropicApiKey: 'sk-test-not-used' },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'free');
  });
});
