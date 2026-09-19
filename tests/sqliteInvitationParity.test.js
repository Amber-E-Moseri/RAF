/**
 * SQLite invitation parity — unit-level tests for acceptWorkspaceInvitation,
 * declineWorkspaceInvitation, and getWorkspaceInvitationByToken in inMemoryDb.
 *
 * Covers scenarios not reachable via the API integration tests because they
 * require direct state control (e.g. synthetic past-expiry invitations):
 *   - expired invitation acceptance returns INV_EXPIRED
 *   - expired token resolves as 'expired' (lazy expiry)
 *   - repeated decline fails consistently (INV_NOT_PENDING)
 *   - atomic rollback: failed acceptance leaves state unchanged
 *   - stored invitation role is returned and propagated to membership
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';

const PAST = new Date(Date.now() - 10_000).toISOString();
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

async function seed(db) {
  return db.transaction(async (tx) => {
    const owner = await tx.createUser({ email: 'owner@parity.test', passwordHash: 'x' });
    const workspace = await tx.createWorkspace({
      ownerUserId: owner.id,
      name: 'Parity WS',
    });
    const invitee = await tx.createUser({ email: 'invitee@parity.test', passwordHash: 'x' });
    return { owner, workspace, invitee };
  });
}

function makeInvitation(db, { workspaceId, ownerUserId, email, role = 'member', expiresAt = FUTURE, tokenHash = 'test-token-hash', status = 'pending' }) {
  return db.transaction((tx) =>
    tx.createWorkspaceInvitation({ workspaceId, invitedBy: ownerUserId, email, role, token: tokenHash, expiresAt }),
  ).then(async (inv) => {
    if (status !== 'pending') {
      await db.transaction((tx) => tx.updateWorkspaceInvitation({ invitationId: inv.id, patch: { status } }));
      return { ...inv, status };
    }
    return inv;
  });
}

test('expired invitation — acceptWorkspaceInvitation throws INV_EXPIRED', async () => {
  const db = createInMemoryDb();
  const { workspace, invitee } = await seed(db);

  await makeInvitation(db, {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    email: 'invitee@parity.test',
    expiresAt: PAST,
    tokenHash: 'expired-hash',
  });

  await assert.rejects(
    () => db.transaction((tx) => tx.acceptWorkspaceInvitation({
      tokenHash: 'expired-hash',
      userId: invitee.id,
      userEmail: 'invitee@parity.test',
    })),
    (err) => {
      assert.ok(err.isInvitationError, 'should be invitation error');
      assert.equal(err.code, 'INV_EXPIRED');
      return true;
    },
  );

  // Invitation status must be flipped to 'expired' atomically
  const inv = await db.transaction((tx) => tx.getWorkspaceInvitationByToken({ token: 'expired-hash' }));
  assert.equal(inv?.status, 'expired', 'invitation should be marked expired after lazy expiry');
});

test('expired token — getWorkspaceInvitationByToken applies lazy expiry', async () => {
  const db = createInMemoryDb();
  const { workspace } = await seed(db);

  await makeInvitation(db, {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    email: 'invitee@parity.test',
    expiresAt: PAST,
    tokenHash: 'lazy-expiry-hash',
  });

  const result = await db.transaction((tx) => tx.getWorkspaceInvitationByToken({ token: 'lazy-expiry-hash' }));
  assert.equal(result?.status, 'expired', 'lazy expiry must flip status to expired');
});

test('repeated decline — second decline returns INV_NOT_PENDING', async () => {
  const db = createInMemoryDb();
  const { workspace } = await seed(db);

  await makeInvitation(db, {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    email: 'invitee@parity.test',
    tokenHash: 'decline-repeat-hash',
  });

  await db.transaction((tx) => tx.declineWorkspaceInvitation({ tokenHash: 'decline-repeat-hash' }));

  await assert.rejects(
    () => db.transaction((tx) => tx.declineWorkspaceInvitation({ tokenHash: 'decline-repeat-hash' })),
    (err) => {
      assert.ok(err.isInvitationError, 'should be invitation error');
      assert.equal(err.code, 'INV_NOT_PENDING');
      assert.equal(err.detail, 'declined');
      return true;
    },
  );
});

test('atomic rollback — failed acceptance (wrong email) leaves no member and invitation pending', async () => {
  const db = createInMemoryDb();
  const { workspace, invitee } = await seed(db);
  const outsider = await db.transaction((tx) => tx.createUser({ email: 'outsider@parity.test', passwordHash: 'x' }));

  await makeInvitation(db, {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    email: 'invitee@parity.test',
    tokenHash: 'rollback-hash',
  });

  await assert.rejects(
    () => db.transaction((tx) => tx.acceptWorkspaceInvitation({
      tokenHash: 'rollback-hash',
      userId: outsider.id,
      userEmail: 'outsider@parity.test',
    })),
    (err) => err.code === 'INV_EMAIL_MISMATCH',
  );

  // Invitation must remain pending
  const inv = await db.transaction((tx) => tx.getWorkspaceInvitationByToken({ token: 'rollback-hash' }));
  assert.equal(inv?.status, 'pending', 'invitation should still be pending after failed acceptance');

  // Outsider must not be a member
  const members = await db.transaction((tx) => tx.listWorkspaceMembers({ workspaceId: workspace.id }));
  assert.ok(!members.some((m) => m.userId === outsider.id), 'outsider must not be a member after failed acceptance');
});

test('stored role propagation — acceptance returns and stores the invitation role', async () => {
  const db = createInMemoryDb();
  const { workspace, invitee } = await seed(db);

  await makeInvitation(db, {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    email: 'invitee@parity.test',
    role: 'viewer',
    tokenHash: 'role-hash',
  });

  const result = await db.transaction((tx) => tx.acceptWorkspaceInvitation({
    tokenHash: 'role-hash',
    userId: invitee.id,
    userEmail: 'invitee@parity.test',
  }));

  assert.equal(result.workspaceId, workspace.id);
  assert.equal(result.role, 'viewer', 'returned role must match invitation role');

  const members = await db.transaction((tx) => tx.listWorkspaceMembers({ workspaceId: workspace.id }));
  const membership = members.find((m) => m.userId === invitee.id);
  assert.ok(membership, 'member record must exist');
  assert.equal(membership.role, 'viewer', 'stored membership role must match invitation role');
});

test('invalid token — acceptWorkspaceInvitation throws INV_NOT_FOUND', async () => {
  const db = createInMemoryDb();
  await seed(db);

  await assert.rejects(
    () => db.transaction((tx) => tx.acceptWorkspaceInvitation({
      tokenHash: 'nonexistent',
      userId: 'any',
      userEmail: 'any@test.com',
    })),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_NOT_FOUND');
      return true;
    },
  );
});

test('invalid token — declineWorkspaceInvitation throws INV_NOT_FOUND', async () => {
  const db = createInMemoryDb();
  await seed(db);

  await assert.rejects(
    () => db.transaction((tx) => tx.declineWorkspaceInvitation({ tokenHash: 'nonexistent' })),
    (err) => {
      assert.ok(err.isInvitationError);
      assert.equal(err.code, 'INV_NOT_FOUND');
      return true;
    },
  );
});
