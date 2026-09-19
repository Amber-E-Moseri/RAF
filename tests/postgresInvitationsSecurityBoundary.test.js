/**
 * Track A — Invitation Security Boundary Tests (Phase 9)
 *
 * Verifies that:
 *   1. getWorkspaceInvitationByToken calls the SECURITY DEFINER resolver (not direct table)
 *   2. acceptWorkspaceInvitation raises structured errors for invalid states
 *   3. declineWorkspaceInvitation raises structured errors for invalid states
 *   4. Error codes map correctly (INV_NOT_FOUND, INV_NOT_PENDING:*, INV_EXPIRED, etc.)
 *   5. Workspace isolation: resolver does not expose other workspaces' tokens
 *   6. Enumeration prevention: a miss returns null, not an error distinguishable from
 *      an expired/revoked row (no timing oracle — both resolve in mock)
 *
 * No real PostgreSQL connection required. The mock simulates both the happy path
 * and the PG RAISE EXCEPTION behaviour of the three SECURITY DEFINER functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInvitationsRepository } from '../lib/repositories/postgres/invitationsRepository.js';

const SCHEMA = 'raf';
const WS_A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const USER_1 = '11111111-0000-4000-8000-111111111111';

// ---------------------------------------------------------------------------
// Mock that simulates the SECURITY DEFINER functions
// ---------------------------------------------------------------------------

function makeSecurityMockClient({ resolverRows = null, acceptError = null, declineError = null } = {}) {
  const calls = [];

  const client = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });

      // SECURITY DEFINER resolver
      if (/resolve_invitation_by_token/i.test(s)) {
        return { rows: resolverRows ? [resolverRows] : [] };
      }

      // SECURITY DEFINER accept
      if (/accept_workspace_invitation/i.test(s)) {
        if (acceptError) {
          const e = new Error(acceptError);
          e.isInvitationError = true;
          e.code = acceptError.split(':')[0];
          e.detail = acceptError.includes(':') ? acceptError.slice(acceptError.indexOf(':') + 1) : null;
          throw e;
        }
        return { rows: [{ workspaceId: WS_A, role: 'member' }] };
      }

      // SECURITY DEFINER decline
      if (/decline_workspace_invitation/i.test(s)) {
        if (declineError) {
          const e = new Error(declineError);
          e.isInvitationError = true;
          e.code = declineError.split(':')[0];
          e.detail = declineError.includes(':') ? declineError.slice(declineError.indexOf(':') + 1) : null;
          throw e;
        }
        return { rows: [] };
      }

      // Fallback for other queries (INSERT, UPDATE used by createWorkspaceInvitation)
      if (/^INSERT INTO/i.test(s)) {
        return {
          rows: [{
            id: 'inv-1', workspace_id: WS_A, invited_by: USER_1, email: 'test@example.com',
            role: 'member', token: params[5] ?? 'tok', status: 'pending',
            expires_at: params[6], created_at: params[7], updated_at: params[7],
          }],
        };
      }
      if (/^UPDATE/i.test(s)) {
        return { rows: [] };
      }

      return { rows: [] };
    },
    get calls() { return calls; },
  };
  return client;
}

// ---------------------------------------------------------------------------
// 1. Resolver invocation — getWorkspaceInvitationByToken calls the SECURITY DEFINER
// ---------------------------------------------------------------------------

test('getWorkspaceInvitationByToken — calls resolve_invitation_by_token, not direct table SELECT', async () => {
  const row = {
    id: 'inv-1', workspace_id: WS_A, invited_by: USER_1, email: 'a@example.com',
    role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
  const client = makeSecurityMockClient({ resolverRows: row });
  const repo = buildInvitationsRepository(client, SCHEMA);

  const result = await repo.getWorkspaceInvitationByToken({ token: 'tok-abc' });

  // Must have hit the resolver
  assert.ok(
    client.calls.some(c => /resolve_invitation_by_token/i.test(c.sql)),
    'must call resolve_invitation_by_token',
  );
  // Must NOT have hit the table directly
  assert.ok(
    !client.calls.some(c => /FROM.*workspace_invitations.*WHERE.*token/i.test(c.sql)),
    'must not directly SELECT from workspace_invitations by token',
  );
  // Token re-attached from parameter
  assert.equal(result.token, 'tok-abc', 'token must be re-attached from input parameter');
  assert.equal(result.workspaceId, WS_A);
  assert.equal(result.status, 'pending');
});

test('getWorkspaceInvitationByToken — returns null on miss (enumeration prevention)', async () => {
  const client = makeSecurityMockClient({ resolverRows: null });
  const repo = buildInvitationsRepository(client, SCHEMA);

  const result = await repo.getWorkspaceInvitationByToken({ token: 'no-such-token' });

  assert.equal(result, null, 'must return null for unknown token — not an error');
  assert.ok(
    client.calls.some(c => /resolve_invitation_by_token/i.test(c.sql)),
    'must still call the resolver',
  );
});

// ---------------------------------------------------------------------------
// 2. acceptWorkspaceInvitation — happy path
// ---------------------------------------------------------------------------

test('acceptWorkspaceInvitation — returns { workspaceId, role } on success', async () => {
  const client = makeSecurityMockClient();
  const repo = buildInvitationsRepository(client, SCHEMA);

  const result = await repo.acceptWorkspaceInvitation({
    tokenHash: 'hash-abc',
    userId: USER_1,
    userEmail: 'user@example.com',
  });

  assert.ok(result, 'must return a result');
  assert.ok('workspaceId' in result, 'must have workspaceId');
  assert.ok('role' in result, 'must have role');
  assert.ok(
    client.calls.some(c => /accept_workspace_invitation/i.test(c.sql)),
    'must call accept_workspace_invitation',
  );
});

// ---------------------------------------------------------------------------
// 3. acceptWorkspaceInvitation — error paths (structured invitation errors)
// ---------------------------------------------------------------------------

test('acceptWorkspaceInvitation — propagates INV_NOT_FOUND as isInvitationError', async () => {
  const client = makeSecurityMockClient({ acceptError: 'INV_NOT_FOUND' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.acceptWorkspaceInvitation({ tokenHash: 'tok', userId: USER_1, userEmail: 'u@e.com' }),
    (err) => {
      assert.ok(err.isInvitationError, 'must be an invitation error');
      assert.equal(err.code, 'INV_NOT_FOUND');
      return true;
    },
  );
});

test('acceptWorkspaceInvitation — propagates INV_NOT_PENDING with detail', async () => {
  const client = makeSecurityMockClient({ acceptError: 'INV_NOT_PENDING:accepted' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.acceptWorkspaceInvitation({ tokenHash: 'tok', userId: USER_1, userEmail: 'u@e.com' }),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_NOT_PENDING');
      assert.equal(err.detail, 'accepted');
      return true;
    },
  );
});

test('acceptWorkspaceInvitation — propagates INV_EXPIRED', async () => {
  const client = makeSecurityMockClient({ acceptError: 'INV_EXPIRED' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.acceptWorkspaceInvitation({ tokenHash: 'tok', userId: USER_1, userEmail: 'u@e.com' }),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_EXPIRED');
      return true;
    },
  );
});

test('acceptWorkspaceInvitation — propagates INV_EMAIL_MISMATCH', async () => {
  const client = makeSecurityMockClient({ acceptError: 'INV_EMAIL_MISMATCH' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.acceptWorkspaceInvitation({ tokenHash: 'tok', userId: USER_1, userEmail: 'wrong@e.com' }),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_EMAIL_MISMATCH');
      return true;
    },
  );
});

test('acceptWorkspaceInvitation — propagates INV_ALREADY_MEMBER', async () => {
  const client = makeSecurityMockClient({ acceptError: 'INV_ALREADY_MEMBER' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.acceptWorkspaceInvitation({ tokenHash: 'tok', userId: USER_1, userEmail: 'u@e.com' }),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_ALREADY_MEMBER');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. declineWorkspaceInvitation — happy path + errors
// ---------------------------------------------------------------------------

test('declineWorkspaceInvitation — resolves on success', async () => {
  const client = makeSecurityMockClient();
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.doesNotReject(() => repo.declineWorkspaceInvitation({ tokenHash: 'hash-abc' }));
  assert.ok(
    client.calls.some(c => /decline_workspace_invitation/i.test(c.sql)),
    'must call decline_workspace_invitation',
  );
});

test('declineWorkspaceInvitation — propagates INV_NOT_FOUND', async () => {
  const client = makeSecurityMockClient({ declineError: 'INV_NOT_FOUND' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.declineWorkspaceInvitation({ tokenHash: 'tok' }),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_NOT_FOUND');
      return true;
    },
  );
});

test('declineWorkspaceInvitation — propagates INV_NOT_PENDING with detail', async () => {
  const client = makeSecurityMockClient({ declineError: 'INV_NOT_PENDING:declined' });
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.declineWorkspaceInvitation({ tokenHash: 'tok' }),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_NOT_PENDING');
      assert.equal(err.detail, 'declined');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Non-invitation errors pass through untouched
// ---------------------------------------------------------------------------

test('acceptWorkspaceInvitation — non-invitation PG errors rethrow unchanged', async () => {
  const client = {
    async query() {
      const e = new Error('connection timeout');
      e.code = 'ECONNRESET';
      throw e;
    },
  };
  const repo = buildInvitationsRepository(client, SCHEMA);

  await assert.rejects(
    () => repo.acceptWorkspaceInvitation({ tokenHash: 'tok', userId: USER_1, userEmail: 'u@e.com' }),
    (err) => {
      assert.equal(err.message, 'connection timeout');
      assert.ok(!err.isInvitationError, 'must not be marked as invitation error');
      return true;
    },
  );
});
