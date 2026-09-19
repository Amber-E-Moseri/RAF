-- Track A — Invitation Security Resolver
--
-- Problem: workspace_invitations has FORCE ROW LEVEL SECURITY with a policy that
-- requires workspace membership:
--   USING (has_workspace_membership(workspace_id))
--
-- Three invitation flows touch the table without established workspace membership:
--   1. resolveInvitation   — unauthenticated (public link preview)
--   2. acceptInvitation    — authenticated but pre-membership (bootstrapping)
--   3. declineInvitation   — unauthenticated (public decline)
--
-- neondb_owner has BYPASSRLS and FORCE ROW LEVEL SECURITY does not override
-- the BYPASSRLS attribute. SECURITY DEFINER functions run as neondb_owner, so
-- they bypass RLS entirely and can access any row.
--
-- This migration introduces three narrowly scoped SECURITY DEFINER functions:
--
--   raf.resolve_invitation_by_token     — read-only lookup with lazy expiry
--   raf.accept_workspace_invitation     — atomic accept (validates, creates member,
--                                         updates status, logs activity)
--   raf.decline_workspace_invitation    — atomic decline (validates + updates status)
--
-- Privilege model:
--   • Each function: REVOKE EXECUTE FROM PUBLIC
--   • raf_app access: covered by ALTER DEFAULT PRIVILEGES in the
--     create_raf_app_role migration (all functions created by neondb_owner
--     in schema raf are automatically executable by raf_app)
--
-- These functions do NOT weaken workspace_invitations RLS. The RLS policy remains.
-- They provide a controlled bypass ONLY through the narrow function interface.
-- Workspace-admin operations (create, revoke, list) continue to use direct SQL
-- gated by setSecurityContext + RLS.

BEGIN;

-- ── resolve_invitation_by_token ────────────────────────────────────────────────
-- Returns the invitation for the given token hash. If the invitation is pending
-- but its expiry has passed, lazily marks it as expired and returns the updated
-- row (so callers see status='expired' without a separate UPDATE round-trip).
-- Returns 0 rows when no invitation exists for the token.
-- Does NOT return the token column — the caller already has it.

