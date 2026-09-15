-- Goal Funding from Transaction Splits
--
-- Adds linked_goal_id to transaction_splits so that a split portion of a
-- transaction can be attributed to a goal directly. This enables multi-goal
-- attribution from one transaction via existing split semantics.
--
-- Attribution rule (enforced in the application layer):
--   • If a transaction has NO splits: transaction.linked_goal_id drives progress.
--   • If a transaction HAS splits: split.linked_goal_id drives progress for each
--     split; the parent transaction's linked_goal_id is ignored for goal progress
--     (only split amounts count — no double-counting).
--
-- Workspace-scoped FK mirrors the goals table relationship and the existing
-- transaction_splits workspace policy.

ALTER TABLE raf.transaction_splits
  ADD COLUMN IF NOT EXISTS linked_goal_id uuid NULL;

ALTER TABLE raf.transaction_splits
  DROP CONSTRAINT IF EXISTS transaction_splits_goal_fk;

ALTER TABLE raf.transaction_splits
  ADD CONSTRAINT transaction_splits_goal_fk
  FOREIGN KEY (linked_goal_id, workspace_id)
  REFERENCES raf.goals(id, workspace_id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_splits_by_goal
  ON raf.transaction_splits (workspace_id, linked_goal_id)
  WHERE linked_goal_id IS NOT NULL;
