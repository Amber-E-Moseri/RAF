import { json, getDb, getHouseholdId } from '../../../_shared/http.js';
import { getRemiEntitlementForRequest } from '../../../../../../lib/entitlement/remiEntitlement.js';

export async function GET(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const conversationId = context?.params?.conversationId;

  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  if (!entitlement.authorized) {
    return json({ error: 'Conversation history requires a paid Remi plan', tier: 'free' }, 403);
  }

  // Owner-only. A foreign, malformed or nonexistent id gets the same 404, so nothing is disclosed.
  const conversation = await db.transaction((tx) => tx.getRemiConversation({ conversationId, householdId, userId }));
  if (!conversation) {
    return json({ error: 'Conversation not found' }, 404);
  }

  const messages = await db.transaction((tx) => tx.listRemiMessages({ conversationId, householdId, userId }));
  return json({ conversation, messages });
}
