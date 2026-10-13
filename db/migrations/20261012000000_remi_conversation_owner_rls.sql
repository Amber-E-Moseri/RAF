-- Tighten Remi conversation RLS to owner scope.
--
-- Previously remi_conversations / remi_messages were visible to any active
-- workspace member. Conversations are private to the user who created them,
-- so visibility now also requires the session user (raf.user_id, read via
-- raf.current_app_user_id()) to own the conversation.
--
-- Session-user support: routerLoader scopes every route transaction with
-- { userId, workspaceId }, which the adapter applies via set_config(). The
-- helper raf.current_app_user_id() already exists (20260903090000). If the
-- session user is unset, user_id = NULL evaluates to not-visible (fail closed).
--
-- Application-layer ownership checks in lib/server/postgresDb.js remain the
-- primary control; this policy is defense in depth.
--
-- Idempotent: each policy is dropped with IF EXISTS before recreation.

DROP POLICY IF EXISTS remi_conversations_workspace_policy ON raf.remi_conversations;
CREATE POLICY remi_conversations_workspace_policy ON raf.remi_conversations
USING (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
  AND user_id = raf.current_app_user_id()
)
WITH CHECK (
  workspace_id = raf.current_workspace_id()
  AND raf.has_workspace_membership(workspace_id)
  AND user_id = raf.current_app_user_id()
);

DROP POLICY IF EXISTS remi_messages_workspace_policy ON raf.remi_messages;
CREATE POLICY remi_messages_workspace_policy ON raf.remi_messages
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
