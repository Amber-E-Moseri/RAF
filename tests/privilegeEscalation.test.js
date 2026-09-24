import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function signup(email, householdName) {
  const { status, data } = await request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email, password: 'PrivEsc123!', householdName },
  });
  assert.equal(status, 201);
  return { token: data.token, workspaceId: data.workspace.id };
}

before(async () => {
  serverProcess = await startIsolatedSqliteServer({
    repoRoot,
    testName: 'raf-privilege-escalation',
    authRequired: true,
    jwtSecret: 'raf-privilege-escalation-secret',
    extraEnv: {
      RAF_AUTH_PROVIDER: 'local',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
    },
  });
  baseUrl = serverProcess.baseUrl;
});

after(async () => {
  await serverProcess?.stop();
});

test('PATCH /remi/upgrade returns 501 — no self-promotion to paid tier', async () => {
  const { token, workspaceId } = await signup('priv-esc-owner@example.com', 'Priv Esc Workspace');
  const { status } = await request('/api/v1/remi/upgrade', {
    method: 'PATCH',
    token,
    workspaceId,
    body: { tier: 'paid' },
  });
  assert.equal(status, 501, 'Expected 501 — upgrade endpoint must be disabled until Stripe is wired');
});

test('PATCH /remi/upgrade with no auth returns 401', async () => {
  const { status } = await request('/api/v1/remi/upgrade', {
    method: 'PATCH',
    body: { tier: 'paid' },
  });
  assert.ok([401, 403].includes(status), `Expected 401 or 403, got ${status}`);
});

test('Viewer cannot write financial data — viewer token gets 403, owner token gets 201', async () => {
  // Owner creates workspace
  const { token: ownerToken, workspaceId } = await signup('priv-esc-viewer-owner@example.com', 'Viewer Test');

  // Viewer creates their own account
  const { token: viewerToken, workspaceId: viewerWorkspaceId } =
    await signup('priv-esc-viewer@example.com', 'Viewer Own');

  // Owner invites viewer with role 'viewer'
  const invRes = await request(`/api/v1/workspaces/${workspaceId}/invitations`, {
    method: 'POST',
    token: ownerToken,
    workspaceId,
    body: { email: 'priv-esc-viewer@example.com', role: 'viewer' },
  });
  assert.equal(invRes.status, 201, `invitation failed: ${JSON.stringify(invRes.data)}`);
  const rawToken = invRes.data.invitation.rawToken;

  // Viewer accepts the invitation
  const acceptRes = await request(`/api/v1/invitations/${rawToken}/accept`, {
    method: 'POST',
    token: viewerToken,
    workspaceId: viewerWorkspaceId,
  });
  assert.equal(acceptRes.status, 200, `accept failed: ${JSON.stringify(acceptRes.data)}`);
  assert.equal(acceptRes.data.role, 'viewer');

  // Viewer attempts to write — must be denied
  const viewerWrite = await request('/api/v1/transactions', {
    method: 'POST',
    token: viewerToken,
    workspaceId,   // owner's workspace, where viewer has viewer-role membership
    body: { transactionDate: '2026-01-01', description: 'Viewer write attempt', amount: '10.00', direction: 'debit' },
  });
  assert.equal(viewerWrite.status, 403, `Viewer must be denied financial:write, got ${viewerWrite.status}`);

  // Owner should still be able to write
  const ownerWrite = await request('/api/v1/transactions', {
    method: 'POST',
    token: ownerToken,
    workspaceId,
    body: { transactionDate: '2026-01-01', description: 'Owner write', amount: '10.00', direction: 'debit' },
  });
  assert.ok([200, 201].includes(ownerWrite.status), `Owner must be allowed financial:write, got ${ownerWrite.status}`);
});

test('Unauthenticated request to financial endpoint returns 401', async () => {
  const { status } = await request('/api/v1/transactions', { method: 'GET' });
  assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
});

test('Authenticated user without workspace header cannot access financial data', async () => {
  const { token } = await signup('priv-esc-noworkspace@example.com', 'No Workspace Test');
  // Send token but no workspace header
  const { status } = await request('/api/v1/transactions', {
    method: 'GET',
    token,
    // intentionally omit workspaceId
  });
  assert.ok([400, 401, 403].includes(status), `Expected 400/401/403 without workspace header, got ${status}`);
});
