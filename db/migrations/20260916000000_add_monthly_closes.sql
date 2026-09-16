BEGIN;

CREATE TABLE IF NOT EXISTS raf.monthly_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES raf.workspaces(id) ON DELETE CASCADE,
  period date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED', 'REOPENED')),
  closed_at timestamptz,
  closed_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  raw_json jsonb
);

CREATE INDEX IF NOT EXISTS idx_monthly_closes_workspace_period
  ON raf.monthly_closes (workspace_id, period);

CREATE INDEX IF NOT EXISTS idx_monthly_closes_workspace_period_version
  ON raf.monthly_closes (workspace_id, period, version DESC);

-- Only one ACTIVE CLOSED record per workspace+period at a time.
-- REOPENED records are allowed to accumulate (re-close versioning).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_monthly_closes_active_closed
  ON raf.monthly_closes (workspace_id, period)
  WHERE status = 'CLOSED';

CREATE TRIGGER trg_monthly_closes_set_updated_at
BEFORE UPDATE ON raf.monthly_closes
FOR EACH ROW EXECUTE FUNCTION raf.set_updated_at();

ALTER TABLE raf.monthly_closes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monthly_closes_workspace_isolation ON raf.monthly_closes;
CREATE POLICY monthly_closes_workspace_isolation
  ON raf.monthly_closes
  USING (workspace_id = raf.current_workspace_id());

COMMIT;
