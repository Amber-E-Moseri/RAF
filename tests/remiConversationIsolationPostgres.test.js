/**
 * Remi conversation isolation through the REAL Postgres adapter (raf_app role, RLS active).
 *
 * Visibility model: a Remi conversation is private to the member who created it, scoped to
 * one workspace. Workspace membership alone does NOT grant access to another member's
 * conversation or its messages. Unauthorized or nonexistent conversation IDs are treated the
 * same way (non-disclosing).
 *
 * Gated like the other Postgres tests: DATABASE_URL (owner) + POSTGRES_CONNECTION_STRING_APP
 * (raf_app), local or RAF_CONFIRM_NON_PRODUCTION_DB=true. Never point these at production.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { Pool } from 'pg';

import { ensureUserOnboarded } from '../lib/auth/onboarding.js';
import { createPostgresDb } from '../lib/server/postgresDb.js';
import { POST as chatPost } from '../app/api/v1/remi/chat/route.js';
import { GET as conversationGet } from '../app/api/v1/remi/conversations/[conversationId]/route.js';
import { GET as conversationListGet } from '../app/api/v1/remi/conversations/route.js';

const adminUrl = process.env.DATABASE_URL;
const appUrl = process.env.POSTGRES_CONNECTION_STRING_APP;
const isLocal = (url) => /@(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url ?? '');
const shouldRun = Boolean(adminUrl && appUrl)
  && ((isLocal(adminUrl) && isLocal(appUrl)) || process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true');
const maybeTest = shouldRun ? test : test.skip;

const adminDb = shouldRun ? createPostgresDb({ connectionString: adminUrl, ssl: false }) : null;
const appDb = shouldRun ? createPostgresDb({ connectionString: appUrl, ssl: false }) : null;
const adminPool = shouldRun ? new Pool({ connectionString: adminUrl, max: 2 }) : null;
const appPool = shouldRun ? new Pool({ connectionString: appUrl, max: 2 }) : null;
const createdWorkspaceIds = [];

const FAKE_REPLY = 'FAKE_AI_REPLY';
let fake;
let previousBaseUrl;

before(async () => {
  if (!shouldRun) return;
  // Fake Anthropic endpoint so the paid chat path never makes a real request.
  fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
        content: [{ type: 'text', text: FAKE_REPLY }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
});

after(async () => {
  if (!shouldRun) return;
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  await new Promise((resolve) => fake.close(resolve));
  if (createdWorkspaceIds.length > 0) {
    await adminPool.query('DELETE FROM raf.workspaces WHERE id = ANY($1::uuid[])', [createdWorkspaceIds]);
  }
  await adminPool.end();
  await appPool.end();
});

/** A paid workspace with one owner. Returns the owner and the workspace id. */
async function makePaidWorkspace(label) {
  const owner = { id: crypto.randomUUID(), email: `${label}-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db: adminDb, user: owner, workspaceName: label });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  createdWorkspaceIds.push(workspaceId);
  await adminPool.query('UPDATE raf.workspaces SET remi_tier = $2 WHERE id = $1', [workspaceId, 'paid']);
  return { owner, workspaceId };
}

/** An active member of an existing workspace, with no workspace of their own to lean on. */
async function addMember(workspaceId, label) {
  const user = { id: crypto.randomUUID(), email: `${label}-${crypto.randomUUID()}@example.test` };
  await ensureUserOnboarded({ db: adminDb, user, workspaceName: `${label}-own` });
  // Mirror createWorkspaceMember: the adapter resolves members from raw_json.
  const id = crypto.randomUUID();
  const joinedAt = new Date().toISOString();
  const raw = { id, workspaceId, householdId: workspaceId, userId: user.id, role: 'member', status: 'active', joinedAt, invitedBy: null };
  await adminPool.query(
    `INSERT INTO raf.workspace_members (id, workspace_id, user_id, role, status, joined_at, invited_by, raw_json)
     VALUES ($1, $2, $3, 'member', 'active', $4, NULL, $5)`,
    [id, workspaceId, user.id, joinedAt, raw],
  );
  return user;
}

/**
 * The trusted context the router builds for an authenticated request: userId and workspaceId
 * come from verified claims and membership, never from the request body or headers.
 */
function trustedContext(user, workspaceId, extra = {}) {
  return {
    db: { transaction: (callback) => appDb.transaction(callback, { userId: user.id, workspaceId }) },
    userId: user.id,
    workspaceId,
    householdId: workspaceId,
    anthropicApiKey: 'sk-ant-test-fake-key',
    params: {},
    ...extra,
  };
}

function jsonRequest(url, method, body) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function chat(context, body) {
  return chatPost(jsonRequest('/api/v1/remi/chat', 'POST', body), context);
}

function readConversation(context, conversationId) {
  return conversationGet(
    jsonRequest(`/api/v1/remi/conversations/${conversationId}`, 'GET'),
    { ...context, params: { conversationId } },
  );
}

function listConversations(context) {
  return conversationListGet(jsonRequest('/api/v1/remi/conversations', 'GET'), context);
}

/** Runs SQL as the raf_app role with the trusted user and workspace set, so RLS applies. */
async function asAppRole(userId, workspaceId, sql, params = []) {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('raf.user_id', $1, true)", [userId]);
    await client.query("select set_config('raf.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query(sql, params);
    await client.query('commit');
    return result.rows;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Owner A creates a conversation through the real chat route, then returns its id. */
async function createConversationFor(context) {
  const response = await chat(context, { message: 'private question from A' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.ok(body.conversationId, 'chat must return a conversationId');
  return body.conversationId;
}

const NONEXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

maybeTest('member A reads their own conversation and its messages', async () => {
  const ws = await makePaidWorkspace('iso-own-read');
  const a = ws.owner;
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  const response = await readConversation(trustedContext(a, ws.workspaceId), conversationId);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.conversation.id, conversationId);
  assert.equal(body.messages.length, 2, 'user message and assistant reply');
});

maybeTest('member A appends to their own conversation', async () => {
  const ws = await makePaidWorkspace('iso-own-append');
  const a = ws.owner;
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  const response = await chat(trustedContext(a, ws.workspaceId), { message: 'follow up', conversationId });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).conversationId, conversationId, 'reply stays in the same conversation');

  const readBack = await (await readConversation(trustedContext(a, ws.workspaceId), conversationId)).json();
  assert.equal(readBack.messages.length, 4);
});

maybeTest('member B cannot read member A conversation in the same workspace (non-disclosing)', async () => {
  const ws = await makePaidWorkspace('iso-b-read');
  const a = ws.owner;
  const b = await addMember(ws.workspaceId, 'iso-b-read-member');
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  const forB = await readConversation(trustedContext(b, ws.workspaceId), conversationId);
  const forMissing = await readConversation(trustedContext(b, ws.workspaceId), NONEXISTENT_UUID);

  assert.equal(forB.status, 404);
  assert.equal(forMissing.status, 404);
  // Same body for "belongs to someone else" and "does not exist": no disclosure.
  assert.deepEqual(await forB.json(), await forMissing.json());
});

maybeTest('member B cannot append to member A conversation', async () => {
  const ws = await makePaidWorkspace('iso-b-append');
  const a = ws.owner;
  const b = await addMember(ws.workspaceId, 'iso-b-append-member');
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  const response = await chat(trustedContext(b, ws.workspaceId), { message: 'intruding', conversationId });
  assert.equal(response.status, 200, 'B gets a normal reply, in a conversation B owns');
  const replyConversationId = (await response.json()).conversationId;
  assert.notEqual(replyConversationId, conversationId, 'B must not be attached to A conversation');

  const aView = await (await readConversation(trustedContext(a, ws.workspaceId), conversationId)).json();
  assert.equal(aView.messages.length, 2, "A's conversation must not gain B's message");
  assert.ok(aView.messages.every((m) => !m.content.includes('intruding')));
});

maybeTest('adapter append rejects a conversation the caller does not own', async () => {
  const ws = await makePaidWorkspace('iso-adapter-append');
  const a = ws.owner;
  const b = await addMember(ws.workspaceId, 'iso-adapter-append-member');
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  const attempt = appDb.transaction(
    (tx) => tx.appendRemiMessage({ householdId: ws.workspaceId, conversationId, userId: b.id, role: 'user', content: 'forged', tokensUsed: 0 }),
    { userId: b.id, workspaceId: ws.workspaceId },
  );
  const outcome = await attempt.then((row) => ({ inserted: Boolean(row) }), () => ({ inserted: false }));
  assert.equal(outcome.inserted, false, 'append to a foreign conversation must not insert');

  const rows = await asAppRole(a.id, ws.workspaceId, 'select id from raf.remi_messages where conversation_id = $1', [conversationId]);
  assert.equal(rows.length, 2, 'no row may be added to A conversation');
});

maybeTest('member of another workspace cannot read the conversation', async () => {
  const ws = await makePaidWorkspace('iso-cross-ws');
  const a = ws.owner;
  const other = await makePaidWorkspace('iso-cross-ws-other');
  const outsider = other.owner;
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  // Outsider is a paid member of their own workspace, but pointing at A workspace is not_member.
  const viaForeignWorkspace = await readConversation(trustedContext(outsider, ws.workspaceId), conversationId);
  assert.equal(viaForeignWorkspace.status, 403);

  // Outsider uses their own paid workspace with A conversation id: the id is not in that workspace.
  const viaOwnWorkspace = await readConversation(trustedContext(outsider, other.workspaceId), conversationId);
  assert.equal(viaOwnWorkspace.status, 404);
});

maybeTest('unauthenticated context (no userId) cannot read or append', async () => {
  const ws = await makePaidWorkspace('iso-anon');
  const a = ws.owner;
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));
  const anon = { ...trustedContext(a, ws.workspaceId), userId: null, db: trustedContext(a, ws.workspaceId).db };

  const read = await readConversation(anon, conversationId);
  assert.equal(read.status, 403);

  const list = await listConversations(anon);
  assert.equal(list.status, 403);

  // Chat without a verified user must not attach to A conversation; it falls to the free path.
  const write = await chat(anon, { message: 'anon', conversationId });
  const writeBody = await write.json();
  assert.equal(writeBody.tier, 'free');
  assert.notEqual(writeBody.conversationId, conversationId);

  const aView = await (await readConversation(trustedContext(a, ws.workspaceId), conversationId)).json();
  assert.equal(aView.messages.length, 2);
});

maybeTest('forged userId in the request body or headers is ignored', async () => {
  const ws = await makePaidWorkspace('iso-forged');
  const a = ws.owner;
  const b = await addMember(ws.workspaceId, 'iso-forged-member');
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  // B sends A's id in the body and A's id as a header. Neither may change the trusted identity.
  const request = new Request('http://localhost/api/v1/remi/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': a.id, 'x-workspace-id': ws.workspaceId },
    body: JSON.stringify({ message: 'forged', conversationId, userId: a.id }),
  });
  const response = await chatPost(request, trustedContext(b, ws.workspaceId));
  assert.equal(response.status, 200);
  assert.notEqual((await response.json()).conversationId, conversationId);

  const aView = await (await readConversation(trustedContext(a, ws.workspaceId), conversationId)).json();
  assert.equal(aView.messages.length, 2);
});

maybeTest('invalid and nonexistent conversation ids are handled safely', async () => {
  const ws = await makePaidWorkspace('iso-invalid');
  const a = ws.owner;

  const garbage = await readConversation(trustedContext(a, ws.workspaceId), 'not-a-uuid');
  assert.equal(garbage.status, 404, 'malformed id must be a 404, not a 500');

  const missing = await readConversation(trustedContext(a, ws.workspaceId), NONEXISTENT_UUID);
  assert.equal(missing.status, 404);

  const chatGarbage = await chat(trustedContext(a, ws.workspaceId), { message: 'hi', conversationId: 'not-a-uuid' });
  assert.equal(chatGarbage.status, 200, 'malformed id in chat must not 500');
  assert.ok((await chatGarbage.json()).conversationId);
});

maybeTest('legitimate listing returns only the requester own conversations', async () => {
  const ws = await makePaidWorkspace('iso-list');
  const a = ws.owner;
  const b = await addMember(ws.workspaceId, 'iso-list-member');
  const aConversation = await createConversationFor(trustedContext(a, ws.workspaceId));
  const bConversation = await createConversationFor(trustedContext(b, ws.workspaceId));

  const aList = await (await listConversations(trustedContext(a, ws.workspaceId))).json();
  const aIds = aList.conversations.map((c) => c.id);
  assert.ok(aIds.includes(aConversation));
  assert.ok(!aIds.includes(bConversation), "A list must not show B conversation");

  const bList = await (await listConversations(trustedContext(b, ws.workspaceId))).json();
  const bIds = bList.conversations.map((c) => c.id);
  assert.ok(bIds.includes(bConversation));
  assert.ok(!bIds.includes(aConversation), "B list must not show A conversation");
});

maybeTest('database RLS denies a workspace member direct SELECT on another member conversation and messages', async () => {
  const ws = await makePaidWorkspace('iso-rls');
  const a = ws.owner;
  const b = await addMember(ws.workspaceId, 'iso-rls-member');
  const conversationId = await createConversationFor(trustedContext(a, ws.workspaceId));

  const ownConv = await asAppRole(a.id, ws.workspaceId, 'select id from raf.remi_conversations where id = $1', [conversationId]);
  assert.equal(ownConv.length, 1, 'owner sees own conversation row through RLS');

  const foreignConv = await asAppRole(b.id, ws.workspaceId, 'select id from raf.remi_conversations where id = $1', [conversationId]);
  assert.equal(foreignConv.length, 0, 'RLS must hide A conversation from B');

  const foreignMsgs = await asAppRole(b.id, ws.workspaceId, 'select id from raf.remi_messages where conversation_id = $1', [conversationId]);
  assert.equal(foreignMsgs.length, 0, 'RLS must hide A messages from B');
});
