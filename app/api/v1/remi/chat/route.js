import { json, getDb, getHouseholdId } from '../../_shared/http.js';
import { generateRemiResponse, generateKnowledgeBaseResponse } from '../../../../../lib/remi/remiAssistant.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';

export async function POST(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { message, conversationId } = body ?? {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return json({ error: 'message is required' }, 400);
  }

  // Derive entitlement from workspace (request-time, never stale)
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized;

  // Non-members (and an unresolvable session) get the same 404 as an unowned
  // conversation, so the response does not reveal workspace membership.
  if (entitlement.reason === 'not_member' || entitlement.reason === 'invalid_context') {
    return json({ error: 'Conversation not found' }, 404);
  }

  // FREE: knowledge-base response (no Anthropic call, no history)
  if (!isPaid || !apiKey) {
    const { reply, tokensUsed } = await generateKnowledgeBaseResponse(message.trim());
    return json({ reply, tier: 'free', tokensUsed });
  }

  // PAID: full Remi with conversation history.
  // Ownership: a supplied conversationId must be owned by this user in this
  // workspace. Every other case (other member, other workspace, malformed or
  // unknown id) returns the same 404 so existence is not disclosed. We never
  // fall back to creating a new conversation or appending to someone else's.
  const notFound = () => json({ error: 'Conversation not found' }, 404);
  let history = [];
  let activeConversationId = null;

  if (conversationId !== undefined && conversationId !== null) {
    const conv = await db.transaction((tx) => tx.getRemiConversation({ conversationId, householdId, userId }));
    if (!conv) {
      return notFound();
    }
    activeConversationId = conversationId;
    history = await db.transaction((tx) => tx.listRemiMessages({ conversationId, householdId, userId }));
  } else {
    const conv = await db.transaction((tx) =>
      tx.createRemiConversation({ householdId, userId, title: message.trim().slice(0, 60) }),
    );
    activeConversationId = conv.id;
  }

  const { reply, tokensUsed } = await generateRemiResponse({
    db,
    householdId,
    userMessage: message.trim(),
    conversationHistory: history,
    apiKey,
  });

  // Both turns commit or neither does. appendRemiMessage returns null (no write)
  // when the session user does not own the conversation; that aborts the transaction.
  const OWNERSHIP_LOST = 'REMI_CONVERSATION_OWNERSHIP_LOST';
  try {
    await db.transaction(async (tx) => {
      const userRow = await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, userId, role: 'user', content: message.trim(), tokensUsed: 0 });
      if (userRow === null) throw Object.assign(new Error(OWNERSHIP_LOST), { code: OWNERSHIP_LOST });
      const assistantRow = await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, userId, role: 'assistant', content: reply, tokensUsed });
      if (assistantRow === null) throw Object.assign(new Error(OWNERSHIP_LOST), { code: OWNERSHIP_LOST });
    });
  } catch (error) {
    if (error?.code === OWNERSHIP_LOST) return notFound();
    throw error;
  }

  return json({ reply, conversationId: activeConversationId, tier: 'paid', tokensUsed });
}
