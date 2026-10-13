-- Remi usage budget: per-workspace, per-UTC-day call and token counters.
--
-- Purpose:
--   Hard shared ceiling on paid Remi usage. The server reserves budget in ONE statement
--   (INSERT ... ON CONFLICT DO UPDATE ... WHERE used + reserve <= limit) BEFORE each upstream
--   call, then reconciles to actual usage. Concurrent requests serialize on the row lock, so
--   the day's limits cannot be oversubscribed.
--
-- Access:
--   - RLS is workspace-scoped (raf.current_workspace_id() plus active membership), like the
--     other Remi tables. FORCE RLS applies to the table owner too.
--   - Writes happen only from server code paths (reserveRemiBudget / settleRemiBudget in
--     lib/server/postgresDb.js). No client route reads or writes this table directly.
--   - No DELETE policy: rows are never removed by the application.
--
-- Safety:
--   - Additive only. Creates one new table; touches no financial tables.
--   - Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS raf.remi_usage_budgets (
  workspace_id uuid NOT NULL REFERENCES raf.workspaces(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  tokens_used integer NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, usage_day)
);

ALTER TABLE raf.remi_usage_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE raf.remi_usage_budgets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS remi_usage_budgets_select_policy ON raf.remi_usage_budgets;
CREATE POLICY remi_usage_budgets_select_policy ON raf.remi_usage_budgets
FOR SELECT
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
);

DROP POLICY IF EXISTS remi_usage_budgets_insert_policy ON raf.remi_usage_budgets;
CREATE POLICY remi_usage_budgets_insert_policy ON raf.remi_usage_budgets
FOR INSERT
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
);

DROP POLICY IF EXISTS remi_usage_budgets_update_policy ON raf.remi_usage_budgets;
CREATE POLICY remi_usage_budgets_update_policy ON raf.remi_usage_budgets
FOR UPDATE
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
);

COMMIT;
