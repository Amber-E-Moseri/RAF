-- Widen the adjustment_type check constraint on raf.debt_adjustments to match
-- the full set of values the application layer accepts. The original constraint
-- only covered ('interest', 'fee', 'correction'), omitting 'manual', 'late_fee',
-- and 'reconciliation' which are valid in the domain and allowed by the Zod schema.

ALTER TABLE raf.debt_adjustments
  DROP CONSTRAINT IF EXISTS debt_adjustments_adjustment_type_check;

ALTER TABLE raf.debt_adjustments
  ADD CONSTRAINT debt_adjustments_adjustment_type_check
  CHECK (adjustment_type IN ('manual', 'correction', 'interest', 'fee', 'late_fee', 'reconciliation'));
