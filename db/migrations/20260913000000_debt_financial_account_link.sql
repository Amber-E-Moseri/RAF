ALTER TABLE raf.debts
ADD COLUMN IF NOT EXISTS financial_account_id uuid;

ALTER TABLE raf.debts
DROP CONSTRAINT IF EXISTS debts_financial_account_fk;

ALTER TABLE raf.debts
ADD CONSTRAINT debts_financial_account_fk
FOREIGN KEY (financial_account_id, workspace_id)
REFERENCES raf.financial_accounts(id, workspace_id)
ON DELETE NO ACTION;

CREATE INDEX IF NOT EXISTS idx_debts_workspace_financial_account
ON raf.debts (workspace_id, financial_account_id)
WHERE financial_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_one_active_debt_per_financial_account
ON raf.debts (workspace_id, financial_account_id)
WHERE financial_account_id IS NOT NULL AND is_active = true;
