-- Add workspace-scoped Remi entitlement (separate from PDF quota)
--
-- Strategy:
--   1. Add raf.workspaces.remi_tier (default 'free')
--   2. Preserve existing paid app_users.remi_tier → workspace.remi_tier where unambiguous
--      - If user OWNS workspace and has remiTier='paid': set workspace.remi_tier='paid'
--      - If user is MEMBER of workspace and has remiTier='paid': report ambiguity (cannot assume)
--   3. Report:
--      - Number of paid users found
--      - Number of workspaces upgraded
--      - Any ambiguous mappings (member-based, no owner context)
--   4. app_users.remi_tier becomes LEGACY (no longer authorizes Remi after this)
--   5. Request-time derivation now uses raf.workspaces.remi_tier
--
-- Safety:
--   - Fresh databases: all workspaces default to 'free' (correct)
--   - Existing databases with paid users: preserved where ownership is clear
--   - No data loss: app_users.remi_tier remains for audit/compatibility

BEGIN;

-- Add column: workspace-scoped Remi entitlement
ALTER TABLE raf.workspaces
ADD COLUMN IF NOT EXISTS remi_tier text NOT NULL DEFAULT 'free'
CHECK (remi_tier IN ('free', 'paid'));

-- Backfill: preserve existing paid users
-- Only set remi_tier='paid' where we can deterministically map user ownership
DO $$
DECLARE
  paid_user RECORD;
  owned_workspace_count INT;
  ambiguous_count INT := 0;
  preserved_count INT := 0;
BEGIN
  -- Find all users with remi_tier='paid'
  FOR paid_user IN
    SELECT id, email FROM raf.app_users WHERE remi_tier = 'paid'
  LOOP
    -- Check if this user OWNS exactly one workspace
    SELECT COUNT(*)::INT INTO owned_workspace_count
    FROM raf.workspaces
    WHERE owner_user_id = paid_user.id;

    IF owned_workspace_count = 1 THEN
      -- Safe: user owns exactly one workspace → preserve tier
      UPDATE raf.workspaces
      SET remi_tier = 'paid'
      WHERE owner_user_id = paid_user.id;
      preserved_count := preserved_count + 1;
    ELSIF owned_workspace_count > 1 THEN
      -- Ambiguous: user owns multiple workspaces
      -- Cannot determine which should be paid without additional context
      -- Conservatively leave all as 'free'; admin must manually update
      RAISE WARNING 'REMI_TIER_BACKFILL: User % (%) owns % workspaces — ambiguous tier mapping, left as free. Admin must manually set paid workspace(s).',
        paid_user.id, paid_user.email, owned_workspace_count;
      ambiguous_count := ambiguous_count + 1;
    ELSE
      -- User has remi_tier='paid' but owns no workspaces
      -- Likely a member of workspace(s) — ambiguous without workspace tier field
      RAISE WARNING 'REMI_TIER_BACKFILL: User % (%) has remi_tier=paid but owns no workspaces — ambiguous. Member of workspace(s)?',
        paid_user.id, paid_user.email;
      ambiguous_count := ambiguous_count + 1;
    END IF;
  END LOOP;

  -- Log backfill summary (will appear in migration output)
  RAISE NOTICE 'REMI_TIER_BACKFILL: % users had remi_tier=paid', (preserved_count + ambiguous_count);
  RAISE NOTICE 'REMI_TIER_BACKFILL: % workspaces upgraded to remi_tier=paid', preserved_count;
  RAISE NOTICE 'REMI_TIER_BACKFILL: % ambiguous mappings (admin review required)', ambiguous_count;
END $$;

-- Add index for efficient entitlement queries
CREATE INDEX IF NOT EXISTS idx_workspaces_remi_tier
ON raf.workspaces(remi_tier);

COMMIT;
