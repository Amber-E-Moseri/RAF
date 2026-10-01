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

  const conversation = await db.transaction((tx) => tx.getRemiConversation({ conversationId, householdId }));
  if (!conversation) {
    return json({ error: 'Conversation not found' }, 404);
  }

  const messages = await db.transaction((tx) => tx.listRemiMessages({ conversationId, householdId }));
  return json({ conversation, messages });
}
