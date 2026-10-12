-- Enforce Remi conversation ownership in PostgreSQL RLS (defense in depth).
--
-- Before: remi_conversations and remi_messages were scoped by workspace membership only.
-- Any active member of a workspace could SELECT, and INSERT messages into, another member's
-- private conversation if they knew its id.
--
-- After:
--   - A conversation is visible and writable only by its owner (user_id = current app user)
--     inside the current workspace, and only while the caller is still an active member.
--   - A message is visible and writable only when its parent conversation is owned by the
--     current app user.
--
-- The application layer (lib/server/postgresDb.js) enforces the same rule in SQL. This policy
-- is the second layer, so a missing check in application code cannot leak data.
-- Table owners and BYPASSRLS roles are unaffected.

BEGIN;

DROP POLICY IF EXISTS remi_conversations_workspace_policy ON raf.remi_conversations;
CREATE POLICY remi_conversations_owner_policy ON raf.remi_conversations
USING (
  workspace_id = raf.current_workspace_id()
  AND user_id = raf.current_app_user_id()
  AND raf.has_workspace_membership(workspace_id)
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND user_id = raf.current_app_user_id()
  AND raf.has_workspace_membership(workspace_id)
);

DROP POLICY IF EXISTS remi_messages_workspace_policy ON raf.remi_messages;
CREATE POLICY remi_messages_owner_policy ON raf.remi_messages
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
  AND EXISTS (
    SELECT 1
    FROM raf.remi_conversations c
    WHERE c.id = remi_messages.conversation_id
      AND c.workspace_id = remi_messages.workspace_id
      AND c.user_id = raf.current_app_user_id()
  )
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
  AND EXISTS (
    SELECT 1
    FROM raf.remi_conversations c
    WHERE c.id = remi_messages.conversation_id
      AND c.workspace_id = remi_messages.workspace_id
      AND c.user_id = raf.current_app_user_id()
  )
);

COMMIT;
