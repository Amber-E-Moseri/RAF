import { json, getDb, getHouseholdId, buildErrorBody } from '../../_shared/http.js';
import { generateRemiResponse, generateKnowledgeBaseResponse } from '../../../../../lib/remi/remiAssistant.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';
import { RemiUpstreamError, logUpstreamFailure } from '../../../../../lib/remi/anthropicClient.js';
import { remiChatBodySchema, firstIssueMessage } from '../../../../../lib/remi/requestSchemas.js';
import { remiUsageLimits, rateLimitedBody } from '../../../../../lib/remi/usageLimiter.js';

export async function POST(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  let raw;
  try {
    raw = await request.json();
  } catch {
    return json(buildErrorBody({ status: 400, message: 'Invalid JSON body' }), 400);
  }

  const parsed = remiChatBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return json(buildErrorBody({ status: 400, message: firstIssueMessage(parsed.error) }), 400);
  }
  const message = parsed.data.message;
  const conversationId = parsed.data.conversationId ?? null;

  // Derive entitlement from workspace (request-time, never stale)
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized;

  // Usage protection applies to every chat request from this user in this workspace.
  const usage = remiUsageLimits.chat.consume(`${workspaceId}:${userId}`);
  if (!usage.allowed) {
    return json(rateLimitedBody(usage.retryAfterSeconds), 429);
  }

  // FREE: knowledge-base response (no Anthropic call, no history)
  if (!isPaid || !apiKey) {
    const { reply, tokensUsed } = await generateKnowledgeBaseResponse(message);
    return json({ reply, tier: 'free', tokensUsed });
  }

  // PAID: load history only if the conversation belongs to this user in this workspace.
  // Foreign, stale or malformed ids are treated as missing: nothing is disclosed.
  let history = [];
  let ownedConversation = false;
  if (conversationId) {
    const conv = await db.transaction((tx) => tx.getRemiConversation({ conversationId, householdId, userId }));
    if (conv) {
      ownedConversation = true;
      history = await db.transaction((tx) => tx.listRemiMessages({ conversationId, householdId, userId }));
    }
  }

  // Generate first. A failed upstream call leaves nothing behind (no empty conversation).
  let generated;
  try {
    generated = await generateRemiResponse({
      db,
      householdId,
      userMessage: message,
      conversationHistory: history,
      apiKey,
    });
  } catch (err) {
    if (err instanceof RemiUpstreamError) {
      logUpstreamFailure(err, { route: 'remi.chat' });
      return json(buildErrorBody({ status: err.status, message: err.message }), err.status);
    }
    throw err;
  }
  const { reply, tokensUsed, truncated } = generated;

  const result = await db.transaction(async (tx) => {
    let activeConversationId = ownedConversation ? conversationId : null;
    if (!activeConversationId) {
      const conv = await tx.createRemiConversation({ householdId, userId, title: message.slice(0, 60) });
      activeConversationId = conv.id;
    }
    const userRow = await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, userId, role: 'user', content: message, tokensUsed: 0 });
    if (!userRow) return null;
    await tx.appendRemiMessage({ conversationId: activeConversationId, householdId, userId, role: 'assistant', content: reply, tokensUsed });
    return activeConversationId;
  });
  if (!result) {
    return json(buildErrorBody({ status: 404, message: 'Conversation not found' }), 404);
  }

  return json({ reply, conversationId: result, tier: 'paid', tokensUsed, truncated });
}
