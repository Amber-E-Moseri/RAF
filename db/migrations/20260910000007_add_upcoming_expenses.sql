-- Add upcoming expenses as a workspace-scoped planning table.

CREATE TABLE IF NOT EXISTS raf.upcoming_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES raf.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  expected_date date NOT NULL,
  category text,
  account_id uuid,
  priority text NOT NULL DEFAULT 'planned',
  confidence text NOT NULL DEFAULT 'confirmed',
  notes text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT upcoming_expenses_priority_check CHECK (priority IN ('essential', 'planned', 'optional')),
  CONSTRAINT upcoming_expenses_confidence_check CHECK (confidence IN ('confirmed', 'expected')),
  CONSTRAINT upcoming_expenses_status_check CHECK (status IN ('active', 'archived')),
  UNIQUE (id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_upcoming_expenses_workspace_date
ON raf.upcoming_expenses (workspace_id, expected_date, id);

DROP TRIGGER IF EXISTS trg_upcoming_expenses_set_updated_at ON raf.upcoming_expenses;
CREATE TRIGGER trg_upcoming_expenses_set_updated_at
BEFORE UPDATE ON raf.upcoming_expenses
FOR EACH ROW EXECUTE FUNCTION raf.set_updated_at();

ALTER TABLE raf.upcoming_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE raf.upcoming_expenses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upcoming_expenses_workspace_policy ON raf.upcoming_expenses;
CREATE POLICY upcoming_expenses_workspace_policy ON raf.upcoming_expenses
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::raf.workspace_role[])
);
