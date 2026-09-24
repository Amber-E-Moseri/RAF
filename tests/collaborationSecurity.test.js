/**
 * Collaboration security tests.
 * Covers: invitation lifecycle, email binding, cross-workspace isolation,
 * role escalation prevention, owner invariants, and post-removal access.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
let baseUrl;
let serverProcess;

async function request(pathname, { method = 'GET', token, workspaceId, headers = {}, body } = {}) {
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

async function signup(email, householdName = 'Test Household') {
  const { status, data } = await request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email, password: 'SecurePass1!', householdName },
  });
  assert.equal(status, 201, `signup failed for ${email}: ${JSON.stringify(data)}`);
  return { token: data.token, userId: data.userId, workspaceId: data.workspace.id };
}

before(async () => {
  serverProcess = await startIsolatedSqliteServer({
    repoRoot,
    testName: 'raf-collaboration-security',
    authRequired: true,
    jwtSecret: 'raf-collaboration-security-secret',
    extraEnv: {
      RAF_AUTH_PROVIDER: 'local',
      RAF_AUTH_RATE_LIMIT_MAX: '1000',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
    },
  });
  baseUrl = serverProcess.baseUrl;
});

after(async () => {
  await serverProcess?.stop();
});

// ─── Invitation Lifecycle ──────────────────────────────────────────────────────

describe('invitation lifecycle', () => {
  test('owner can invite a member and the token resolves publicly', async () => {
    const owner = await signup('inv-owner@test.com', 'Inv Owner House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-member@test.com', role: 'member' },
    });
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    const token = inv.data.invitation.rawToken;
    assert.ok(token, 'rawToken must be returned');

    const resolved = await request(`/api/v1/invitations/${token}`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.invitation.email, 'inv-member@test.com');
    assert.equal(resolved.data.workspace.id, owner.workspaceId);
  });

  test('accept with matching email creates membership', async () => {
    const owner = await signup('inv-accept-owner@test.com', 'Accept House');
    const member = await signup('inv-accept-member@test.com', 'Member House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-accept-member@test.com', role: 'member' },
    });
    const token = inv.data.invitation.rawToken;

    // Accept as the correct user (matching email)
    const accepted = await request(`/api/v1/invitations/${token}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.role, 'member');
  });

  test('accept without auth returns 401', async () => {
    const owner = await signup('inv-noauth-owner@test.com', 'NoAuth House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-noauth-member@test.com', role: 'member' },
    });
    const token = inv.data.invitation.rawToken;

    const result = await request(`/api/v1/invitations/${token}/accept`, { method: 'POST' });
    assert.equal(result.status, 401);
  });

  test('accept with wrong email returns 403', async () => {
    const owner = await signup('inv-mismatch-owner@test.com', 'Mismatch House');
    const wrong = await signup('inv-wrong-user@test.com', 'Wrong User House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'intended@test.com', role: 'member' },
    });
    const token = inv.data.invitation.rawToken;

    const result = await request(`/api/v1/invitations/${token}/accept`, {
      method: 'POST',
      token: wrong.token,
      workspaceId: wrong.workspaceId,
    });
    assert.equal(result.status, 403);
  });

  test('token is single-use — reuse after acceptance returns 410', async () => {
    const owner = await signup('inv-reuse-owner@test.com', 'Reuse House');
    const member = await signup('inv-reuse-member@test.com', 'Reuse Member');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-reuse-member@test.com', role: 'member' },
    });
    const token = inv.data.invitation.rawToken;

    await request(`/api/v1/invitations/${token}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });

    // Second attempt with same token
    const reuse = await request(`/api/v1/invitations/${token}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });
    assert.equal(reuse.status, 410);
  });

  test('revoked token returns 410', async () => {
    const owner = await signup('inv-revoke-owner@test.com', 'Revoke House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-revoke-target@test.com', role: 'member' },
    });
    const { rawToken, id: invId } = inv.data.invitation;

    await request(`/api/v1/workspaces/${owner.workspaceId}/invitations/${invId}`, {
      method: 'DELETE',
      token: owner.token,
      workspaceId: owner.workspaceId,
    });

    const resolved = await request(`/api/v1/invitations/${rawToken}`);
    assert.equal(resolved.status, 410);
  });

  test('declined token returns 410 on subsequent resolve', async () => {
    const owner = await signup('inv-decline-owner@test.com', 'Decline House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-decline-target@test.com', role: 'member' },
    });
    const token = inv.data.invitation.rawToken;

    await request(`/api/v1/invitations/${token}/decline`, { method: 'POST' });

    const resolved = await request(`/api/v1/invitations/${token}`);
    assert.equal(resolved.status, 410);
  });

  test('duplicate pending invitation is replaced, first token becomes invalid', async () => {
    const owner = await signup('inv-dup-owner@test.com', 'Dup House');

    const first = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-dup-target@test.com', role: 'member' },
    });
    const firstToken = first.data.invitation.rawToken;

    const second = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-dup-target@test.com', role: 'member' },
    });
    assert.equal(second.status, 201);

    // First token should now be revoked
    const firstResolved = await request(`/api/v1/invitations/${firstToken}`);
    assert.equal(firstResolved.status, 410);
  });

  test('malformed or unknown token returns 404', async () => {
    const result = await request('/api/v1/invitations/notarealtoken');
    assert.equal(result.status, 404);
  });

  test('accepting an invitation when already a member returns error', async () => {
    const owner = await signup('inv-already-owner@test.com', 'Already Member House');
    const member = await signup('inv-already-member@test.com', 'Already Member User');

    // First invite and accept
    const inv1 = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-already-member@test.com', role: 'member' },
    });
    const token1 = inv1.data.invitation.rawToken;
    await request(`/api/v1/invitations/${token1}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });

    // Second invite attempt for same user — createInvitation checks existing membership
    const inv2 = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'inv-already-member@test.com', role: 'member' },
    });
    assert.equal(inv2.status, 409, 'Should refuse invitation for existing member');
  });
});

// ─── Role Escalation Prevention ───────────────────────────────────────────────

describe('role escalation prevention', () => {
  test('admin cannot invite another admin', async () => {
    const owner = await signup('esc-owner@test.com', 'Esc House 1');
    const adminUser = await signup('esc-admin@test.com', 'Esc Admin House');

    // Owner invites admin
    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'esc-admin@test.com', role: 'admin' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: adminUser.token,
      workspaceId: adminUser.workspaceId,
    });

    // Admin tries to invite another admin
    const escalate = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: adminUser.token,
      workspaceId: owner.workspaceId,
      body: { email: 'esc-second-admin@test.com', role: 'admin' },
    });
    assert.equal(escalate.status, 403, 'Admin should not be able to invite admin');
  });

  test('admin cannot promote member to admin via PATCH', async () => {
    const owner = await signup('esc2-owner@test.com', 'Esc House 2');
    const adminUser = await signup('esc2-admin@test.com', 'Esc Admin 2');
    const memberUser = await signup('esc2-member@test.com', 'Esc Member 2');

    // Owner invites admin and member
    const invAdmin = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'esc2-admin@test.com', role: 'admin' },
    });
    await request(`/api/v1/invitations/${invAdmin.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: adminUser.token,
      workspaceId: adminUser.workspaceId,
    });

    const invMember = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'esc2-member@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${invMember.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: memberUser.token,
      workspaceId: memberUser.workspaceId,
    });

    // Admin tries to promote member to admin
    const escalate = await request(`/api/v1/workspaces/${owner.workspaceId}/members/${memberUser.userId}`, {
      method: 'PATCH',
      token: adminUser.token,
      workspaceId: owner.workspaceId,
      body: { role: 'admin' },
    });
    assert.equal(escalate.status, 403, 'Admin should not be able to promote member to admin');
  });

  test('nobody can set role=owner via PATCH — must use transfer-ownership', async () => {
    const owner = await signup('esc3-owner@test.com', 'Esc House 3');
    const memberUser = await signup('esc3-member@test.com', 'Esc Member 3');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'esc3-member@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: memberUser.token,
      workspaceId: memberUser.workspaceId,
    });

    // Even owner cannot set role=owner via PATCH
    const result = await request(`/api/v1/workspaces/${owner.workspaceId}/members/${memberUser.userId}`, {
      method: 'PATCH',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { role: 'owner' },
    });
    assert.equal(result.status, 409, 'Setting role=owner via PATCH must be blocked');
  });

  test('member cannot invite anyone', async () => {
    const owner = await signup('esc4-owner@test.com', 'Esc House 4');
    const memberUser = await signup('esc4-member@test.com', 'Esc Member 4');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'esc4-member@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: memberUser.token,
      workspaceId: memberUser.workspaceId,
    });

    const result = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: memberUser.token,
      workspaceId: owner.workspaceId,
      body: { email: 'anyone@test.com', role: 'viewer' },
    });
    assert.equal(result.status, 403);
  });
});

// ─── Owner Invariants ──────────────────────────────────────────────────────────

describe('owner invariants', () => {
  test('owner cannot be removed via DELETE member', async () => {
    const owner = await signup('own-rm-owner@test.com', 'Owner Remove House');
    const admin = await signup('own-rm-admin@test.com', 'Owner Remove Admin');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'own-rm-admin@test.com', role: 'admin' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: admin.token,
      workspaceId: admin.workspaceId,
    });

    // Admin tries to remove owner
    const result = await request(`/api/v1/workspaces/${owner.workspaceId}/members/${owner.userId}`, {
      method: 'DELETE',
      token: admin.token,
      workspaceId: owner.workspaceId,
    });
    assert.equal(result.status, 409, 'Owner removal must be blocked');
  });

  test('owner cannot leave without transferring ownership first', async () => {
    const owner = await signup('own-leave@test.com', 'Owner Leave House');
    const result = await request(`/api/v1/workspaces/${owner.workspaceId}/leave`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
    });
    assert.equal(result.status, 409);
  });

  test('owner cannot be demoted via PATCH', async () => {
    const owner = await signup('own-demote@test.com', 'Owner Demote House');
    const admin = await signup('own-demote-admin@test.com', 'Admin House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'own-demote-admin@test.com', role: 'admin' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: admin.token,
      workspaceId: admin.workspaceId,
    });

    // Try to demote the owner to member
    const result = await request(`/api/v1/workspaces/${owner.workspaceId}/members/${owner.userId}`, {
      method: 'PATCH',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { role: 'member' },
    });
    assert.equal(result.status, 409, 'Owner demotion must be blocked');
  });

  test('ownership transfer is atomic and correct', async () => {
    const owner = await signup('own-xfer-owner@test.com', 'Xfer House');
    const newOwner = await signup('own-xfer-new@test.com', 'New Owner House');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'own-xfer-new@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: newOwner.token,
      workspaceId: newOwner.workspaceId,
    });

    const xfer = await request(`/api/v1/workspaces/${owner.workspaceId}/transfer-ownership`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { toUserId: newOwner.userId },
    });
    assert.equal(xfer.status, 200, JSON.stringify(xfer.data));

    // Verify members now reflect the new ownership
    const members = await request(`/api/v1/workspaces/${owner.workspaceId}/members`, {
      token: owner.token,
      workspaceId: owner.workspaceId,
    });
    const list = members.data.items;
    const oldOwnerEntry = list.find((m) => m.userId === owner.userId);
    const newOwnerEntry = list.find((m) => m.userId === newOwner.userId);
    assert.equal(newOwnerEntry?.role, 'owner', 'New owner must have owner role');
    assert.equal(oldOwnerEntry?.role, 'admin', 'Old owner must be demoted to admin');
  });

  test('non-owner cannot transfer ownership', async () => {
    const owner = await signup('own-noxfer-owner@test.com', 'No Xfer House');
    const admin = await signup('own-noxfer-admin@test.com', 'No Xfer Admin');
    const other = await signup('own-noxfer-other@test.com', 'No Xfer Other');

    for (const [email, role, user] of [
      ['own-noxfer-admin@test.com', 'admin', admin],
      ['own-noxfer-other@test.com', 'member', other],
    ]) {
      const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
        method: 'POST',
        token: owner.token,
        workspaceId: owner.workspaceId,
        body: { email, role },
      });
      await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
        method: 'POST',
        token: user.token,
        workspaceId: user.workspaceId,
      });
    }

    const result = await request(`/api/v1/workspaces/${owner.workspaceId}/transfer-ownership`, {
      method: 'POST',
      token: admin.token,
      workspaceId: owner.workspaceId,
      body: { toUserId: other.userId },
    });
    assert.equal(result.status, 403);
  });
});

// ─── Cross-Workspace Isolation ────────────────────────────────────────────────

describe('cross-workspace isolation', () => {
  test('member of workspace A cannot list members of workspace B', async () => {
    const a = await signup('iso-a-owner@test.com', 'Workspace A');
    const b = await signup('iso-b-owner@test.com', 'Workspace B');

    // A tries to read B's members using A's auth context but B's workspace ID in the path
    const result = await request(`/api/v1/workspaces/${b.workspaceId}/members`, {
      token: a.token,
      workspaceId: a.workspaceId, // A's workspace in header
    });
    // The assertWorkspaceParam guard should return 403 because path id ≠ auth workspace id
    assert.equal(result.status, 403);
  });

  test('member of workspace A cannot invite into workspace B', async () => {
    const a = await signup('iso-inv-a@test.com', 'ISO Inv A');
    const b = await signup('iso-inv-b@test.com', 'ISO Inv B');

    const result = await request(`/api/v1/workspaces/${b.workspaceId}/invitations`, {
      method: 'POST',
      token: a.token,
      workspaceId: a.workspaceId,
      body: { email: 'victim@test.com', role: 'member' },
    });
    assert.equal(result.status, 403);
  });

  test('member of workspace A cannot read workspace B activity', async () => {
    const a = await signup('iso-act-a@test.com', 'ISO Act A');
    const b = await signup('iso-act-b@test.com', 'ISO Act B');

    const result = await request(`/api/v1/workspaces/${b.workspaceId}/activity`, {
      token: a.token,
      workspaceId: a.workspaceId,
    });
    assert.equal(result.status, 403);
  });

  test('member of workspace A cannot revoke workspace B invitations', async () => {
    const a = await signup('iso-rvk-a@test.com', 'ISO Rvk A');
    const b = await signup('iso-rvk-b@test.com', 'ISO Rvk B');

    const inv = await request(`/api/v1/workspaces/${b.workspaceId}/invitations`, {
      method: 'POST',
      token: b.token,
      workspaceId: b.workspaceId,
      body: { email: 'target@test.com', role: 'member' },
    });
    const invId = inv.data.invitation.id;

    const result = await request(`/api/v1/workspaces/${b.workspaceId}/invitations/${invId}`, {
      method: 'DELETE',
      token: a.token,
      workspaceId: a.workspaceId,
    });
    assert.equal(result.status, 403);
  });

  test('member of workspace A cannot transfer workspace B ownership', async () => {
    const a = await signup('iso-xfr-a@test.com', 'ISO Xfr A');
    const b = await signup('iso-xfr-b@test.com', 'ISO Xfr B');

    const result = await request(`/api/v1/workspaces/${b.workspaceId}/transfer-ownership`, {
      method: 'POST',
      token: a.token,
      workspaceId: a.workspaceId,
      body: { toUserId: a.userId },
    });
    assert.equal(result.status, 403);
  });
});

// ─── Post-Removal Access ───────────────────────────────────────────────────────

describe('access revoked after member removal', () => {
  test('removed member immediately loses access to workspace routes', async () => {
    const owner = await signup('rm-access-owner@test.com', 'Remove Access House');
    const member = await signup('rm-access-member@test.com', 'Remove Access Member');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'rm-access-member@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });

    // Confirm member has access to the owner's workspace (member list is a workspace:read operation)
    const before = await request(`/api/v1/workspaces/${owner.workspaceId}/members`, {
      token: member.token,
      workspaceId: owner.workspaceId,
    });
    assert.equal(before.status, 200, 'Member should have access before removal');

    // Owner removes member
    await request(`/api/v1/workspaces/${owner.workspaceId}/members/${member.userId}`, {
      method: 'DELETE',
      token: owner.token,
      workspaceId: owner.workspaceId,
    });

    // Immediate next request from removed member must be denied
    const after = await request(`/api/v1/workspaces/${owner.workspaceId}/members`, {
      token: member.token,
      workspaceId: owner.workspaceId,
    });
    assert.equal(after.status, 403, 'Removed member must lose access immediately');
  });
});

// ─── Activity Log ─────────────────────────────────────────────────────────────

describe('activity log', () => {
  test('invitation accepted action appears in activity log', async () => {
    const owner = await signup('log-owner@test.com', 'Log House');
    const member = await signup('log-member@test.com', 'Log Member');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'log-member@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });

    const activity = await request(`/api/v1/workspaces/${owner.workspaceId}/activity`, {
      token: owner.token,
      workspaceId: owner.workspaceId,
    });
    assert.equal(activity.status, 200);
    const actions = activity.data.items.map((i) => i.action);
    assert.ok(actions.includes('member.invited'), 'member.invited should be logged');
    assert.ok(actions.includes('member.accepted'), 'member.accepted should be logged');
  });

  test('member can only see own activity entries', async () => {
    const owner = await signup('log2-owner@test.com', 'Log House 2');
    const member = await signup('log2-member@test.com', 'Log Member 2');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'log2-member@test.com', role: 'member' },
    });
    await request(`/api/v1/invitations/${inv.data.invitation.rawToken}/accept`, {
      method: 'POST',
      token: member.token,
      workspaceId: member.workspaceId,
    });

    const activity = await request(`/api/v1/workspaces/${owner.workspaceId}/activity`, {
      token: member.token,
      workspaceId: owner.workspaceId,
    });
    assert.equal(activity.status, 200);
    // Member should only see their own entries
    for (const entry of activity.data.items) {
      assert.equal(entry.actorUserId, member.userId, 'Member should only see own activity');
    }
  });

  test('activity entries do not contain invitation tokens', async () => {
    const owner = await signup('log3-owner@test.com', 'Log House 3');

    const inv = await request(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: 'POST',
      token: owner.token,
      workspaceId: owner.workspaceId,
      body: { email: 'log3-target@test.com', role: 'member' },
    });
    const rawToken = inv.data.invitation.rawToken;

    const activity = await request(`/api/v1/workspaces/${owner.workspaceId}/activity`, {
      token: owner.token,
      workspaceId: owner.workspaceId,
    });

    const serialized = JSON.stringify(activity.data);
    assert.ok(!serialized.includes(rawToken), 'Activity log must not contain invitation tokens');
  });
});
