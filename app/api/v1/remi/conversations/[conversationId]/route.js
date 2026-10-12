import { json, getDb, getHouseholdId } from '../../../_shared/http.js';
import { getRemiEntitlementForRequest } from '../../../../../../lib/entitlement/remiEntitlement.js';
import { conversationNotFoundResponse } from '../../../../../../lib/remi/remiGuards.js';

export async function GET(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const conversationId = context?.params?.conversationId;

  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  // Non-members get 404 (not 403) so workspace existence and conversation IDs are not enumerable.
  if (entitlement.reason === 'not_member' || entitlement.reason === 'invalid_context') {
    return conversationNotFoundResponse();
  }
  if (!entitlement.authorized) {
    return json({ error: 'Conversation history requires a paid Remi plan', tier: 'free' }, 403);
  }

  // Ownership-scoped: returns null / [] unless userId owns the conversation in this workspace.
  const conversation = await db.transaction((tx) => tx.getRemiConversation({ conversationId, householdId, userId }));
  if (!conversation) {
    return conversationNotFoundResponse();
  }

  const messages = await db.transaction((tx) => tx.listRemiMessages({ conversationId, householdId, userId }));
  return json({ conversation, messages });
}
