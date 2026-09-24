/**
 * Viewer write-denial regression tests.
 *
 * Phase 1 proof: empirically verify that a viewer-role user is denied (403)
 * on every workspace-scoped financial write route.
 *
 * Phase 3 regression: these tests are the standing guard so this protection
 * is verified on every run, not just assumed from code inspection.
 *
 * Addresses the finding in Pre-D Verification Round 1 that test 342
 * ("Viewer cannot write financial data") never exercised a viewer token.
 *
 * The enforcement mechanism lives in lib/server/routerLoader.js —
 * requiredPermissionForRoute() returns 'financial:write' (or 'imports:write')
 * for non-GET requests on financial/import routes, and the router checks
 * roleHasPermission(req.auth.role, requiredPermission) before calling any
 * route handler. Viewer role lacks financial:write and imports:write.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
let baseUrl;
let serverProcess;


async function request(pathname, { method = 'GET', token, workspaceId, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function signup(email, householdName = 'Test Household') {
  const { status, data } = await request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email, password: 'ViewerTest1!', householdName },
  });
  assert.equal(status, 201, `signup failed for ${email}: ${JSON.stringify(data)}`);
  return { token: data.token, workspaceId: data.workspace.id, userId: data.userId };
}

// Shared state: owner + a viewer who has accepted an invitation to the owner's workspace.
let owner;
let viewer;

before(async () => {
  serverProcess = await startIsolatedSqliteServer({
    repoRoot,
    testName: 'raf-viewer-write-denial',
    authRequired: true,
    jwtSecret: 'raf-viewer-write-denial-secret',
    extraEnv: {
      RAF_AUTH_PROVIDER: 'local',
      RAF_AUTH_RATE_LIMIT_MAX: '1000',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
    },
  });
  baseUrl = serverProcess.baseUrl;

  // Create owner workspace
  owner = await signup('vwr-owner@example.com', 'Owner Workspace');

  // Create viewer's own account (they need an account to accept)
  viewer = await signup('vwr-viewer@example.com', 'Viewer Own Workspace');

  // Owner invites viewer with role 'viewer'
  const invRes = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
    method: 'POST',
    token: owner.token,
    workspaceId: owner.workspaceId,
    body: { email: 'vwr-viewer@example.com', role: 'viewer' },
  });
  assert.equal(invRes.status, 201, `invitation failed: ${JSON.stringify(invRes.data)}`);
  const rawToken = invRes.data.invitation.rawToken;

  // Viewer accepts the invitation — auth is optional on this route
  const acceptRes = await request(`/api/v1/invitations/${rawToken}/accept`, {
    method: 'POST',
    token: viewer.token,
    workspaceId: viewer.workspaceId,
  });
  assert.equal(acceptRes.status, 200, `accept failed: ${JSON.stringify(acceptRes.data)}`);
  assert.equal(acceptRes.data.role, 'viewer', 'accepted role must be viewer');
});

after(async () => {
  await serverProcess?.stop();
});

// ─── PHASE 1 PROOF + PHASE 3 REGRESSION ──────────────────────────────────────
// Each test: viewer sends a write request → must get 403.
// The permission check fires in routerLoader.js before any route handler runs,
// so body content is irrelevant to the 403 outcome.

test('Viewer cannot POST /transactions (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/transactions', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { transactionDate: '2026-01-01', description: 'Viewer write attempt', amount: '1.00', direction: 'debit' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /transactions, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /income (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/income', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { sourceName: 'Viewer income', amount: '1.00', receivedDate: '2026-01-01' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /income, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /debts (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/debts', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Viewer debt', startingBalance: '100.00' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /debts, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /goals (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/goals', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Viewer goal', targetAmount: '1000.00' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /goals, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /financial-accounts (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/financial-accounts', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Viewer account', type: 'chequing' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /financial-accounts, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /household/fixed-bills (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/household/fixed-bills', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Viewer bill', amount: '50.00' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /household/fixed-bills, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot PATCH /household (financial:write denied)', async () => {
  const { status, data } = await request(`/api/v1/workspaces/${owner.workspaceId}`, {
    method: 'PATCH',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Viewer rename attempt' },
  });
  // workspace:update is also not a viewer permission — still 403
  assert.equal(status, 403, `Expected 403 for viewer PATCH /workspaces/:id, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /monthly-reviews/apply (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/monthly-reviews/apply', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { month: '2026-01-01' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /monthly-reviews/apply, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /merchant-rules (imports:write denied)', async () => {
  const { status, data } = await request('/api/v1/merchant-rules', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { pattern: 'test', categorySlug: 'food' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /merchant-rules, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot POST /scenarios (financial:write denied)', async () => {
  const { status, data } = await request('/api/v1/scenarios', {
    method: 'POST',
    token: viewer.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Viewer scenario' },
  });
  assert.equal(status, 403, `Expected 403 for viewer POST /scenarios, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot GET /remi/conversations (remi:invoke denied)', async () => {
  const { status, data } = await request('/api/v1/remi/conversations', {
    method: 'GET',
    token: viewer.token,
    workspaceId: owner.workspaceId,
  });
  assert.equal(status, 403, `Expected 403 for viewer GET /remi/conversations, got ${status}: ${JSON.stringify(data)}`);
});

test('Viewer cannot GET /remi/conversations/:id (remi:invoke denied)', async () => {
  const { status, data } = await request('/api/v1/remi/conversations/nonexistent-id', {
    method: 'GET',
    token: viewer.token,
    workspaceId: owner.workspaceId,
  });
  assert.equal(status, 403, `Expected 403 for viewer GET /remi/conversations/:id, got ${status}: ${JSON.stringify(data)}`);
});

// ─── OWNER REGRESSION: legitimate write access must not be broken ─────────────

test('Owner can still POST /transactions (financial:write allowed)', async () => {
  const { status, data } = await request('/api/v1/transactions', {
    method: 'POST',
    token: owner.token,
    workspaceId: owner.workspaceId,
    body: { transactionDate: '2026-01-01', description: 'Owner write', amount: '10.00', direction: 'debit' },
  });
  assert.ok([200, 201].includes(status), `Owner POST /transactions failed — got ${status}: ${JSON.stringify(data)}`);
});

test('Owner can still POST /income (financial:write allowed)', async () => {
  const { status, data } = await request('/api/v1/income', {
    method: 'POST',
    token: owner.token,
    workspaceId: owner.workspaceId,
    body: { sourceName: 'Owner salary', amount: '5000.00', receivedDate: '2026-01-01' },
  });
  assert.ok([200, 201].includes(status), `Owner POST /income failed — got ${status}: ${JSON.stringify(data)}`);
});

test('Owner can still POST /goals (financial:write allowed — 403 must not occur)', async () => {
  const { status, data } = await request('/api/v1/goals', {
    method: 'POST',
    token: owner.token,
    workspaceId: owner.workspaceId,
    body: { name: 'Emergency fund', targetAmount: '10000.00' },
  });
  // 400 = passed auth but route validation rejected body — acceptable, proves no 403 block
  assert.ok(![401, 403].includes(status), `Owner must not be forbidden from POST /goals, got ${status}: ${JSON.stringify(data)}`);
});

// ─── VIEWER READ: viewer read access must still work ─────────────────────────

test('Viewer can still GET /transactions (financial:read allowed — 403 must not occur)', async () => {
  const { status, data } = await request('/api/v1/transactions?from=2026-01-01&to=2026-12-31', {
    method: 'GET',
    token: viewer.token,
    workspaceId: owner.workspaceId,
  });
  // 403/401 would indicate the viewer's read permission is also broken
  assert.ok(![401, 403].includes(status), `Viewer must not be forbidden from GET /transactions, got ${status}: ${JSON.stringify(data)}`);
});
