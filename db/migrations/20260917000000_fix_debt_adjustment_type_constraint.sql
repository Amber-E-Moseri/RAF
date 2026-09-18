-- Fix debt_adjustments CHECK constraint to include 'reconciliation' type
-- that is emitted by production code (establishManualAuthorityBoundary)
-- but currently rejected by the database constraint.

BEGIN;

ALTER TABLE raf.debt_adjustments
DROP CONSTRAINT debt_adjustments_adjustment_type_check;

ALTER TABLE raf.debt_adjustments
ADD CONSTRAINT debt_adjustments_adjustment_type_check
  CHECK (adjustment_type IN ('interest', 'fee', 'correction', 'reconciliation'));

COMMIT;
