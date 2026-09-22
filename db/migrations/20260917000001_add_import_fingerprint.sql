-- Add fingerprint mechanism to imported_transactions for import idempotency
-- Prevents the same bank statement from creating duplicate transaction rows

BEGIN;

-- Add fingerprint column to track imported transaction identity
-- Fingerprint is stable across re-imports of the same statement
ALTER TABLE raf.imported_transactions
ADD COLUMN IF NOT EXISTS fingerprint text;

-- Create unique index to prevent duplicate imports within a workspace
-- Per-workspace uniqueness ensures each workspace independently manages import idempotency
-- Fingerprint IS NULL allowed for legacy rows (backward compatibility)
CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_transactions_workspace_fingerprint
ON raf.imported_transactions (workspace_id, fingerprint) WHERE fingerprint IS NOT NULL;

-- Create index for efficient fingerprint lookups
CREATE INDEX IF NOT EXISTS idx_imported_transactions_fingerprint_lookup
ON raf.imported_transactions (workspace_id, fingerprint);

COMMIT;
