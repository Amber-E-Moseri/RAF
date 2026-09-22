-- Allow 'buffer_disposition' as a valid transaction source.
-- Buffer dispositions are written atomically inside closeMonth when a
-- workspace has unused buffer remaining at month end.

BEGIN;

ALTER TABLE raf.transactions
  DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE raf.transactions
  ADD CONSTRAINT transactions_source_check
    CHECK (source IN ('manual', 'import', 'buffer_disposition'));

COMMIT;
