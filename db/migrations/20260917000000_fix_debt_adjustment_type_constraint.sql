-- Fix debt_adjustments CHECK constraint:
-- 1. Add 'reconciliation' — emitted by establishManualAuthorityBoundary on account unlink,
--    but rejected by the original ('interest','fee','correction') constraint.
-- 2. Add 'manual' — legacy rows exist in production pre-dating the constraint formalization.

BEGIN;

ALTER TABLE raf.debt_adjustments
DROP CONSTRAINT debt_adjustments_adjustment_type_check;

ALTER TABLE raf.debt_adjustments
ADD CONSTRAINT debt_adjustments_adjustment_type_check
  CHECK (adjustment_type IN ('interest', 'fee', 'correction', 'reconciliation', 'manual'));

COMMIT;