CREATE OR REPLACE FUNCTION raf.resolve_invitation_by_token(p_token_hash text)
RETURNS TABLE (
  id          uuid,
  workspace_id uuid,
  invited_by  uuid,
  email       text,
  role        raf.workspace_role,
  status      raf.invitation_status,
  expires_at  timestamptz,
  created_at  timestamptz,
  updated_at  timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = raf, pg_catalog
AS $$
DECLARE
  v_inv raf.workspace_invitations%ROWTYPE;
BEGIN
  SELECT wi.*
  INTO v_inv
  FROM raf.workspace_invitations wi
  WHERE wi.token = p_token_hash
  LIMIT 1;

  IF v_inv.id IS NULL THEN
    RETURN;
  END IF;

  -- Lazily expire if still marked pending but past expiry.
  -- Callers see status='expired' immediately; no separate UPDATE round-trip needed.
  IF v_inv.status = 'pending' AND v_inv.expires_at < now() THEN
    -- Qualify the column to avoid ambiguity with the OUT parameter also named 'id'
    -- (RETURNS TABLE columns become OUT parameters in plpgsql scope).
    UPDATE raf.workspace_invitations
    SET status = 'expired'
    WHERE workspace_invitations.id = v_inv.id;
    v_inv.status   := 'expired';
    v_inv.updated_at := now();
  END IF;

  RETURN QUERY SELECT
    v_inv.id,
    v_inv.workspace_id,
    v_inv.invited_by,
    v_inv.email,
    v_inv.role,
    v_inv.status,
    v_inv.expires_at,
    v_inv.created_at,
    v_inv.updated_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION raf.resolve_invitation_by_token(text) FROM PUBLIC;
-- Explicit grant — belt-and-suspenders even though ALTER DEFAULT PRIVILEGES in
-- 20260909000000_create_raf_app_role.sql also covers future functions.
GRANT EXECUTE ON FUNCTION raf.resolve_invitation_by_token(text) TO raf_app;

-- ── accept_workspace_invitation ───────────────────────────────────────────────
-- Atomically validates the token, creates the workspace membership, marks the
-- invitation as accepted, and logs the activity. All within the caller's
-- transaction (SECURITY DEFINER functions run in the caller's transaction context).
--
-- Raises named exceptions (parsed by the application layer):
--   INV_NOT_FOUND           — no pending invitation for this token
--   INV_NOT_PENDING:<status>— invitation exists but is not pending
--   INV_EXPIRED             — invitation was pending but has expired
--   INV_EMAIL_MISMATCH      — accepting user's email does not match invitation
--   INV_ALREADY_MEMBER      — user is already an active member of the workspace

CREATE OR REPLACE FUNCTION raf.accept_workspace_invitation(
  p_token_hash text,
  p_user_id    uuid,
  p_user_email text
)
RETURNS TABLE (workspace_id uuid, role raf.workspace_role)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = raf, pg_catalog
AS $$
DECLARE
  v_inv       raf.workspace_invitations%ROWTYPE;
  v_member_id uuid;
  v_now       timestamptz;
BEGIN
  v_now := now();

  SELECT wi.*
  INTO v_inv
  FROM raf.workspace_invitations wi
  WHERE wi.token = p_token_hash
  LIMIT 1;

  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'INV_NOT_FOUND';
  END IF;

  IF v_inv.status != 'pending' THEN
    RAISE EXCEPTION 'INV_NOT_PENDING:%', v_inv.status;
  END IF;

  IF v_inv.expires_at < v_now THEN
    UPDATE raf.workspace_invitations SET status = 'expired' WHERE id = v_inv.id;
    RAISE EXCEPTION 'INV_EXPIRED';
  END IF;

  IF lower(v_inv.email) != lower(p_user_email) THEN
    RAISE EXCEPTION 'INV_EMAIL_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1 FROM raf.workspace_members wm
    WHERE wm.workspace_id = v_inv.workspace_id
      AND wm.user_id      = p_user_id
      AND wm.status       = 'active'
  ) THEN
    RAISE EXCEPTION 'INV_ALREADY_MEMBER';
  END IF;

  -- Create membership. raw_json mirrors the JS createWorkspaceMember shape for
  -- compatibility with any compat-layer readers.
  v_member_id := gen_random_uuid();
  INSERT INTO raf.workspace_members
    (id, workspace_id, user_id, role, status, joined_at, invited_by, raw_json)
  VALUES (
    v_member_id,
    v_inv.workspace_id,
    p_user_id,
    v_inv.role,
    'active',
    v_now,
    v_inv.invited_by,
    jsonb_build_object(
      'id',          v_member_id,
      'workspaceId', v_inv.workspace_id,
      'householdId', v_inv.workspace_id,
      'userId',      p_user_id,
      'role',        v_inv.role,
      'status',      'active',
      'joinedAt',    v_now,
      'invitedBy',   v_inv.invited_by
    )
  );

  -- Mark invitation accepted
  UPDATE raf.workspace_invitations
  SET status = 'accepted'
  WHERE id = v_inv.id;

  -- Activity log (INSERT policy only requires membership, which now exists in this txn)
  INSERT INTO raf.workspace_activity
    (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
  VALUES (
    gen_random_uuid(),
    v_inv.workspace_id,
    p_user_id,
    'member.accepted',
    'invitation',
    v_inv.id::text,
    jsonb_build_object('email', v_inv.email, 'role', v_inv.role),
    v_now
  );

  RETURN QUERY SELECT v_inv.workspace_id, v_inv.role;
END;
$$;

REVOKE EXECUTE ON FUNCTION raf.accept_workspace_invitation(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION raf.accept_workspace_invitation(text, uuid, text) TO raf_app;

-- ── decline_workspace_invitation ──────────────────────────────────────────────
-- Validates the token (must be pending) and marks it as declined atomically.
-- Raises named exceptions:
--   INV_NOT_FOUND           — no invitation found for this token
--   INV_NOT_PENDING:<status>— invitation exists but is not pending

CREATE OR REPLACE FUNCTION raf.decline_workspace_invitation(p_token_hash text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = raf, pg_catalog
AS $$
DECLARE
  v_inv raf.workspace_invitations%ROWTYPE;
BEGIN
  SELECT wi.*
  INTO v_inv
  FROM raf.workspace_invitations wi
  WHERE wi.token = p_token_hash
  LIMIT 1;

  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'INV_NOT_FOUND';
  END IF;

  IF v_inv.status != 'pending' THEN
    RAISE EXCEPTION 'INV_NOT_PENDING:%', v_inv.status;
  END IF;

  UPDATE raf.workspace_invitations
  SET status = 'declined'
  WHERE id = v_inv.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION raf.decline_workspace_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION raf.decline_workspace_invitation(text) TO raf_app;

-- ── Static security assertions ────────────────────────────────────────────────
-- Runs inside this transaction; rolls back everything if any assertion fails.
-- Verifies the security properties we rely on before the migration commits.

DO $$
DECLARE
  v_rec RECORD;
  v_funcs text[] := ARRAY[
    'resolve_invitation_by_token',
    'accept_workspace_invitation',
    'decline_workspace_invitation'
  ];
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY v_funcs LOOP
    SELECT INTO v_rec
      p.prosecdef,
      p.proconfig,
      p.proacl::text AS acl_text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'raf' AND p.proname = v_name
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Security assertion FAILED: function raf.% not found', v_name;
    END IF;

    -- SECURITY DEFINER must be set
    IF NOT v_rec.prosecdef THEN
      RAISE EXCEPTION 'Security assertion FAILED: raf.% is not SECURITY DEFINER', v_name;
    END IF;

    -- Hardened search_path must be present
    IF v_rec.proconfig IS NULL OR NOT (
      array_to_string(v_rec.proconfig, ',') LIKE '%search_path=raf%'
      OR array_to_string(v_rec.proconfig, ',') LIKE '%search_path = raf%'
    ) THEN
      RAISE EXCEPTION 'Security assertion FAILED: raf.% missing SET search_path', v_name;
    END IF;

    -- PUBLIC must not have EXECUTE.
    -- In PostgreSQL ACL strings, PUBLIC is the empty-grantee entry, e.g.
    -- '=X/neondb_owner'. It appears at the very start ('{=X/') or after a
    -- comma (',=X/'). The broader pattern '%=X/%' also matches legitimate
    -- named-role grants such as 'raf_app=X/neondb_owner', so we must not
    -- use it for the PUBLIC check.
    IF (v_rec.acl_text LIKE '{=X/%' OR v_rec.acl_text LIKE '%,=X/%') THEN
      RAISE EXCEPTION 'Security assertion FAILED: raf.% grants EXECUTE to PUBLIC', v_name;
    END IF;

    -- raf_app must have EXECUTE
    IF v_rec.acl_text IS NULL OR v_rec.acl_text NOT LIKE '%raf_app=X/%' THEN
      RAISE EXCEPTION 'Security assertion FAILED: raf.% does not grant EXECUTE to raf_app', v_name;
    END IF;

  END LOOP;

  -- Paranoia: raf_app must not have BYPASSRLS
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'raf_app' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Security assertion FAILED: raf_app has BYPASSRLS — this must never be granted';
  END IF;

  RAISE NOTICE 'Security assertions PASSED: all three SECURITY DEFINER invitation functions verified';
END;
$$;

COMMIT;
