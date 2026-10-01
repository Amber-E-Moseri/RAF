-- Deterministic economic-event identity for imported statement rows.
--
-- Three identities are kept distinct:
--   A. source identity     - the staged row in raf.imported_transactions (+ batch provenance in raw_json)
--   B. candidate event     - (event_key, event_ordinal): hash of date + signed amount + normalized
--                            description, plus the Nth occurrence of that key within one source
--   C. canonical identity  - the RAF transaction / income entry the event resolved to
--
-- A claim maps B -> C. Uniqueness is enforced only where it is provable:
--   * account-bound events: one claim per (workspace, account, event_key, event_ordinal)
--   * one claim per canonical record: an existing transaction cannot stand for two events
-- When the statement account is unknown (account_id IS NULL) uniqueness is NOT enforced in the
-- database; the application requires explicit user resolution instead of guessing.
--
-- No data is rewritten. Existing imported transactions have no claims and are protected by
-- the "likely" (explicit confirmation) path.
--
-- One existing constraint is corrected (see the first statement): the composite
-- ON DELETE SET NULL on imported_transactions.linked_transaction_id also nulled the NOT NULL
-- workspace_id, so deleting a transaction that came from an import (or un-processing the
-- imported row) failed with SQLSTATE 23502. Re-creating and re-importing a reconciled event
-- depends on those two operations working.

BEGIN;

ALTER TABLE raf.imported_transactions
  DROP CONSTRAINT IF EXISTS imported_transactions_linked_transaction_fk;

ALTER TABLE raf.imported_transactions
  ADD CONSTRAINT imported_transactions_linked_transaction_fk
  FOREIGN KEY (linked_transaction_id, workspace_id)
  REFERENCES raf.transactions(id, workspace_id)
  ON DELETE SET NULL (linked_transaction_id);

CREATE TABLE IF NOT EXISTS raf.import_event_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES raf.workspaces(id) ON DELETE CASCADE,
  account_id uuid,
  event_key text NOT NULL,
  event_ordinal int NOT NULL CHECK (event_ordinal >= 1),
  transaction_id uuid,
  income_entry_id uuid,
  claim_type text NOT NULL CHECK (claim_type IN ('created', 'reconciled_existing')),
  source text NOT NULL CHECK (source IN ('pdf_import', 'csv_import')),
  import_batch_id uuid,
  imported_transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT import_event_claims_single_target_chk
    CHECK ((transaction_id IS NOT NULL)::int + (income_entry_id IS NOT NULL)::int = 1),
  CONSTRAINT import_event_claims_transaction_fk FOREIGN KEY (transaction_id, workspace_id)
    REFERENCES raf.transactions(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT import_event_claims_income_fk FOREIGN KEY (income_entry_id, workspace_id)
    REFERENCES raf.income_entries(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT import_event_claims_account_fk FOREIGN KEY (account_id, workspace_id)
    REFERENCES raf.financial_accounts(id, workspace_id) ON DELETE SET NULL (account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_event_claims_account_event
  ON raf.import_event_claims (workspace_id, account_id, event_key, event_ordinal)
  WHERE account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_event_claims_transaction
  ON raf.import_event_claims (workspace_id, transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_event_claims_income_entry
  ON raf.import_event_claims (workspace_id, income_entry_id)
  WHERE income_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_import_event_claims_workspace_event
  ON raf.import_event_claims (workspace_id, event_key, event_ordinal);

CREATE INDEX IF NOT EXISTS idx_import_event_claims_imported_transaction
  ON raf.import_event_claims (workspace_id, imported_transaction_id)
  WHERE imported_transaction_id IS NOT NULL;

ALTER TABLE raf.import_event_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE raf.import_event_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_event_claims_workspace_policy ON raf.import_event_claims;
CREATE POLICY import_event_claims_workspace_policy ON raf.import_event_claims
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::raf.workspace_role[])
);

COMMIT;
