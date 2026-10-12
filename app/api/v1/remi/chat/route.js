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

  // FREE: knowledge-base response (no Anthropic call, no history)
  if (!isPaid || !apiKey) {
    const { reply, tokensUsed } = await generateKnowledgeBaseResponse(message.trim());
    return json({ reply, tier: 'free', tokensUsed });
  }

  // PAID: full Remi with conversation history
  let history = [];
  let activeConversationId = conversationId ?? null;

  if (activeConversationId) {
    // Ownership is enforced by the adapter. A conversation id that is foreign, stale or malformed
    // is treated like a missing one, so the reply starts a new conversation owned by this user.
    const conv = await db.transaction((tx) => tx.getRemiConversation({ conversationId: activeConversationId, householdId, userId }));
    if (conv) {
      const msgs = await db.transaction((tx) => tx.listRemiMessages({ conversationId: activeConversationId, householdId, userId }));
      history = msgs;
    } else {
      activeConversationId = null;
    }
  }

  if (!activeConversationId) {
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

  const saved = await db.transaction(async (tx) => {
    const userRow = await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, userId, role: 'user', content: message.trim(), tokensUsed: 0 });
    if (!userRow) return false;
    await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, userId, role: 'assistant', content: reply, tokensUsed });
    return true;
  });
  if (!saved) {
    return json({ error: 'Conversation not found' }, 404);
  }

  return json({ reply, conversationId: activeConversationId, tier: 'paid', tokensUsed });
}
