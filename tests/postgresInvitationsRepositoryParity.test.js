/**
 * Track A — Invitations Repository Parity Test
 *
 * Exercises buildInvitationsRepository against a stateful mock client to verify
 * that all 5 methods honour the inMemoryDb contract:
 *
 *   createWorkspaceInvitation  — persists row, normalises email, revokes superseded pending invite
 *   getWorkspaceInvitationByToken — token lookup; null on miss
 *   getWorkspaceInvitationById    — id lookup; null on miss
 *   listWorkspaceInvitations       — workspace-scoped; optional status filter
 *   updateWorkspaceInvitation      — general patch; returns null for unknown id
 *
 * No real PostgreSQL connection required — all client.query() calls are
 * intercepted by a stateful mock that mirrors the SQL semantics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInvitationsRepository } from '../lib/repositories/postgres/invitationsRepository.js';

const SCHEMA = 'raf';

const WS_A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const USER_1 = '11111111-0000-4000-8000-111111111111';
const TOKEN_1 = 'tok-aaaa';
const TOKEN_2 = 'tok-bbbb';
const EXPIRES = '2099-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Stateful mock client
// ---------------------------------------------------------------------------

function makeMockClient() {
  const rows = [];
  let callCount = 0;

  function matchRows(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();

    // UPDATE … SET status='revoked' WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='pending'
    if (/UPDATE.*SET STATUS = 'REVOKED'/.test(s)) {
      const [wsId, email] = params;
      rows
        .filter(r => r.workspace_id === wsId && r.email.toLowerCase() === email.toLowerCase() && r.status === 'pending')
        .forEach(r => { r.status = 'revoked'; });
      return { rows: [] };
    }

    // UPDATE … SET status=$2, role=$3, expires_at=$4 WHERE id=$1 RETURNING
    // Must come before SELECT-by-id since both contain WHERE ID = $1
    if (/^UPDATE.*SET STATUS = \$2/.test(s)) {
      const [id, status, role, expires_at] = params;
      const row = rows.find(r => r.id === id);
      if (!row) return { rows: [] };
      Object.assign(row, { status, role, expires_at, updated_at: new Date().toISOString() });
      return { rows: [row] };
    }

    // INSERT INTO … RETURNING
    if (/^INSERT INTO/.test(s)) {
      const [id, workspace_id, invited_by, email, role, token, expires_at, created_at] = params;
      const row = { id, workspace_id, invited_by, email, role, token, status: 'pending', expires_at, created_at, updated_at: created_at };
      rows.push(row);
      return { rows: [row] };
    }

    // SELECT … FROM schema.resolve_invitation_by_token($1)
    // (SECURITY DEFINER resolver — simulates lazy expiry; does not return token column)
    if (/RESOLVE_INVITATION_BY_TOKEN/.test(s)) {
      const found = rows.find(r => r.token === params[0]) ?? null;
      if (!found) return { rows: [] };
      // Simulate lazy expiry: if pending and expired, mark expired
      if (found.status === 'pending' && found.expires_at < new Date().toISOString()) {
        found.status = 'expired';
      }
      // Return row without token column (matches real function's RETURNS TABLE)
      const { token: _omit, ...withoutToken } = found;
      return { rows: [withoutToken] };
    }

    // SELECT … WHERE id = $1
    if (/^SELECT.*WHERE ID = \$1/.test(s)) {
      const found = rows.find(r => r.id === params[0]) ?? null;
      return { rows: found ? [found] : [] };
    }

    // SELECT … WHERE workspace_id = $1 AND status = $2
    if (/^SELECT.*WHERE WORKSPACE_ID = \$1.*AND STATUS = \$/.test(s)) {
      const [wsId, status] = params;
      return { rows: rows.filter(r => r.workspace_id === wsId && r.status === status) };
    }

    // SELECT … WHERE workspace_id = $1 (no status filter)
    if (/^SELECT.*WHERE WORKSPACE_ID = \$1/.test(s)) {
      return { rows: rows.filter(r => r.workspace_id === params[0]) };
    }

    return { rows: [] };
  }

  const client = {
    async query(sql, params = []) {
      callCount++;
      return matchRows(sql, params);
    },
    get callCount() { return callCount; },
    snapshot() { return rows.map(r => ({ ...r })); },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(client) {
  return buildInvitationsRepository(client, SCHEMA);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('createWorkspaceInvitation — returns row with expected shape', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const result = await repo.createWorkspaceInvitation({
    workspaceId: WS_A,
    invitedBy: USER_1,
    email: 'Alice@Example.COM',
    role: 'member',
    token: TOKEN_1,
    expiresAt: EXPIRES,
  });

  assert.ok(result, 'result must be non-null');
  assert.equal(typeof result.id, 'string');
  assert.equal(result.workspaceId, WS_A);
  assert.equal(result.invitedBy, USER_1);
  assert.equal(result.email, 'alice@example.com', 'email must be normalised to lowercase');
  assert.equal(result.role, 'member');
  assert.equal(result.token, TOKEN_1);
  assert.equal(result.status, 'pending');
  assert.equal(result.expiresAt, EXPIRES);
  assert.ok(result.createdAt, 'createdAt must be present');
  assert.ok(result.updatedAt, 'updatedAt must be present');
});

test('createWorkspaceInvitation — supersedes existing pending invite for same workspace+email', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  // First invite
  const first = await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'bob@example.com',
    role: 'member', token: TOKEN_1, expiresAt: EXPIRES,
  });

  // Second invite for same workspace+email → must revoke first
  const second = await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'BOB@EXAMPLE.COM',
    role: 'admin', token: TOKEN_2, expiresAt: EXPIRES,
  });

  assert.equal(second.status, 'pending');
  assert.equal(second.token, TOKEN_2);

  // The first row should now be revoked
  const snapshot = client.snapshot();
  const firstRow = snapshot.find(r => r.id === first.id);
  assert.equal(firstRow.status, 'revoked', 'old pending invite must be revoked');
  const pendingForWs = snapshot.filter(r => r.workspace_id === WS_A && r.status === 'pending');
  assert.equal(pendingForWs.length, 1, 'exactly one pending invite per workspace+email after supersede');
});

test('getWorkspaceInvitationByToken — returns row on hit', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'carol@example.com',
    role: 'member', token: TOKEN_1, expiresAt: EXPIRES,
  });

  const found = await repo.getWorkspaceInvitationByToken({ token: TOKEN_1 });
  assert.ok(found, 'must return row for known token');
  assert.equal(found.token, TOKEN_1);
  assert.equal(found.workspaceId, WS_A);
});

test('getWorkspaceInvitationByToken — returns null on miss', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const found = await repo.getWorkspaceInvitationByToken({ token: 'no-such-token' });
  assert.equal(found, null);
});

test('getWorkspaceInvitationById — returns row on hit', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const created = await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'dave@example.com',
    role: 'member', token: TOKEN_1, expiresAt: EXPIRES,
  });

  const found = await repo.getWorkspaceInvitationById({ invitationId: created.id });
  assert.ok(found);
  assert.equal(found.id, created.id);
});

test('getWorkspaceInvitationById — returns null on miss', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const found = await repo.getWorkspaceInvitationById({ invitationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  assert.equal(found, null);
});

test('listWorkspaceInvitations — returns all rows for workspace when no status filter', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'e1@example.com',
    role: 'member', token: 'tok-e1', expiresAt: EXPIRES,
  });
  // Supersede so WS_A has one revoked + one pending
  await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'e1@example.com',
    role: 'admin', token: 'tok-e2', expiresAt: EXPIRES,
  });
  // WS_B invite — must not appear in WS_A list
  await repo.createWorkspaceInvitation({
    workspaceId: WS_B, invitedBy: USER_1, email: 'other@example.com',
    role: 'member', token: 'tok-e3', expiresAt: EXPIRES,
  });

  const list = await repo.listWorkspaceInvitations({ workspaceId: WS_A });
  assert.equal(list.length, 2, 'both revoked and pending rows belong to WS_A');
  assert.ok(list.every(r => r.workspaceId === WS_A), 'workspace isolation: only WS_A rows');
});

test('listWorkspaceInvitations — status filter returns only matching rows', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  // Create one pending, then supersede it (creates revoked + new pending)
  await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'f1@example.com',
    role: 'member', token: 'tok-f1', expiresAt: EXPIRES,
  });
  await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'f1@example.com',
    role: 'admin', token: 'tok-f2', expiresAt: EXPIRES,
  });

  const pending = await repo.listWorkspaceInvitations({ workspaceId: WS_A, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');

  const revoked = await repo.listWorkspaceInvitations({ workspaceId: WS_A, status: 'revoked' });
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].status, 'revoked');
});

test('updateWorkspaceInvitation — patches status and returns updated row', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const created = await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'g1@example.com',
    role: 'member', token: TOKEN_1, expiresAt: EXPIRES,
  });

  const updated = await repo.updateWorkspaceInvitation({
    invitationId: created.id,
    patch: { status: 'accepted' },
  });

  assert.ok(updated);
  assert.equal(updated.id, created.id);
  assert.equal(updated.status, 'accepted');
  assert.equal(updated.workspaceId, WS_A);
});

test('updateWorkspaceInvitation — returns null for unknown id', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const result = await repo.updateWorkspaceInvitation({
    invitationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    patch: { status: 'accepted' },
  });
  assert.equal(result, null);
});

test('workspace isolation — WS_B invitations not visible to WS_A', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  await repo.createWorkspaceInvitation({
    workspaceId: WS_B, invitedBy: USER_1, email: 'h1@example.com',
    role: 'member', token: TOKEN_2, expiresAt: EXPIRES,
  });

  const list = await repo.listWorkspaceInvitations({ workspaceId: WS_A });
  assert.equal(list.length, 0, 'WS_A sees no rows when all invitations belong to WS_B');
});

test('return shape — all camelCase fields present on create result', async () => {
  const client = makeMockClient();
  const repo = makeRepo(client);

  const result = await repo.createWorkspaceInvitation({
    workspaceId: WS_A, invitedBy: USER_1, email: 'shape@example.com',
    role: 'member', token: TOKEN_1, expiresAt: EXPIRES,
  });

  const expected = ['id', 'workspaceId', 'invitedBy', 'email', 'role', 'token', 'status', 'expiresAt', 'createdAt', 'updatedAt'];
  for (const key of expected) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing field: ${key}`);
  }
  // No snake_case leakage
  for (const key of ['workspace_id', 'invited_by', 'expires_at', 'created_at', 'updated_at']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(result, key), `snake_case field leaked: ${key}`);
  }
});
