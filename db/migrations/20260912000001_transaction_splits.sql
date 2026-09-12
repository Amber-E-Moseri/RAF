-- Split Transactions (Phase 2 / Branch 2)
--
-- A transaction_split row represents one portion of a parent transaction
-- attributed to a specific category. When splits exist, they collectively
-- own category attribution; the parent's category_id is ignored in reports.
-- When no splits exist, the parent transaction is attributed as normal.
--
-- Application invariant: sum(split.amount) must equal parent.amount.
-- No UNIQUE(transaction_id, category_id): the same category may appear
-- more than once in a split (e.g. two separate grocery purchases in one
-- bank statement entry).

CREATE TABLE raf.transaction_splits (
  id          uuid          NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid         NOT NULL,
  transaction_id uuid       NOT NULL,
  amount      numeric(12,2) NOT NULL,
  category_id uuid          NULL,
  description text          NOT NULL DEFAULT '',
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT transaction_splits_pk PRIMARY KEY (id),
  CONSTRAINT transaction_splits_workspace_unique UNIQUE (id, workspace_id),
  CONSTRAINT transaction_splits_amount_positive CHECK (amount > 0),
  CONSTRAINT transaction_splits_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES raf.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT transaction_splits_transaction_fk
    FOREIGN KEY (transaction_id, workspace_id)
    REFERENCES raf.transactions(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT transaction_splits_category_fk
    FOREIGN KEY (category_id, workspace_id)
    REFERENCES raf.allocation_categories(id, workspace_id)
);

CREATE INDEX idx_transaction_splits_by_transaction
  ON raf.transaction_splits (workspace_id, transaction_id);

-- RLS: mirrors raf.transactions policy
ALTER TABLE raf.transaction_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE raf.transaction_splits FORCE ROW LEVEL SECURITY;

CREATE POLICY transaction_splits_workspace_policy ON raf.transaction_splits
  USING (
    workspace_id = raf.current_workspace_id()
    AND raf.has_workspace_membership(workspace_id)
  )
  WITH CHECK (
    workspace_id = raf.current_workspace_id()
    AND raf.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'member']::raf.workspace_role[])
  );
