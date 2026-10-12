/**
 * Remi conversation ownership — cross-member and cross-workspace access.
 *
 * A workspace member must only read or append to conversations they own, in
 * the workspace they are an active member of. Anything else returns 404 (never
 * 403) so conversation IDs cannot be enumerated.
 *
 * The db double below mirrors the adapter contract (ownership is part of the
 * query). The real SQL lives in lib/server/postgresDb.js and the RLS policy in
 * db/migrations/20261012000000_remi_conversation_owner_rls.sql; those need a
 * disposable Postgres run and are not exercised here.
 *
 * The Anthropic API is replaced by a local fake HTTP server (ANTHROPIC_BASE_URL).
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { GET as conversationGet } from '../app/api/v1/remi/conversations/[conversationId]/route.js';
import { POST as chatPost } from '../app/api/v1/remi/chat/route.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WS_A = 'ws_a';
const WS_B = 'ws_b';
const ALICE = 'user_alice'; // owner of conv in ws A
const BOB = 'user_bob';     // active member of ws A, not the owner
const CAROL = 'user_carol'; // paid member of ws B only

const MEMBERS = new Set([`${WS_A}|${ALICE}`, `${WS_A}|${BOB}`, `${WS_B}|${CAROL}`]);
const TIERS = { [WS_A]: 'paid', [WS_B]: 'paid' };

const CONV_A = crypto.randomUUID();

function makeStore() {
  const conversations = [
    { id: CONV_A, householdId: WS_A, userId: ALICE, title: 'Alice private chat', createdAt: '2026-10-01T00:00:00.000Z' },
  ];
  const messages = [
    { id: crypto.randomUUID(), householdId: WS_A, conversationId: CONV_A, role: 'user', content: 'Alice secret question', tokensUsed: 0, createdAt: '2026-10-01T00:00:01.000Z' },
    { id: crypto.randomUUID(), householdId: WS_A, conversationId: CONV_A, role: 'assistant', content: 'Alice secret answer', tokensUsed: 5, createdAt: '2026-10-01T00:00:02.000Z' },
  ];
  return { conversations, messages };
}

// Mirrors the adapter contract: conversation reads/writes require userId to own
// the conversation in the given workspace. Unknown/invalid userId -> null/[]/refuse.
function makeDb(store) {
  const tx = {
    async getWorkspaceMembership({ userId, workspaceId }) {
      return MEMBERS.has(`${workspaceId}|${userId}`) ? { userId, workspaceId, role: 'member' } : null;
    },
    async getWorkspace({ workspaceId }) {
      return { id: workspaceId, remiTier: TIERS[workspaceId] ?? 'free' };
    },
    async getHousehold({ householdId }) {
      return { id: householdId, name: 'Test Household' };
    },
    async getRemiConversation({ householdId, conversationId, userId }) {
      if (!userId || !conversationId) return null;
      return store.conversations.find((c) => c.id === conversationId && c.householdId === householdId && c.userId === userId) ?? null;
    },
    async listRemiMessages({ householdId, conversationId, userId }) {
      if (!userId || !conversationId) return [];
      const owned = store.conversations.some((c) => c.id === conversationId && c.householdId === householdId && c.userId === userId);
      if (!owned) return [];
      return store.messages.filter((m) => m.conversationId === conversationId && m.householdId === householdId);
    },
    async createRemiConversation({ householdId, userId, title }) {
      const conv = { id: crypto.randomUUID(), householdId, userId, title, createdAt: new Date().toISOString() };
      store.conversations.push(conv);
      return conv;
    },
    async appendRemiMessage({ householdId, conversationId, userId, role, content, tokensUsed }) {
      if (!userId || !conversationId) return null;
      const owned = store.conversations.some((c) => c.id === conversationId && c.householdId === householdId && c.userId === userId);
      if (!owned) return null;
      const msg = { id: crypto.randomUUID(), householdId, conversationId, role, content, tokensUsed, createdAt: new Date().toISOString() };
      store.messages.push(msg);
      return msg;
    },
  };
  return { async transaction(cb) { return cb(tx); } };
}

function ctx(db, { userId, workspaceId, params = {}, apiKey = null } = {}) {
  return { db, householdId: workspaceId, workspaceId, userId, anthropicApiKey: apiKey, params };
}

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

// ── Fake Anthropic API (no network) ───────────────────────────────────────────

let fakeServer;
let previousBaseUrl;

before(async () => {
  fakeServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content: [{ type: 'text', text: 'FAKE_AI_REPLY' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeServer.address().port}`;
});

after(async () => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  await new Promise((resolve) => fakeServer.close(resolve));
});

// ── Same workspace, different member ──────────────────────────────────────────

test('same workspace, other member: GET conversation returns 404', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq(`/remi/conversations/${CONV_A}`),
    ctx(makeDb(store), { userId: BOB, workspaceId: WS_A, params: { conversationId: CONV_A } }),
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.conversation, undefined);
  assert.equal(body.messages, undefined);
});

test('same workspace, other member: message list is never returned', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq(`/remi/conversations/${CONV_A}`),
    ctx(makeDb(store), { userId: BOB, workspaceId: WS_A, params: { conversationId: CONV_A } }),
  );
  const text = await res.text();
  assert.doesNotMatch(text, /Alice secret/);
});

test('same workspace, other member: POST chat with owner conversationId returns 404 and does not append to it', async () => {
  const store = makeStore();
  const before = store.messages.length;
  const res = await chatPost(
    postReq({ message: 'injected by bob', conversationId: CONV_A }),
    ctx(makeDb(store), { userId: BOB, workspaceId: WS_A, apiKey: 'test-key' }),
  );
  assert.equal(res.status, 404);
  assert.equal(store.messages.filter((m) => m.conversationId === CONV_A).length, before, 'owner conversation must not gain messages');
  assert.equal(store.messages.some((m) => m.content === 'injected by bob'), false, 'bob message must not be stored against owner conversation');
});

// ── Cross-workspace ───────────────────────────────────────────────────────────

test('cross-workspace: member of B using workspace B context with A conversation ID returns 404', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq(`/remi/conversations/${CONV_A}`),
    ctx(makeDb(store), { userId: CAROL, workspaceId: WS_B, params: { conversationId: CONV_A } }),
  );
  assert.equal(res.status, 404);
});

test('cross-workspace: non-member of workspace A asking for A conversation returns 404 (not 403)', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq(`/remi/conversations/${CONV_A}`),
    ctx(makeDb(store), { userId: CAROL, workspaceId: WS_A, params: { conversationId: CONV_A } }),
  );
  assert.equal(res.status, 404);
});

// ── Forged IDs ────────────────────────────────────────────────────────────────

test('forged random UUID returns 404 and creates no row', async () => {
  const store = makeStore();
  const forged = crypto.randomUUID();
  const convCount = store.conversations.length;
  const msgCount = store.messages.length;
  const res = await conversationGet(
    getReq(`/remi/conversations/${forged}`),
    ctx(makeDb(store), { userId: ALICE, workspaceId: WS_A, params: { conversationId: forged } }),
  );
  assert.equal(res.status, 404);
  assert.equal(store.conversations.length, convCount);
  assert.equal(store.messages.length, msgCount);
});

test('forged conversationId on chat POST returns 404 and never creates or attaches to the forged ID', async () => {
  const store = makeStore();
  const forged = crypto.randomUUID();
  const res = await chatPost(
    postReq({ message: 'hello', conversationId: forged }),
    ctx(makeDb(store), { userId: ALICE, workspaceId: WS_A, apiKey: 'test-key' }),
  );
  assert.equal(res.status, 404);
  assert.equal(store.conversations.some((c) => c.id === forged), false, 'forged ID must not be created');
  assert.equal(store.messages.filter((m) => m.conversationId === forged).length, 0, 'no messages attached to forged ID');
});

test('forged non-UUID conversation ID returns 404', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq('/remi/conversations/not-a-uuid'),
    ctx(makeDb(store), { userId: ALICE, workspaceId: WS_A, params: { conversationId: 'not-a-uuid' } }),
  );
  assert.equal(res.status, 404);
});

// ── Positive control: owner still sees their conversation ─────────────────────

test('owner GET conversation returns 200 with own messages', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq(`/remi/conversations/${CONV_A}`),
    ctx(makeDb(store), { userId: ALICE, workspaceId: WS_A, params: { conversationId: CONV_A } }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.conversation.id, CONV_A);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].content, 'Alice secret question');
});

test('owner GET still requires active membership: non-member gets 404 even with owner userId', async () => {
  const store = makeStore();
  const res = await conversationGet(
    getReq(`/remi/conversations/${CONV_A}`),
    ctx(makeDb(store), { userId: ALICE, workspaceId: WS_B, params: { conversationId: CONV_A } }),
  );
  assert.equal(res.status, 404);
});
