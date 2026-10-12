-- Protect raf.workspaces.remi_tier (the authoritative Remi entitlement) from
-- non-privileged writes.
--
-- BACKGROUND
-- ----------
-- The RLS policy workspaces_member_policy (20260903090000) is FOR ALL with
-- WITH CHECK raf.has_workspace_role(id, ARRAY['owner','admin']). Any owner or admin
-- of a workspace can therefore UPDATE every column of that workspace row, including
-- remi_tier. workspaces_insert_policy (20260910000006) lets any user INSERT a
-- workspace they own, so remi_tier could also be set to 'paid' at insert time. No
-- application code writes remi_tier today, but nothing in the database enforces that.
--
-- MECHANISM: BEFORE INSERT OR UPDATE trigger (not column-level GRANT/REVOKE)
-- --------------------------------------------------------------------------
-- Column privileges were rejected for two reasons, verified against this codebase:
--   1. raf_app holds a TABLE-level UPDATE grant (20260909000000). A column-level
--      REVOKE UPDATE (remi_tier) does nothing while the table-level grant exists.
--      Making it work would mean revoking table UPDATE and re-granting UPDATE on
--      every other column, which silently breaks when a column is added.
--   2. Table owners bypass column privileges. The owner role is the migration role,
--      and any future code run as the owner would be unrestricted.
-- A trigger runs for every writer, including RLS-authorised owners and admins, and
-- checks current_user on each row change, so it cannot be bypassed by RLS or grants.
--
-- WHO MAY CHANGE remi_tier
-- ------------------------
--   * members of raf_billing_service (NOLOGIN; the future privileged billing/service
--     login role must be granted membership of it), and
--   * the table owner (the migration / operations role), for backfills and repair.
-- raf_app (the runtime role) must never be a member of raf_billing_service. This
-- migration refuses to run if it is. Owners and admins of a workspace have no
-- membership and are rejected.
--
-- Idempotent: role creation is guarded, the function is CREATE OR REPLACE, and the
-- trigger is dropped and recreated.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raf_billing_service') THEN
    CREATE ROLE raf_billing_service NOLOGIN NOINHERIT;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raf_app')
     AND pg_has_role('raf_app', 'raf_billing_service', 'MEMBER') THEN
    RAISE EXCEPTION 'raf_app must not be a member of raf_billing_service (remi_tier protection)';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION raf.protect_workspace_remi_tier()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'raf', 'pg_catalog'
AS $function$
DECLARE
  owner_role name;
  is_privileged boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.remi_tier IS NOT DISTINCT FROM 'free' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.remi_tier IS NOT DISTINCT FROM OLD.remi_tier THEN
    RETURN NEW;
  END IF;

  SELECT pg_get_userbyid(c.relowner) INTO owner_role
  FROM pg_class c
  WHERE c.oid = TG_RELID;

  is_privileged := pg_has_role(current_user, 'raf_billing_service', 'MEMBER')
                   OR pg_has_role(current_user, owner_role, 'MEMBER');

  IF NOT is_privileged THEN
    RAISE EXCEPTION 'raf.workspaces.remi_tier can only be changed by a privileged billing service role (current_user=%)',
      current_user
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION raf.protect_workspace_remi_tier() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_workspaces_protect_remi_tier ON raf.workspaces;
CREATE TRIGGER trg_workspaces_protect_remi_tier
  BEFORE INSERT OR UPDATE ON raf.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION raf.protect_workspace_remi_tier();

COMMIT;
