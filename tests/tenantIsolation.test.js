import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';

import { createAuthenticatedWorkspaceHeaders } from './helpers/authenticatedWorkspaceRequest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
let baseUrl;
let serverProcess;


async function request(pathname, { method = 'GET', token, workspaceId, headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token && workspaceId ? createAuthenticatedWorkspaceHeaders({ token, workspaceId }) : {}),
      ...(token && !workspaceId ? { authorization: `Bearer ${token}` } : {}),
      ...(!token && workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      ...headers,
    },
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

async function signup(email, householdName) {
  const { response, data } = await request('/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'TenantPass123!',
      householdName,
    }),
  });

  assert.equal(response.status, 201);
  return {
    token: data.token,
    userId: data.userId,
    workspaceId: data.workspace.id,
  };
}

before(async () => {
  serverProcess = await startIsolatedSqliteServer({
    repoRoot,
    testName: 'raf-tenant-isolation',
    authRequired: true,
    jwtSecret: 'raf-tenant-isolation-secret',
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

test('authenticated users can list only their active workspaces', async () => {
  const amber = await signup('amber@example.com', 'Amber Personal');
  const blake = await signup('blake@example.com', 'Blake Household');

  const amberWorkspaces = await request('/api/v1/workspaces', {
    token: amber.token,
    workspaceId: amber.workspaceId,
  });
  assert.equal(amberWorkspaces.response.status, 200);
  assert.deepEqual(amberWorkspaces.data.items.map((item) => item.id), [amber.workspaceId]);

  const blakeWorkspaces = await request('/api/v1/workspaces', {
    token: blake.token,
    workspaceId: blake.workspaceId,
  });
  assert.equal(blakeWorkspaces.response.status, 200);
  assert.deepEqual(blakeWorkspaces.data.items.map((item) => item.id), [blake.workspaceId]);
});

test('workspace headers alone do not authorize a production-router request', async () => {
  const amber = await signup('header-only@example.com', 'Header Only Household');

  const result = await request('/api/v1/transactions?from=2026-03-01&to=2026-03-31', {
    workspaceId: amber.workspaceId,
  });

  assert.equal(result.response.status, 401);
});

test('tenant isolation blocks cross-workspace reads, writes, reports, imports, debts, goals, and Remi', async () => {
  const amber = await signup('amber2@example.com', 'Amber Family');
  const blake = await signup('blake2@example.com', 'Blake Family');

  const createdTransaction = await request('/api/v1/transactions', {
    method: 'POST',
    token: amber.token,
    workspaceId: amber.workspaceId,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transactionDate: '2026-03-12',
      description: 'Amber groceries',
      amount: '42.00',
      direction: 'debit',
    }),
  });
  assert.equal(createdTransaction.response.status, 201);

  const amberCategories = await request('/api/v1/household/allocation-categories', {
    token: amber.token,
    workspaceId: amber.workspaceId,
  });
  assert.equal(amberCategories.response.status, 200);
  const amberSavingsBucket = amberCategories.data.items.find((item) => item.slug === 'savings');
  assert.ok(amberSavingsBucket);

  const createdGoal = await request('/api/v1/goals', {
    method: 'POST',
    token: amber.token,
    workspaceId: amber.workspaceId,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bucket_id: amberSavingsBucket.id,
      name: 'Amber emergency fund',
      target_amount: '1000.00',
    }),
  });
  assert.equal(createdGoal.response.status, 201);

  const createdDebt = await request('/api/v1/debts', {
    method: 'POST',
    token: amber.token,
    workspaceId: amber.workspaceId,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Amber Visa',
      startingBalance: '500.00',
      apr: 19,
      minimumPayment: '50.00',
      monthlyPayment: '75.00',
    }),
  });
  assert.equal(createdDebt.response.status, 201);

  for (const pathname of [
    '/api/v1/transactions?from=2026-03-01&to=2026-03-31',
    '/api/v1/goals',
    '/api/v1/debts',
    '/api/v1/imports',
    '/api/v1/reports/dashboard?from=2026-03-01&to=2026-03-31',
    '/api/v1/remi/chat',
  ]) {
    const method = pathname.includes('/remi/chat') ? 'POST' : 'GET';
    const result = await request(pathname, {
      method,
      token: blake.token,
      workspaceId: amber.workspaceId,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? JSON.stringify({ message: 'Summarize this workspace.' }) : undefined,
    });
    assert.equal(result.response.status, 403, `${method} ${pathname} should require workspace membership`);
  }

  const blakeReadOwnWorkspace = await request('/api/v1/transactions?from=2026-03-01&to=2026-03-31', {
    token: blake.token,
    workspaceId: blake.workspaceId,
  });
  assert.equal(blakeReadOwnWorkspace.response.status, 200);
  assert.equal(blakeReadOwnWorkspace.data.items.some((item) => item.id === createdTransaction.data.id), false);

  const mutateById = await request(`/api/v1/transactions/${createdTransaction.data.id}`, {
    method: 'PATCH',
    token: blake.token,
    workspaceId: blake.workspaceId,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'Stolen update' }),
  });
  assert.equal(mutateById.response.status, 404);

  const deleteDebtById = await request(`/api/v1/debts/${createdDebt.data.id}`, {
    method: 'DELETE',
    token: blake.token,
    workspaceId: blake.workspaceId,
  });
  assert.equal(deleteDebtById.response.status, 404);

  const updateGoalById = await request(`/api/v1/goals/${createdGoal.data.id}`, {
    method: 'PUT',
    token: blake.token,
    workspaceId: blake.workspaceId,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notes: 'Should not attach' }),
  });
  assert.equal(updateGoalById.response.status, 404);
});
