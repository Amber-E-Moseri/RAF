-- File-level idempotency for the CSV import batch path.
--
-- Problem: the same bank statement file can be uploaded twice, creating
-- duplicate batches with duplicate imported rows requiring manual cleanup.
--
-- Solution: persist a SHA-256 hash of the uploaded file content in
-- import_batches. A partial unique index prevents the same file from
-- being processed twice within the same workspace.
--
-- Design decisions:
--   UNIQUENESS BOUNDARY: workspace_id only (not account_id).
--   A file is workspace-scoped: re-uploading the same bytes to the same
--   workspace is always a duplicate regardless of which account it is
--   assigned to. Two separate workspaces may import the same file
--   independently.
--
--   PARTIAL INDEX (WHERE file_hash IS NOT NULL): legacy batches without
--   a hash and future paths (PDF) that do not yet carry a hash remain
--   unconstrained.
--
--   CONTENT IDENTITY VS STATEMENT IDENTITY: the hash identifies
--   identical bytes only. Two exports of the same bank statement period
--   with different timestamps or metadata produce different bytes and
--   different hashes; this constraint does not prevent them.
--   That distinction is intentional: without a stable bank-provided
--   statement ID the file bytes are the only provable identity.
--
--   SCOPE: CSV batch path only (uploadImportBatch). The PDF path uses
--   raf.imported_transactions directly and is scoped for a later phase.

BEGIN;

ALTER TABLE raf.import_batches
  ADD COLUMN IF NOT EXISTS file_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_batches_workspace_file_hash
  ON raf.import_batches (workspace_id, file_hash)
  WHERE file_hash IS NOT NULL;

COMMIT;
