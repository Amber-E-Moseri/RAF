/**
 * Remi conversation ownership through the REAL Postgres adapter and RLS policies.
 *
 * The in-memory tests (remiConversationOwnership.test.js) stub the storage layer,
 * so they cannot prove the SQL or the policies. This file does.
 *
 * Environment (both must point at a disposable, local database):
 *   POSTGRES_CONNECTION_STRING   owner/admin URL, e.g. postgresql://neondb_owner@127.0.0.1:54331/raf_test
 *   RAF_POSTGRES_SSL=false       required for a local cluster
 *   POSTGRES_CONNECTION_STRING_APP (optional) raf_app runtime URL. If unset, it is derived from
 *                                POSTGRES_CONNECTION_STRING with user raf_app and password from
 *                                RAF_APP_DB_PASSWORD (empty for a local trust cluster).
 *   RAF_CONFIRM_NON_PRODUCTION_DB=true  only if the host is not localhost (never for production).
 *
 * The suite is skipped when these are not set. Admin connections bypass RLS (superuser /
 * BYPASSRLS), so every RLS assertion runs as raf_app, which is NOBYPASSRLS.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import pg from 'pg';

import { ensureUserOnboarded } from '../lib/auth/onboarding.js';
import { createPostgresDb } from '../lib/server/postgresDb.js';
import { GET as conversationGet } from '../app/api/v1/remi/conversations/[conversationId]/route.js';
import { POST as chatPost } from '../app/api/v1/remi/chat/route.js';

const { Pool } = pg;

const adminUrl = process.env.POSTGRES_CONNECTION_STRING ?? '';
const isLocal = (url) => /@(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url);

function deriveAppUrl(url) {
  const parsed = new URL(url);
  parsed.username = 'raf_app';
  parsed.password = process.env.RAF_APP_DB_PASSWORD ?? '';
  return parsed.toString();
}

const appUrl = process.env.POSTGRES_CONNECTION_STRING_APP || (adminUrl ? deriveAppUrl(adminUrl) : '');
const shouldRun = Boolean(adminUrl)
  && ((isLocal(adminUrl) && isLocal(appUrl)) || process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true');
const maybeTest = shouldRun ? test : test.skip;

const ssl = process.env.RAF_POSTGRES_SSL !== 'false' && process.env.RAF_POSTGRES_SSL !== '0';
const adminDb = shouldRun ? createPostgresDb({ connectionString: adminUrl, ssl }) : null;
const appDb = shouldRun ? createPostgresDb({ connectionString: appUrl, ssl }) : null;
const adminPool = shouldRun ? new Pool({ connectionString: adminUrl, max: 2 }) : null;
const appPool = shouldRun ? new Pool({ connectionString: appUrl, max: 4 }) : null;

const createdWorkspaceIds = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Same shape routerLoader hands to route handlers: every transaction carries the trusted context.
function ctxDb(userId, workspaceId) {
  return { transaction: (callback) => appDb.transaction(callback, { userId, workspaceId }) };
}

// Runs raw SQL as the raf_app role with the session GUCs set exactly as the adapter sets them.
// Pass userId/workspaceId as null to leave that GUC unset (fail-closed checks).
async function asAppRole({ userId = null, workspaceId = null }, fn) {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    if (userId) await client.query("select set_config('raf.user_id', $1, true)", [userId]);
    if (workspaceId) await client.query("select set_config('raf.workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function onboard(label) {
  const user = { id: crypto.randomUUID(), email: `${label}-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db: adminDb, user, workspaceName: label });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  createdWorkspaceIds.push(workspaceId);
  return { user, workspaceId };
}

async function addActiveMember(workspaceId, userId) {
  await adminPool.query(
    `INSERT INTO raf.workspace_members (workspace_id, user_id, role, status)
     VALUES ($1, $2, 'member', 'active')
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active'`,
    [workspaceId, userId],
  );
}

async function countMessages(conversationId) {
  const r = await adminPool.query('SELECT count(*)::int AS n FROM raf.remi_messages WHERE conversation_id = $1', [conversationId]);
  return r.rows[0].n;
}

async function messageContent(messageId) {
  const r = await adminPool.query('SELECT content FROM raf.remi_messages WHERE id = $1', [messageId]);
  return r.rows[0]?.content ?? null;
}

async function conversationTitle(conversationId) {
  const r = await adminPool.query('SELECT title FROM raf.remi_conversations WHERE id = $1', [conversationId]);
  return r.rows[0]?.title ?? null;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let fakeServer;
let previousBaseUrl;
let WS_A;
let WS_B;
let ALICE;
let BOB;
let CAROL;
let CONV_A;
let MSG_ALICE_1;
let CONV_BOB; // bob's own conversation in WS A (for re-ownership attack)

before(async () => {
  if (!shouldRun) return;

  const a = await onboard('remi-owner-ws-a');
  const b = await onboard('remi-other-ws-b');
  const bob = await onboard('remi-bob');
  const carol = await onboard('remi-carol');
  WS_A = a.workspaceId;
  WS_B = b.workspaceId;
  ALICE = a.user.id;
  BOB = bob.user.id;
  CAROL = carol.user.id;

  await addActiveMember(WS_A, BOB);
  await adminPool.query("UPDATE raf.workspaces SET remi_tier = 'paid' WHERE id = ANY($1::uuid[])", [[WS_A, WS_B]]);

  // Alice owns CONV_A with two messages; Bob owns CONV_BOB in the same workspace.
  const conv = await appDb.transaction(
    (tx) => tx.createRemiConversation({ householdId: WS_A, userId: ALICE, title: 'Alice private chat' }),
    { userId: ALICE, workspaceId: WS_A },
  );
  CONV_A = conv.id;
  await appDb.transaction(async (tx) => {
    await tx.appendRemiMessage({ householdId: WS_A, conversationId: CONV_A, userId: ALICE, role: 'user', content: 'Alice secret question', tokensUsed: 0 });
    await tx.appendRemiMessage({ householdId: WS_A, conversationId: CONV_A, userId: ALICE, role: 'assistant', content: 'Alice secret answer', tokensUsed: 5 });
  }, { userId: ALICE, workspaceId: WS_A });
  const msgRows = await adminPool.query('SELECT id FROM raf.remi_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 1', [CONV_A]);
  MSG_ALICE_1 = msgRows.rows[0].id;

  const bobConv = await appDb.transaction(
    (tx) => tx.createRemiConversation({ householdId: WS_A, userId: BOB, title: 'Bob chat' }),
    { userId: BOB, workspaceId: WS_A },
  );
  CONV_BOB = bobConv.id;

  // Fake Anthropic API (no network) for the end-to-end chat checks.
  fakeServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
        content: [{ type: 'text', text: 'FAKE_AI_REPLY' }], stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeServer.address().port}`;
});

after(async () => {
  if (!shouldRun) return;
  if (fakeServer) {
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => fakeServer.close(resolve));
  }
  if (createdWorkspaceIds.length > 0) {
    await adminPool.query('DELETE FROM raf.workspaces WHERE id = ANY($1::uuid[])', [createdWorkspaceIds]);
  }
  await appDb.close();
  await adminDb.close();
  await appPool.end();
  await adminPool.end();
});

// ── 1. Adapter SQL: owner positive control and ownership-scoped reads ─────────

maybeTest('owner reads own conversation and its messages through the real adapter', async () => {
  const conv = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: CONV_A, userId: ALICE }), { userId: ALICE, workspaceId: WS_A });
  assert.ok(conv, 'owner must see own conversation');
  const msgs = await appDb.transaction((tx) => tx.listRemiMessages({ householdId: WS_A, conversationId: CONV_A, userId: ALICE }), { userId: ALICE, workspaceId: WS_A });
  assert.equal(msgs.length, 2);
});

maybeTest('same workspace, other member: getRemiConversation and listRemiMessages return nothing', async () => {
  const conv = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: CONV_A, userId: BOB }), { userId: BOB, workspaceId: WS_A });
  assert.equal(conv, null);
  const msgs = await appDb.transaction((tx) => tx.listRemiMessages({ householdId: WS_A, conversationId: CONV_A, userId: BOB }), { userId: BOB, workspaceId: WS_A });
  assert.deepEqual(msgs, []);
  const list = await appDb.transaction((tx) => tx.listRemiConversations({ householdId: WS_A, userId: BOB }), { userId: BOB, workspaceId: WS_A });
  assert.equal(list.some((c) => c.id === CONV_A), false);
});

maybeTest('same workspace, other member: appendRemiMessage writes nothing to the owner conversation', async () => {
  const before = await countMessages(CONV_A);
  const row = await appDb.transaction(
    (tx) => tx.appendRemiMessage({ householdId: WS_A, conversationId: CONV_A, userId: BOB, role: 'user', content: 'bob injection', tokensUsed: 0 }),
    { userId: BOB, workspaceId: WS_A },
  );
  assert.equal(row, null, 'adapter must refuse the write');
  assert.equal(await countMessages(CONV_A), before);
});

maybeTest('cross-workspace: member of B cannot read A conversation even as its owner id', async () => {
  const asCarol = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_B, conversationId: CONV_A, userId: CAROL }), { userId: CAROL, workspaceId: WS_B });
  assert.equal(asCarol, null);
  const asAliceInB = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_B, conversationId: CONV_A, userId: ALICE }), { userId: ALICE, workspaceId: WS_B });
  assert.equal(asAliceInB, null, 'owner id in the wrong workspace must not match');
  const msgs = await appDb.transaction((tx) => tx.listRemiMessages({ householdId: WS_B, conversationId: CONV_A, userId: ALICE }), { userId: ALICE, workspaceId: WS_B });
  assert.deepEqual(msgs, []);
});

maybeTest('non-member of A with A context: no read and no append', async () => {
  const conv = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: CONV_A, userId: CAROL }), { userId: CAROL, workspaceId: WS_A });
  assert.equal(conv, null);
  const row = await appDb.transaction(
    (tx) => tx.appendRemiMessage({ householdId: WS_A, conversationId: CONV_A, userId: CAROL, role: 'user', content: 'carol', tokensUsed: 0 }),
    { userId: CAROL, workspaceId: WS_A },
  );
  assert.equal(row, null);
});

maybeTest('malformed ids fail closed without a cast error', async () => {
  const conv = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: 'not-a-uuid', userId: ALICE }), { userId: ALICE, workspaceId: WS_A });
  assert.equal(conv, null);
  const msgs = await appDb.transaction((tx) => tx.listRemiMessages({ householdId: WS_A, conversationId: 'not-a-uuid', userId: ALICE }), { userId: ALICE, workspaceId: WS_A });
  assert.deepEqual(msgs, []);
  const noUser = await appDb.transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: CONV_A, userId: 'local-user' }), { userId: ALICE, workspaceId: WS_A });
  assert.equal(noUser, null);
});

maybeTest('owner can append to own conversation (positive control)', async () => {
  const before = await countMessages(CONV_A);
  const row = await appDb.transaction(
    (tx) => tx.appendRemiMessage({ householdId: WS_A, conversationId: CONV_A, userId: ALICE, role: 'user', content: 'alice follow-up', tokensUsed: 0 }),
    { userId: ALICE, workspaceId: WS_A },
  );
  assert.ok(row && row.conversationId === CONV_A, JSON.stringify(row));
  assert.equal(await countMessages(CONV_A), before + 1);
});

// ── 2. Routes against the real adapter: non-disclosing 404 ────────────────────

function getReq(path) {
  return new Request(`http://localhost/api/v1${path}`, { method: 'GET' });
}

function postReq(body) {
  return new Request('http://localhost/api/v1/remi/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

maybeTest('detail route: other member, cross-workspace, non-member, malformed and unknown ids get identical 404s', async () => {
  const unknown = crypto.randomUUID();
  const cases = [
    { label: 'other member', userId: BOB, workspaceId: WS_A, id: CONV_A },
    { label: 'cross workspace', userId: CAROL, workspaceId: WS_B, id: CONV_A },
    { label: 'non-member', userId: CAROL, workspaceId: WS_A, id: CONV_A },
    { label: 'malformed', userId: ALICE, workspaceId: WS_A, id: 'not-a-uuid' },
    { label: 'unknown', userId: ALICE, workspaceId: WS_A, id: unknown },
  ];
  const bodies = [];
  for (const c of cases) {
    const res = await conversationGet(getReq(`/remi/conversations/${c.id}`), {
      db: ctxDb(c.userId, c.workspaceId), householdId: c.workspaceId, workspaceId: c.workspaceId, userId: c.userId, params: { conversationId: c.id },
    });
    assert.equal(res.status, 404, c.label);
    const text = await res.text();
    assert.doesNotMatch(text, /Alice secret/, c.label);
    bodies.push(text);
  }
  assert.deepEqual(JSON.parse(bodies[0]), { error: 'Conversation not found' });
  for (const body of bodies) assert.equal(body, bodies[0]);
});

maybeTest('detail route: owner gets 200 with messages (positive control)', async () => {
  const res = await conversationGet(getReq(`/remi/conversations/${CONV_A}`), {
    db: ctxDb(ALICE, WS_A), householdId: WS_A, workspaceId: WS_A, userId: ALICE, params: { conversationId: CONV_A },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.conversation.id, CONV_A);
  assert.ok(body.messages.length >= 2);
});

maybeTest('chat route: other member POST with owner conversationId returns 404 and writes nothing', async () => {
  const before = await countMessages(CONV_A);
  const convCountBefore = (await adminPool.query('SELECT count(*)::int AS n FROM raf.remi_conversations WHERE workspace_id = $1', [WS_A])).rows[0].n;
  const res = await chatPost(postReq({ message: 'bob injected', conversationId: CONV_A }), {
    db: ctxDb(BOB, WS_A), householdId: WS_A, workspaceId: WS_A, userId: BOB, anthropicApiKey: 'test-key',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Conversation not found' });
  assert.equal(await countMessages(CONV_A), before, 'owner conversation must not gain messages');
  const convCountAfter = (await adminPool.query('SELECT count(*)::int AS n FROM raf.remi_conversations WHERE workspace_id = $1', [WS_A])).rows[0].n;
  assert.equal(convCountAfter, convCountBefore, 'no conversation may be silently created');
});

maybeTest('chat route: owner POST with own conversationId appends both turns (positive control)', async () => {
  const before = await countMessages(CONV_A);
  const res = await chatPost(postReq({ message: 'alice next question', conversationId: CONV_A }), {
    db: ctxDb(ALICE, WS_A), householdId: WS_A, workspaceId: WS_A, userId: ALICE, anthropicApiKey: 'test-key',
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.conversationId, CONV_A);
  assert.equal(await countMessages(CONV_A), before + 2);
});

// ── 3. RLS policies, exercised as raf_app (NOBYPASSRLS) ───────────────────────

maybeTest('RLS fails closed: no session user or no session workspace means zero visible rows', async () => {
  const noUser = await asAppRole({ workspaceId: WS_A }, async (c) => ({
    conv: (await c.query('SELECT id FROM raf.remi_conversations')).rowCount,
    msg: (await c.query('SELECT id FROM raf.remi_messages')).rowCount,
  }));
  assert.deepEqual(noUser, { conv: 0, msg: 0 }, 'unset raf.user_id must see nothing');

  const noWorkspace = await asAppRole({ userId: ALICE }, async (c) => ({
    conv: (await c.query('SELECT id FROM raf.remi_conversations')).rowCount,
    msg: (await c.query('SELECT id FROM raf.remi_messages')).rowCount,
  }));
  assert.deepEqual(noWorkspace, { conv: 0, msg: 0 }, 'unset raf.workspace_id must see nothing');

  const nothing = await asAppRole({}, async (c) => (await c.query('SELECT id FROM raf.remi_conversations')).rowCount);
  assert.equal(nothing, 0);
});

maybeTest('RLS: same-workspace other user cannot SELECT owner conversation or messages', async () => {
  const rows = await asAppRole({ userId: BOB, workspaceId: WS_A }, async (c) => ({
    conv: (await c.query('SELECT id FROM raf.remi_conversations WHERE id = $1', [CONV_A])).rowCount,
    msgs: (await c.query('SELECT id FROM raf.remi_messages WHERE conversation_id = $1', [CONV_A])).rowCount,
  }));
  assert.deepEqual(rows, { conv: 0, msgs: 0 });
});

maybeTest('RLS: owner can SELECT own rows (positive control)', async () => {
  const rows = await asAppRole({ userId: ALICE, workspaceId: WS_A }, async (c) => ({
    conv: (await c.query('SELECT id FROM raf.remi_conversations WHERE id = $1', [CONV_A])).rowCount,
    msgs: (await c.query('SELECT id FROM raf.remi_messages WHERE conversation_id = $1', [CONV_A])).rowCount,
  }));
  assert.equal(rows.conv, 1);
  assert.ok(rows.msgs >= 2);
});

maybeTest('RLS: other member UPDATE of owner message affects 0 rows and changes nothing', async () => {
  const original = await messageContent(MSG_ALICE_1);
  const affected = await asAppRole({ userId: BOB, workspaceId: WS_A }, async (c) =>
    (await c.query('UPDATE raf.remi_messages SET content = $2 WHERE id = $1', [MSG_ALICE_1, 'pwned by bob'])).rowCount);
  assert.equal(affected, 0);
  assert.equal(await messageContent(MSG_ALICE_1), original);
});

maybeTest('RLS: other member DELETE of owner message affects 0 rows and the row survives', async () => {
  const affected = await asAppRole({ userId: BOB, workspaceId: WS_A }, async (c) =>
    (await c.query('DELETE FROM raf.remi_messages WHERE id = $1', [MSG_ALICE_1])).rowCount);
  assert.equal(affected, 0);
  assert.notEqual(await messageContent(MSG_ALICE_1), null);
});

maybeTest('RLS: other member UPDATE and DELETE of owner conversation affect 0 rows', async () => {
  const title = await conversationTitle(CONV_A);
  const updated = await asAppRole({ userId: BOB, workspaceId: WS_A }, async (c) =>
    (await c.query('UPDATE raf.remi_conversations SET title = $2 WHERE id = $1', [CONV_A, 'bob renamed'])).rowCount);
  const deleted = await asAppRole({ userId: BOB, workspaceId: WS_A }, async (c) =>
    (await c.query('DELETE FROM raf.remi_conversations WHERE id = $1', [CONV_A])).rowCount);
  assert.equal(updated, 0);
  assert.equal(deleted, 0);
  assert.equal(await conversationTitle(CONV_A), title);
});

maybeTest('RLS: other member cannot INSERT a message into the owner conversation', async () => {
  const before = await countMessages(CONV_A);
  await assert.rejects(
    asAppRole({ userId: BOB, workspaceId: WS_A }, (c) => c.query(
      `INSERT INTO raf.remi_messages (workspace_id, conversation_id, role, content) VALUES ($1, $2, 'user', 'raw insert')`,
      [WS_A, CONV_A],
    )),
    /row-level security/i,
  );
  assert.equal(await countMessages(CONV_A), before);
});

maybeTest('RLS: owner cannot re-home a message into another user conversation (WITH CHECK)', async () => {
  await assert.rejects(
    asAppRole({ userId: ALICE, workspaceId: WS_A }, (c) =>
      c.query('UPDATE raf.remi_messages SET conversation_id = $2 WHERE id = $1', [MSG_ALICE_1, CONV_BOB])),
    /row-level security/i,
  );
  assert.equal(await countMessages(CONV_BOB), 0);
});

maybeTest('RLS: owner cannot transfer conversation ownership to another user (WITH CHECK)', async () => {
  await assert.rejects(
    asAppRole({ userId: ALICE, workspaceId: WS_A }, (c) =>
      c.query('UPDATE raf.remi_conversations SET user_id = $2 WHERE id = $1', [CONV_A, BOB])),
    /row-level security/i,
  );
  const owner = await adminPool.query('SELECT user_id FROM raf.remi_conversations WHERE id = $1', [CONV_A]);
  assert.equal(owner.rows[0].user_id, ALICE);
});

maybeTest('RLS: cross-workspace member cannot read, update, delete or insert into workspace A', async () => {
  const seen = await asAppRole({ userId: CAROL, workspaceId: WS_B }, async (c) => ({
    conv: (await c.query('SELECT id FROM raf.remi_conversations WHERE id = $1', [CONV_A])).rowCount,
    msgs: (await c.query('SELECT id FROM raf.remi_messages WHERE conversation_id = $1', [CONV_A])).rowCount,
  }));
  assert.deepEqual(seen, { conv: 0, msgs: 0 });

  const changed = await asAppRole({ userId: CAROL, workspaceId: WS_B }, async (c) => ({
    upd: (await c.query('UPDATE raf.remi_messages SET content = $2 WHERE id = $1', [MSG_ALICE_1, 'carol'])).rowCount,
    del: (await c.query('DELETE FROM raf.remi_conversations WHERE id = $1', [CONV_A])).rowCount,
  }));
  assert.deepEqual(changed, { upd: 0, del: 0 });

  await assert.rejects(
    asAppRole({ userId: CAROL, workspaceId: WS_B }, (c) => c.query(
      `INSERT INTO raf.remi_conversations (workspace_id, user_id, title) VALUES ($1, $2, 'x')`,
      [WS_A, CAROL],
    )),
    /row-level security/i,
  );
});

maybeTest('RLS: owner can still UPDATE and DELETE own rows (positive control)', async () => {
  const scratchConv = await asAppRole({ userId: ALICE, workspaceId: WS_A }, async (c) =>
    (await c.query(`INSERT INTO raf.remi_conversations (workspace_id, user_id, title) VALUES ($1, $2, 'scratch') RETURNING id`, [WS_A, ALICE])).rows[0].id);
  const scratchMsg = await asAppRole({ userId: ALICE, workspaceId: WS_A }, async (c) =>
    (await c.query(`INSERT INTO raf.remi_messages (workspace_id, conversation_id, role, content) VALUES ($1, $2, 'user', 'scratch') RETURNING id`, [WS_A, scratchConv])).rows[0].id);
  const updated = await asAppRole({ userId: ALICE, workspaceId: WS_A }, async (c) =>
    (await c.query('UPDATE raf.remi_messages SET content = $2 WHERE id = $1', [scratchMsg, 'scratch edited'])).rowCount);
  const deleted = await asAppRole({ userId: ALICE, workspaceId: WS_A }, async (c) =>
    (await c.query('DELETE FROM raf.remi_messages WHERE id = $1', [scratchMsg])).rowCount);
  assert.equal(updated, 1);
  assert.equal(deleted, 1);
  await asAppRole({ userId: ALICE, workspaceId: WS_A }, (c) => c.query('DELETE FROM raf.remi_conversations WHERE id = $1', [scratchConv]));
});

// ── 4. Adapter SQL filters on their own (superuser connection bypasses RLS) ───
// The raf_app checks above cannot tell whether the adapter's own user_id/workspace_id
// predicate is present, because RLS would also hide the row. A superuser connection
// bypasses RLS, so these assertions prove the application-layer filter independently.

maybeTest('adapter filter alone (RLS bypassed): other member cannot read or append', async () => {
  const superAdapter = createPostgresDb({ connectionString: adminUrl, ssl });
  try {
    const ctx = (userId) => ({ transaction: (cb) => superAdapter.transaction(cb, { userId, workspaceId: WS_A }) });
    const conv = await ctx(BOB).transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: CONV_A, userId: BOB }));
    assert.equal(conv, null);
    const msgs = await ctx(BOB).transaction((tx) => tx.listRemiMessages({ householdId: WS_A, conversationId: CONV_A, userId: BOB }));
    assert.deepEqual(msgs, []);
    const row = await ctx(BOB).transaction((tx) => tx.appendRemiMessage({ householdId: WS_A, conversationId: CONV_A, userId: BOB, role: 'user', content: 'x', tokensUsed: 0 }));
    assert.equal(row, null);
    const wrongWs = await ctx(ALICE).transaction((tx) => tx.getRemiConversation({ householdId: WS_B, conversationId: CONV_A, userId: ALICE }));
    assert.equal(wrongWs, null);
    const owner = await ctx(ALICE).transaction((tx) => tx.getRemiConversation({ householdId: WS_A, conversationId: CONV_A, userId: ALICE }));
    assert.ok(owner, 'positive control: owner matches with RLS bypassed');
  } finally {
    await superAdapter.close();
  }
});
