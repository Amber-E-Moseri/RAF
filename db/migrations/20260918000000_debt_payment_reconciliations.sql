-- Persist confirmed/rejected equivalence between two debt-payment records
-- that represent the same economic event.  Neither payment is deleted or
-- modified — the reconciliation is metadata about identity.

BEGIN;

CREATE TABLE IF NOT EXISTS raf.debt_payment_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES raf.workspaces(id) ON DELETE CASCADE,

  primary_payment_id uuid NOT NULL,
  duplicate_payment_id uuid NOT NULL,

  status text NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  match_type text NOT NULL CHECK (match_type IN ('EXACT_MATCH', 'POSSIBLE_MATCH')),

  confirmed_at timestamptz,
  confirmed_by text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_self_reconciliation
    CHECK (primary_payment_id != duplicate_payment_id),

  CONSTRAINT unique_reconciliation_pair
    UNIQUE (workspace_id, primary_payment_id, duplicate_payment_id),

  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Prevent reversed duplicate pairs: (A,B) and (B,A) cannot both exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_payment_reconciliations_unordered_pair
ON raf.debt_payment_reconciliations (
  workspace_id,
  LEAST(primary_payment_id, duplicate_payment_id),
  GREATEST(primary_payment_id, duplicate_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_debt_payment_reconciliations_workspace
ON raf.debt_payment_reconciliations (workspace_id);

CREATE INDEX IF NOT EXISTS idx_debt_payment_reconciliations_primary
ON raf.debt_payment_reconciliations (workspace_id, primary_payment_id);

CREATE INDEX IF NOT EXISTS idx_debt_payment_reconciliations_duplicate
ON raf.debt_payment_reconciliations (workspace_id, duplicate_payment_id);

-- RLS
ALTER TABLE raf.debt_payment_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE raf.debt_payment_reconciliations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS debt_payment_reconciliations_workspace_policy ON raf.debt_payment_reconciliations;
CREATE POLICY debt_payment_reconciliations_workspace_policy ON raf.debt_payment_reconciliations
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::raf.workspace_role[])
);

COMMIT;
