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
    const conv = await db.transaction((tx) => tx.getRemiConversation({ conversationId: activeConversationId, householdId }));
    if (conv) {
      const msgs = await db.transaction((tx) => tx.listRemiMessages({ conversationId: activeConversationId, householdId }));
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

  await db.transaction(async (tx) => {
    await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, role: 'user', content: message.trim(), tokensUsed: 0 });
    await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, role: 'assistant', content: reply, tokensUsed });
  });

  return json({ reply, conversationId: activeConversationId, tier: 'paid', tokensUsed });
}
