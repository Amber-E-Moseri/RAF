import { json, getDb, getHouseholdId } from '../../_shared/http.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';

export async function GET(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';

  // Derive entitlement from workspace (request-time, never stale)
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  if (!entitlement.authorized) {
    return json({ error: 'Conversation history requires a paid Remi plan', tier: 'free' }, 403);
  }

  const conversations = await db.transaction((tx) => tx.listRemiConversations({ householdId, userId }));
  return json({ conversations });
}
