/**
 * Remi HTTP route tests — all free-tier paths + conversation management.
 *
 * Scope:
 *   - GET  /remi/upgrade         — tier check
 *   - PATCH /remi/upgrade        — always 501
 *   - POST /remi/chat            — validation + free-tier KB response + paid-no-key fallback
 *   - GET  /remi/conversations   — tier gate + list
 *   - GET  /remi/conversations/[id] — tier gate + 404 + content + tenant isolation
 *   - GET  /remi/summary         — free-tier static summary with metrics
 *
 * The paid agentic path (chat + conversation persistence) requires a real
 * Anthropic API key and is covered by manual/integration testing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GET as upgradeGet, PATCH as upgradePatch } from '../app/api/v1/remi/upgrade/route.js';
import { POST as chatPost } from '../app/api/v1/remi/chat/route.js';
import { GET as conversationsGet } from '../app/api/v1/remi/conversations/route.js';
import { GET as conversationGet } from '../app/api/v1/remi/conversations/[conversationId]/route.js';
import { GET as summaryGet } from '../app/api/v1/remi/summary/route.js';

// ── DB double ─────────────────────────────────────────────────────────────────

function makeDb({ remiTier = 'free', conversations = [], messages = [] } = {}) {
  const convStore = conversations.map((c) => ({ ...c }));
  const msgStore = messages.map((m) => ({ ...m }));
  let nextId = 1;

  const tx = {
    async getUserById({ userId }) {
      return { id: userId, remiTier };
    },
    async getHousehold() {
      return { id: 'household_1', name: 'Test Household', activeMonth: '2026-03-01' };
    },
    async listTransactions() { return []; },
    async listIncomeEntries() { return []; },
    async listDebts() { return []; },
    async listDebtPayments() { return []; },
    async listGoals() { return []; },
    async listMonthlyReviews() { return []; },
    async listRemiConversations({ householdId, userId }) {
      return convStore.filter((c) => c.householdId === householdId && c.userId === userId);
    },
    async getRemiConversation({ conversationId, householdId }) {
      return convStore.find((c) => c.id === conversationId && c.householdId === householdId) ?? null;
    },
    async listRemiMessages({ conversationId, householdId }) {
      return msgStore.filter((m) => m.conversationId === conversationId && m.householdId === householdId);
    },
    async createRemiConversation({ householdId, userId, title }) {
      const conv = { id: `conv_${nextId++}`, householdId, userId, title, createdAt: new Date().toISOString() };
      convStore.push(conv);
      return conv;
    },
    async appendRemiMessage({ conversationId, householdId, role, content, tokensUsed }) {
      const msg = { id: `msg_${nextId++}`, conversationId, householdId, role, content, tokensUsed, createdAt: new Date().toISOString() };
      msgStore.push(msg);
      return msg;
    },
  };

  return { async transaction(cb) { return cb(tx); } };
}

// ── Request helpers ───────────────────────────────────────────────────────────

function req(path, { method = 'GET', body, householdId = 'household_1', userId = 'user_1' } = {}) {
  return new Request(`http://localhost/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function ctx(db, { householdId = 'household_1', userId = 'user_1', apiKey = null, params = {} } = {}) {
  return { db, householdId, userId, anthropicApiKey: apiKey, params };
}

// ── GET /remi/upgrade ─────────────────────────────────────────────────────────

test('upgrade GET returns userId and remiTier for free user', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await upgradeGet(req('/remi/upgrade'), ctx(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.userId, 'user_1');
  assert.equal(body.remiTier, 'free');
});

test('upgrade GET returns paid remiTier for paid user', async () => {
  const db = makeDb({ remiTier: 'paid' });
  const res = await upgradeGet(req('/remi/upgrade'), ctx(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.remiTier, 'paid');
});

// ── PATCH /remi/upgrade ───────────────────────────────────────────────────────

test('upgrade PATCH is always 501 — billing managed via Stripe webhook only', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await upgradePatch(req('/remi/upgrade', { method: 'PATCH', body: { tier: 'paid' } }), ctx(db));
  assert.equal(res.status, 501);
  const body = await res.json();
  assert.ok(typeof body.error === 'string');
  assert.ok(body.error.toLowerCase().includes('stripe') || body.error.toLowerCase().includes('billing') || body.error.toLowerCase().includes('not available'));
});

// ── POST /remi/chat — validation ──────────────────────────────────────────────

test('chat POST rejects missing message field', async () => {
  const db = makeDb();
  const res = await chatPost(req('/remi/chat', { method: 'POST', body: {} }), ctx(db));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string');
});

test('chat POST rejects empty message string', async () => {
  const db = makeDb();
  const res = await chatPost(req('/remi/chat', { method: 'POST', body: { message: '   ' } }), ctx(db));
  assert.equal(res.status, 400);
});

test('chat POST rejects invalid JSON body', async () => {
  const db = makeDb();
  const badReq = new Request('http://localhost/api/v1/remi/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json{',
  });
  const res = await chatPost(badReq, ctx(db));
  assert.equal(res.status, 400);
});

// ── POST /remi/chat — free tier ───────────────────────────────────────────────

test('chat POST free user returns knowledge-base reply without calling Anthropic', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await chatPost(
    req('/remi/chat', { method: 'POST', body: { message: 'How do I pay off debt?' } }),
    ctx(db),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'free');
  assert.ok(typeof body.reply === 'string' && body.reply.length > 0);
  assert.equal(body.conversationId, undefined, 'free tier must not create a conversation');
});

test('chat POST paid user without API key falls back to knowledge-base reply', async () => {
  const db = makeDb({ remiTier: 'paid' });
  const res = await chatPost(
    req('/remi/chat', { method: 'POST', body: { message: 'What is my savings rate?' } }),
    ctx(db, { apiKey: null }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'free', 'paid user with no API key must degrade to free-tier KB response');
  assert.ok(typeof body.reply === 'string' && body.reply.length > 0);
});

test('chat POST reply does not expose raw transaction IDs or account numbers', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await chatPost(
    req('/remi/chat', { method: 'POST', body: { message: 'Tell me about my spending' } }),
    ctx(db),
  );
  const body = await res.json();
  assert.doesNotMatch(body.reply, /txn_|acct_|\d{8,}/, 'reply must not leak IDs or account numbers');
});

// ── GET /remi/conversations — tier gate ───────────────────────────────────────

test('conversations GET returns 403 for free-tier users', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await conversationsGet(req('/remi/conversations'), ctx(db));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(typeof body.error === 'string');
  assert.equal(body.tier, 'free');
});

test('conversations GET returns empty list for paid user with no conversations', async () => {
  const db = makeDb({ remiTier: 'paid' });
  const res = await conversationsGet(req('/remi/conversations'), ctx(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.conversations));
  assert.equal(body.conversations.length, 0);
});

test('conversations GET returns only this user and household conversations', async () => {
  const db = makeDb({
    remiTier: 'paid',
    conversations: [
      { id: 'conv_a', householdId: 'household_1', userId: 'user_1', title: 'My conversation' },
      { id: 'conv_b', householdId: 'household_2', userId: 'user_1', title: 'Other workspace' },
      { id: 'conv_c', householdId: 'household_1', userId: 'user_2', title: 'Other user' },
    ],
  });
  const res = await conversationsGet(req('/remi/conversations'), ctx(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].id, 'conv_a');
});

// ── GET /remi/conversations/[id] ──────────────────────────────────────────────

test('conversation GET returns 403 for free-tier users', async () => {
  const db = makeDb({ remiTier: 'free', conversations: [{ id: 'conv_1', householdId: 'household_1', userId: 'user_1', title: 'A chat' }] });
  const res = await conversationGet(req('/remi/conversations/conv_1'), ctx(db, { params: { conversationId: 'conv_1' } }));
  assert.equal(res.status, 403);
});

test('conversation GET returns 404 for unknown conversation', async () => {
  const db = makeDb({ remiTier: 'paid' });
  const res = await conversationGet(req('/remi/conversations/no-such-id'), ctx(db, { params: { conversationId: 'no-such-id' } }));
  assert.equal(res.status, 404);
});

test('conversation GET returns 404 for conversation belonging to a different household', async () => {
  const db = makeDb({
    remiTier: 'paid',
    conversations: [{ id: 'conv_other', householdId: 'household_2', userId: 'user_1', title: 'Other workspace chat' }],
  });
  const res = await conversationGet(
    req('/remi/conversations/conv_other'),
    ctx(db, { householdId: 'household_1', params: { conversationId: 'conv_other' } }),
  );
  assert.equal(res.status, 404, 'cross-household conversation access must return 404');
});

test('conversation GET returns conversation and messages for paid user', async () => {
  const db = makeDb({
    remiTier: 'paid',
    conversations: [{ id: 'conv_1', householdId: 'household_1', userId: 'user_1', title: 'Budget chat' }],
    messages: [
      { id: 'msg_1', conversationId: 'conv_1', householdId: 'household_1', role: 'user', content: 'What is my budget?', tokensUsed: 0 },
      { id: 'msg_2', conversationId: 'conv_1', householdId: 'household_1', role: 'assistant', content: 'Your budget is...', tokensUsed: 42 },
    ],
  });
  const res = await conversationGet(req('/remi/conversations/conv_1'), ctx(db, { params: { conversationId: 'conv_1' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.conversation.id, 'conv_1');
  assert.equal(body.conversation.title, 'Budget chat');
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[1].role, 'assistant');
});

test('conversation GET does not return messages from a different conversation in the same household', async () => {
  const db = makeDb({
    remiTier: 'paid',
    conversations: [
      { id: 'conv_1', householdId: 'household_1', userId: 'user_1', title: 'First chat' },
      { id: 'conv_2', householdId: 'household_1', userId: 'user_1', title: 'Second chat' },
    ],
    messages: [
      { id: 'msg_a', conversationId: 'conv_1', householdId: 'household_1', role: 'user', content: 'Chat 1 message' },
      { id: 'msg_b', conversationId: 'conv_2', householdId: 'household_1', role: 'user', content: 'Chat 2 message' },
    ],
  });
  const res = await conversationGet(req('/remi/conversations/conv_1'), ctx(db, { params: { conversationId: 'conv_1' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].id, 'msg_a');
});

// ── GET /remi/summary ─────────────────────────────────────────────────────────

test('summary GET returns free-tier static response with metrics when no API key', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await summaryGet(req('/remi/summary'), ctx(db, { apiKey: null }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'free');
  assert.ok(typeof body.summary === 'string' && body.summary.length > 0);
  assert.ok(typeof body.month === 'string');
  assert.ok(typeof body.metrics === 'object' && body.metrics !== null);
  assert.ok('avgMonthlyIncome' in body.metrics);
  assert.ok('avgMonthlySpending' in body.metrics);
  assert.ok('savingsRate' in body.metrics);
  assert.ok('debtCount' in body.metrics);
  assert.ok('goalCount' in body.metrics);
});

test('summary GET free-tier response does not include raw financial data or IDs', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await summaryGet(req('/remi/summary'), ctx(db, { apiKey: null }));
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /household_1|user_1/);
});

test('summary GET paid user without API key degrades to free-tier response', async () => {
  const db = makeDb({ remiTier: 'paid' });
  const res = await summaryGet(req('/remi/summary'), ctx(db, { apiKey: null }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'free', 'paid user with no API key must return free-tier summary');
});

test('summary GET month param is reflected in the response', async () => {
  const db = makeDb({ remiTier: 'free' });
  const res = await summaryGet(
    new Request('http://localhost/api/v1/remi/summary?month=2026-01', { headers: { 'content-type': 'application/json' } }),
    ctx(db, { apiKey: null }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.month, '2026-01');
});
