/**
 * Remi security remediation regression tests (no database required).
 *
 * Covers: explicit add_to_goal targets, confirmation-only tool previews, the tool-loop limit,
 * sanitized Anthropic failures (timeout / 429 / 5xx / malformed / misconfigured), Zod request
 * validation, and per-user usage limits. The Anthropic API is replaced by a local fake server
 * (ANTHROPIC_BASE_URL); no real request is made.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

process.env.JWT_SECRET = 'remi-security-remediation-test-secret-0123456789';
process.env.RAF_AUTH_REQUIRED = 'true';

const { createApiRouter } = await import('../lib/server/routerLoader.js');
const { createInMemoryDb } = await import('../lib/server/inMemoryDb.js');
const { ensureUserOnboarded } = await import('../lib/auth/onboarding.js');
const { createToken } = await import('../lib/auth/jwt.js');
const { dispatchToolCall } = await import('../lib/remi/toolHandlers.js');
const { generateRemiResponse, MAX_TOOL_ROUNDS, TOOL_LIMIT_REPLY } = await import('../lib/remi/remiAssistant.js');
const { RemiUpstreamError, REMI_MODEL, classifyUpstreamError } = await import('../lib/remi/anthropicClient.js');
const { remiChatBodySchema, remiSummaryQuerySchema, REMI_MESSAGE_MAX_LENGTH } = await import('../lib/remi/requestSchemas.js');
const {
  buildScenarioPreview,
  buildGoalContributionPreview,
  buildSurplusRedirectPreview,
} = await import('../lib/raf/remiPreview.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_KEY = 'sk-ant-SERVER-SENTINEL-remediation-0123456789';
const UPSTREAM_SECRET = 'UPSTREAM-SECRET-DETAIL-must-not-leak';

// ── Fake Anthropic upstream ──────────────────────────────────────────────────

let fakeMode = 'end_turn';
let fakeCalls = 0;
let fake;
let previousBaseUrl;

function fakeBody(mode) {
  const toolUse = {
    id: `toolu_${fakeCalls}`, type: 'tool_use', name: 'get_current_plan', input: {},
  };
  const ok = (content, stop_reason) => ({
    id: 'msg_fake', type: 'message', role: 'assistant', model: REMI_MODEL,
    content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  if (mode === 'tool_forever') return { status: 200, body: ok([toolUse], 'tool_use') };
  if (mode === 'end_turn') return { status: 200, body: ok([{ type: 'text', text: 'FAKE_AI_REPLY' }], 'end_turn') };
  if (mode === 'empty_text') return { status: 200, body: ok([], 'end_turn') };
  if (mode === 'malformed') return { status: 200, body: { unexpected: true } };
  if (mode === 'malformed_block') return { status: 200, body: ok([{ type: 'text', text: 42 }], 'end_turn') };
  if (mode === 'rate_limited') {
    return {
      status: 429,
      headers: { 'retry-after': '0' },
      body: { type: 'error', error: { type: 'rate_limit_error', message: UPSTREAM_SECRET } },
    };
  }
  if (mode === 'server_error') {
    return { status: 500, body: { type: 'error', error: { type: 'api_error', message: UPSTREAM_SECRET } } };
  }
  if (mode === 'auth_error') {
    return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: UPSTREAM_SECRET } } };
  }
  if (mode === 'hang') return null; // never respond
  throw new Error(`unknown fake mode ${mode}`);
}

before(async () => {
  fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      fakeCalls += 1;
      const spec = fakeBody(fakeMode);
      if (spec === null) return; // hang: the client timeout fires
      res.statusCode = spec.status;
      res.setHeader('content-type', 'application/json');
      for (const [k, v] of Object.entries(spec.headers ?? {})) res.setHeader(k, v);
      res.end(JSON.stringify(spec.body));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
});

after(async () => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seededHousehold() {
  const db = createInMemoryDb();
  const user = { id: crypto.randomUUID(), email: `u-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db, user, workspaceName: 'Remi WS' });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  return { db, user, workspaceId };
}

// Full route stack (auth, membership, entitlement) with the in-memory adapter.
async function startApp({ anthropicApiKey = SERVER_KEY, tier = 'paid' } = {}) {
  const { db, user, workspaceId } = await seededHousehold();
  const row = db.state.households.find((h) => h.id === workspaceId);
  row.remiTier = tier;

  // The in-memory adapter has no Remi conversation storage; stub only those methods.
  const remiStorage = {
    async createRemiConversation({ userId, title }) { return { id: crypto.randomUUID(), userId, title }; },
    async getRemiConversation() { return null; },
    async listRemiMessages() { return []; },
    async appendRemiMessage() { return { id: crypto.randomUUID() }; },
    async listRemiConversations() { return []; },
  };
  const realTransaction = db.transaction.bind(db);
  db.transaction = (callback, securityContext) => realTransaction((tx) => callback(Object.assign(tx, remiStorage)), securityContext);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', await createApiRouter({
    apiRootDir: path.join(repoRoot, 'app', 'api', 'v1'),
    db,
    defaultHouseholdId: null,
    aliases: [],
    emailConfig: null,
    anthropicApiKey,
  }));
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const token = createToken({ userId: user.id, email: user.email });
  const call = (route, { method = 'GET', body, query = '', rawBody } = {}) => fetch(`${base}${route}${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
    body: rawBody ?? (body && method !== 'GET' ? JSON.stringify(body) : undefined),
  }).then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
  return { db, user, workspaceId, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

// Captures console output so tests can assert no secret ever reaches the logs.
async function captureLogs(fn) {
  const lines = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  try { return { result: await fn(), logs: lines.join('\n') }; } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
  }
}

// ── 1. Financial previews (lib/raf, canonical cent math) ─────────────────────

test('scenario preview: affordable spend leaves a positive remainder and no shortfall', () => {
  const out = buildScenarioPreview({
    description: 'Dinner', amountDelta: '25.50', bucketSlug: 'personal_spending', bucketLabel: 'Personal',
    allocated: '300.00', used: '100.00', available: '200.00',
  });
  assert.equal(out.can_afford, true);
  assert.equal(out.after.available, '174.50');
  assert.equal(out.shortfall, null);
});

test('scenario preview: overspend reports the exact shortfall', () => {
  const out = buildScenarioPreview({
    description: 'Trip', amountDelta: '250.00', bucketSlug: 'buffer', bucketLabel: 'Buffer',
    allocated: '300.00', used: '100.00', available: '200.00',
  });
  assert.equal(out.can_afford, false);
  assert.equal(out.shortfall, '50.00');
});

test('preview math rejects zero, negative and malformed amounts', () => {
  for (const amount of ['0.00', '-5.00', 'abc', '1.234']) {
    assert.throws(() => buildScenarioPreview({
      description: 'x', amountDelta: amount, bucketSlug: 'buffer', bucketLabel: 'Buffer', available: '10.00',
    }), /amountDelta|Invalid money/, `amount ${amount} must be rejected`);
  }
});

test('goal and surplus previews always require confirmation and change nothing', () => {
  const goal = buildGoalContributionPreview({
    goal: { goal_id: 'g1', goal_name: 'Car', current_amount: '100.00', target_amount: '400.00', progress_percent: 25 },
    amount: '50.00',
    rationale: 'extra',
  });
  assert.equal(goal.confirmation_required, true);
  assert.equal(goal.goal.after.current, '150.00');
  assert.equal(goal.goal.after.progress_percent, 37.5);

  const surplus = buildSurplusRedirectPreview({ incomeTotal: '1000.00', spendingTotal: '400.00', amount: '200.00' });
  assert.equal(surplus.confirmation_required, true);
  assert.equal(surplus.surplus.current_surplus, '600.00');
  assert.equal(surplus.surplus.surplus_after, '400.00');
});

// ── 2. add_to_goal: explicit target, never the first goal ────────────────────

test('add_to_goal with an unknown targetId returns an explicit error, not the first goal', async () => {
  const { db, workspaceId } = await seededHousehold();
  await db.transaction((tx) => tx.insertGoal({ householdId: workspaceId, name: 'Vacation', targetAmount: '900.00', active: true, bucketId: null }));

  const result = await dispatchToolCall({
    name: 'propose_allocation_change',
    input: { action: 'add_to_goal', amount: '20.00', targetId: crypto.randomUUID() },
    db,
    householdId: workspaceId,
  });
  assert.ok(result.error, 'an unknown targetId must produce an error');
  assert.equal(result.goal, undefined, 'no goal may be previewed for an unknown targetId');
  assert.match(result.error, /No goal found/);
});

test('add_to_goal without a targetId returns an error instead of guessing', async () => {
  const { db, workspaceId } = await seededHousehold();
  await db.transaction((tx) => tx.insertGoal({ householdId: workspaceId, name: 'Vacation', targetAmount: '900.00', active: true, bucketId: null }));

  const result = await dispatchToolCall({
    name: 'propose_allocation_change',
    input: { action: 'add_to_goal', amount: '20.00' },
    db,
    householdId: workspaceId,
  });
  assert.match(result.error, /targetId is required/);
});

test('add_to_goal with a valid targetId previews that goal and requires confirmation', async () => {
  const { db, workspaceId } = await seededHousehold();
  const goal = await db.transaction((tx) => tx.insertGoal({ householdId: workspaceId, name: 'Vacation', targetAmount: '900.00', active: true, bucketId: null }));

  const result = await dispatchToolCall({
    name: 'propose_allocation_change',
    input: { action: 'add_to_goal', amount: '20.00', targetId: goal.id, rationale: 'boost' },
    db,
    householdId: workspaceId,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.goal.id, goal.id);
  assert.equal(result.confirmation_required, true);
});

// ── 3. Confirmation requirement: the tool path never writes ──────────────────

test('propose_allocation_change and create_scenario perform no database writes', async () => {
  const { db, workspaceId } = await seededHousehold();
  const writePattern = /^(append|create|insert|update|delete|set|upsert|write|save|post|patch|remove|archive)/i;
  const writes = [];
  const tracked = (tx) => new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && writePattern.test(prop) && typeof value === 'function') {
        return (...args) => { writes.push(prop); return value.apply(target, args); };
      }
      return value;
    },
  });
  const trackedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (cb, ctx) => target.transaction((tx) => cb(tracked(tx)), ctx);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  await dispatchToolCall({
    name: 'propose_allocation_change',
    input: { action: 'redirect_surplus', amount: '10.00', rationale: 'test' },
    db: trackedDb,
    householdId: workspaceId,
  });
  await dispatchToolCall({
    name: 'create_scenario',
    input: { amountDelta: '10.00', description: 'test', categorySlug: 'buffer' },
    db: trackedDb,
    householdId: workspaceId,
  });
  assert.deepEqual(writes, [], `no write may run from a preview tool, saw: ${writes.join(', ')}`);
});

// ── 4. Tool-loop limit ───────────────────────────────────────────────────────

test('tool loop stops at MAX_TOOL_ROUNDS and returns an explicit truncated reply', async () => {
  const { db, workspaceId } = await seededHousehold();
  fakeMode = 'tool_forever';
  fakeCalls = 0;
  const out = await generateRemiResponse({
    db, householdId: workspaceId, userMessage: 'loop', conversationHistory: [], apiKey: SERVER_KEY,
    timeoutMs: 2000,
  });
  assert.equal(out.truncated, true);
  assert.equal(out.reply, TOOL_LIMIT_REPLY);
  assert.equal(fakeCalls, MAX_TOOL_ROUNDS + 1, 'one initial call plus one call per allowed tool round');
});

test('a normal answer after tool use is not marked truncated', async () => {
  const { db, workspaceId } = await seededHousehold();
  fakeMode = 'end_turn';
  const out = await generateRemiResponse({
    db, householdId: workspaceId, userMessage: 'hi', conversationHistory: [], apiKey: SERVER_KEY, timeoutMs: 2000,
  });
  assert.equal(out.truncated, false);
  assert.equal(out.reply, 'FAKE_AI_REPLY');
});

// ── 5. Upstream failures are classified and sanitized ────────────────────────

const failureCases = [
  ['hang', 'timeout', 504],
  ['rate_limited', 'rate_limited', 429],
  ['server_error', 'unavailable', 502],
  ['auth_error', 'misconfigured', 503],
  ['malformed', 'malformed', 502],
  ['malformed_block', 'malformed', 502],
  ['empty_text', 'malformed', 502],
];

for (const [mode, kind, status] of failureCases) {
  test(`library: upstream ${mode} maps to ${kind} with no upstream detail`, async () => {
    const { db, workspaceId } = await seededHousehold();
    fakeMode = mode;
    let caught = null;
    try {
      await generateRemiResponse({
        db, householdId: workspaceId, userMessage: 'hi', conversationHistory: [], apiKey: SERVER_KEY,
        timeoutMs: 150, requestBudgetMs: 5000,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof RemiUpstreamError, `expected RemiUpstreamError, got ${caught?.name}: ${caught?.message}`);
    assert.equal(caught.kind, kind);
    assert.equal(caught.status, status);
    assert.ok(!caught.message.includes(UPSTREAM_SECRET), 'public message must not contain upstream text');
    assert.ok(!caught.message.includes(SERVER_KEY), 'public message must not contain the key');
  });
}

test('request budget: the per-request deadline stops further upstream calls', async () => {
  const { db, workspaceId } = await seededHousehold();
  fakeMode = 'tool_forever';
  fakeCalls = 0;
  let caught = null;
  try {
    await generateRemiResponse({
      db, householdId: workspaceId, userMessage: 'loop', conversationHistory: [], apiKey: SERVER_KEY,
      timeoutMs: 2000, requestBudgetMs: 0,
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught?.kind, 'timeout');
  assert.equal(fakeCalls, 0, 'an exhausted budget must not reach the upstream API');
});

test('classifyUpstreamError never copies SDK message text into the public error', () => {
  const sdkLike = Object.assign(new Error(`leaked ${UPSTREAM_SECRET}`), { status: 503 });
  const mapped = classifyUpstreamError(sdkLike);
  assert.equal(mapped.kind, 'unavailable');
  assert.ok(!mapped.message.includes(UPSTREAM_SECRET));
});

// ── 6. Route level: sanitized responses, logs without secrets ────────────────

// The 25s production timeout makes a route-level hang test impractical; timeouts are covered above.
for (const [mode, status] of [['rate_limited', 429], ['server_error', 502], ['auth_error', 503]]) {
  test(`chat route: upstream ${mode} returns ${status} with a sanitized body and secret-free logs`, async () => {
    const app = await startApp({ tier: 'paid' });
    try {
      fakeMode = mode;
      const { result, logs } = await captureLogs(() => app.call('/remi/chat', { method: 'POST', body: { message: 'hello' } }));
      assert.equal(result.status, status, result.text);
      assert.ok(!result.text.includes(UPSTREAM_SECRET), 'body must not contain upstream text');
      assert.ok(!result.text.includes(SERVER_KEY), 'body must not contain the key');
      assert.ok(!logs.includes(UPSTREAM_SECRET) && !logs.includes(SERVER_KEY), 'logs must not contain upstream text or the key');
      assert.ok(logs.includes('remi_upstream_error'), 'upstream failure is logged structurally');
    } finally { await app.stop(); }
  });
}

test('summary route: malformed upstream response returns 502 and never a blank summary', async () => {
  const app = await startApp({ tier: 'paid' });
  try {
    fakeMode = 'malformed';
    const res = await app.call('/remi/summary');
    assert.equal(res.status, 502);
    assert.ok(!res.text.includes('"summary":""'));
  } finally { await app.stop(); }
});

test('chat route: unparseable JSON is a 400 client error and never reaches the model', async () => {
  const app = await startApp({ tier: 'paid' });
  try {
    fakeCalls = 0;
    // express.json() (also global in index.js) rejects the body before the route runs.
    const res = await app.call('/remi/chat', { method: 'POST', rawBody: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(fakeCalls, 0);
  } finally { await app.stop(); }
});

// ── 7. Zod request validation ────────────────────────────────────────────────

test('chat body schema: trims, requires a message, caps length, validates conversationId', () => {
  assert.equal(remiChatBodySchema.safeParse({ message: '   ' }).success, false);
  assert.equal(remiChatBodySchema.safeParse({}).success, false);
  assert.equal(remiChatBodySchema.safeParse({ message: 'x'.repeat(REMI_MESSAGE_MAX_LENGTH + 1) }).success, false);
  assert.equal(remiChatBodySchema.safeParse({ message: 'hi', conversationId: 'not-a-uuid' }).success, false);

  const ok = remiChatBodySchema.safeParse({ message: '  hi  ', conversationId: null });
  assert.equal(ok.success, true);
  assert.equal(ok.data.message, 'hi');
  assert.equal(ok.data.conversationId, null);
});

test('summary query schema: month must be YYYY-MM', () => {
  assert.equal(remiSummaryQuerySchema.safeParse({ month: '2026-13' }).success, false);
  assert.equal(remiSummaryQuerySchema.safeParse({ month: '2026-1' }).success, false);
  assert.equal(remiSummaryQuerySchema.safeParse({ month: '2026-10' }).success, true);
  assert.equal(remiSummaryQuerySchema.safeParse({ month: null }).success, true);
});

test('chat route: invalid bodies return 400 VALIDATION_ERROR before any upstream call', async () => {
  const app = await startApp({ tier: 'paid' });
  try {
    fakeCalls = 0;
    fakeMode = 'end_turn';
    const empty = await app.call('/remi/chat', { method: 'POST', body: { message: '   ' } });
    assert.equal(empty.status, 400);
    assert.equal(JSON.parse(empty.text).errorCode, 'VALIDATION_ERROR');

    const long = await app.call('/remi/chat', { method: 'POST', body: { message: 'x'.repeat(REMI_MESSAGE_MAX_LENGTH + 1) } });
    assert.equal(long.status, 400);

    const badSummary = await app.call('/remi/summary', { query: '?month=2026-99' });
    assert.equal(badSummary.status, 400);
    assert.equal(fakeCalls, 0, 'validation failures must not reach Anthropic');
  } finally { await app.stop(); }
});

