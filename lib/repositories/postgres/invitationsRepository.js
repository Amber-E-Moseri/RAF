import { clone, uuid, isoNow } from './utils.js';

function toIso(v) {
  return v instanceof Date ? v.toISOString() : (v ?? null);
}

function rowToJs(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    invitedBy: row.invited_by,
    email: row.email,
    role: row.role,
    token: row.token ?? null,
    status: row.status,
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// Named PG exception prefixes raised by SECURITY DEFINER invitation functions.
const INV_ERROR_PREFIXES = [
  'INV_NOT_FOUND', 'INV_NOT_PENDING:', 'INV_EXPIRED',
  'INV_EMAIL_MISMATCH', 'INV_ALREADY_MEMBER',
];

function translatePgInvitationError(err) {
  const msg = err?.message ?? '';
  if (INV_ERROR_PREFIXES.some(prefix => msg.startsWith(prefix))) {
    const e = new Error(msg);
    e.isInvitationError = true;
    e.code = msg.split(':')[0];
    e.detail = msg.includes(':') ? msg.slice(msg.indexOf(':') + 1) : null;
    throw e;
  }
  throw err;
}

export function buildInvitationsRepository(client, schema) {
  return {
    async createWorkspaceInvitation({ workspaceId, invitedBy, email, role, token, expiresAt }) {
      const normalizedEmail = String(email ?? '').trim().toLowerCase();
      const now = isoNow();
      const id = uuid();
      // Supersede: revoke any existing pending invitation for same workspace+email
      // (mirrors inMemoryDb semantics and satisfies the unique index on pending invitations)
      await client.query(
        `UPDATE ${schema}.workspace_invitations
         SET status = 'revoked'
         WHERE workspace_id = $1 AND lower(email) = lower($2) AND status = 'pending'`,
        [workspaceId, normalizedEmail],
      );
      const result = await client.query(
        `INSERT INTO ${schema}.workspace_invitations
         (id, workspace_id, invited_by, email, role, token, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $8)
         RETURNING id, workspace_id, invited_by, email, role, token, status, expires_at, created_at, updated_at`,
        [id, workspaceId, invitedBy, normalizedEmail, role, token, expiresAt, now],
      );
      return rowToJs(result.rows[0] ?? null);
    },

    async getWorkspaceInvitationByToken({ token }) {
      // Uses SECURITY DEFINER resolver to bypass RLS for pre-membership token lookup.
      // The resolver omits the token column; re-attach from the input parameter.
      const result = await client.query(
        `SELECT id, workspace_id, invited_by, email, role, status, expires_at, created_at, updated_at
         FROM ${schema}.resolve_invitation_by_token($1)`,
        [token],
      );
      const row = result.rows[0] ?? null;
      if (!row) return null;
      return rowToJs({ ...row, token });
    },

    async getWorkspaceInvitationById({ invitationId }) {
      const result = await client.query(
        `SELECT id, workspace_id, invited_by, email, role, token, status, expires_at, created_at, updated_at
         FROM ${schema}.workspace_invitations
         WHERE id = $1
         LIMIT 1`,
        [invitationId],
      );
      return rowToJs(result.rows[0] ?? null);
    },

    async listWorkspaceInvitations({ workspaceId, status = null }) {
      const params = [workspaceId];
      let sql = `SELECT id, workspace_id, invited_by, email, role, token, status, expires_at, created_at, updated_at
                 FROM ${schema}.workspace_invitations
                 WHERE workspace_id = $1`;
      if (status != null) {
        params.push(status);
        sql += ` AND status = $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC, id`;
      const result = await client.query(sql, params);
      return result.rows.map(rowToJs);
    },

    async acceptWorkspaceInvitation({ tokenHash, userId, userEmail }) {
      try {
        const result = await client.query(
          `SELECT workspace_id AS "workspaceId", role
           FROM ${schema}.accept_workspace_invitation($1, $2, $3)`,
          [tokenHash, userId, userEmail],
        );
        return result.rows[0] ?? null;
      } catch (err) {
        translatePgInvitationError(err);
      }
    },

    async declineWorkspaceInvitation({ tokenHash }) {
      try {
        await client.query(
          `SELECT ${schema}.decline_workspace_invitation($1)`,
          [tokenHash],
        );
      } catch (err) {
        translatePgInvitationError(err);
      }
    },

    async updateWorkspaceInvitation({ invitationId, patch }) {
      // Read-then-write: fetch existing so the JS merge can carry any non-schema fields,
      // then write back all patchable typed columns via RETURNING to get trigger-set updated_at.
      const existing = await this.getWorkspaceInvitationById({ invitationId });
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      const result = await client.query(
        `UPDATE ${schema}.workspace_invitations
         SET status = $2, role = $3, expires_at = $4
         WHERE id = $1
         RETURNING id, workspace_id, invited_by, email, role, token, status, expires_at, created_at, updated_at`,
        [invitationId, merged.status, merged.role, merged.expiresAt],
      );
      return rowToJs(result.rows[0] ?? null);
    },
  };
}
