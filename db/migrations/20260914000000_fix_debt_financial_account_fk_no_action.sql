-- Corrective migration: re-establish debts_financial_account_fk with ON DELETE NO ACTION.
--
-- The original migration (20260913000000_debt_financial_account_link.sql) was applied
-- to persistent databases with ON DELETE SET NULL semantics before the authority-bypass
-- risk was identified. ON DELETE SET NULL allows a direct deletion of a financial_account
-- row to silently null financial_account_id on linked debts, bypassing the safe-unlink
-- confirmed-balance boundary in the service layer.
--
-- This corrective migration is safe for databases that already ran the original migration
-- (drops and recreates the constraint) and idempotent for fresh databases where the
-- original migration was already written with ON DELETE NO ACTION (same result).
--
-- Workspace CASCADE deletion is unaffected: financial_accounts and debts both cascade
-- from workspaces simultaneously, so the FK deferral resolves after both are removed.

ALTER TABLE raf.debts
DROP CONSTRAINT IF EXISTS debts_financial_account_fk;

ALTER TABLE raf.debts
ADD CONSTRAINT debts_financial_account_fk
FOREIGN KEY (financial_account_id, workspace_id)
REFERENCES raf.financial_accounts(id, workspace_id)
ON DELETE NO ACTION;
