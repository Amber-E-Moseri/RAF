BEGIN;

-- Canonical review state: a workspace member personally verified this transaction.
-- reviewed_by is FK to app_users so we can track which user reviewed; NULL is allowed
-- (auth-less dev environments) but server always derives it from trusted context.
ALTER TABLE raf.transactions
  ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by  UUID REFERENCES raf.app_users(id) ON DELETE SET NULL;

-- Partial index: only unreviewed rows are scanned for the inbox query; reviewed rows are excluded.
CREATE INDEX IF NOT EXISTS idx_transactions_workspace_unreviewed
  ON raf.transactions (workspace_id, transaction_date)
  WHERE reviewed_at IS NULL;

COMMIT;
