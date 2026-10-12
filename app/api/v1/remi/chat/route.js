import { z } from 'zod';

import { json, getDb, getHouseholdId } from '../../_shared/http.js';
import { generateRemiResponse, generateKnowledgeBaseResponse } from '../../../../../lib/remi/remiAssistant.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';
import { loadRemiConfig } from '../../../../../lib/server/env.js';
import {
  parseRemiBody,
  invalidRequestResponse,
  checkRemiThrottle,
  rateLimitedResponse,
  checkRemiDailyCap,
  dailyLimitResponse,
  conversationNotFoundResponse,
  remiModelFailureResponse,
  persistenceFailureResponse,
} from '../../../../../lib/remi/remiGuards.js';

const ROUTE = 'chat';

const chatBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.uuid().nullish(),
});

export async function POST(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  // Validation first. Malformed input never reaches entitlement, the DB, or Anthropic.
  const parsed = await parseRemiBody(request, chatBodySchema);
  if (!parsed.ok) return invalidRequestResponse();
  const { message } = parsed.data;
  const conversationId = parsed.data.conversationId ?? null;

  // Entitlement (membership + workspace tier) is derived at request time.
  // Auth and membership were already enforced by the router before this handler runs.
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized;

  // FREE: knowledge-base response (no Anthropic call, no history, no persistence, no throttle).
  if (!isPaid || !apiKey) {
    const { reply, tokensUsed } = await generateKnowledgeBaseResponse(message);
    return json({ reply, tier: 'free', tokensUsed });
  }

  // PAID: every check below runs only for an authorised member on the paid path.
  const config = loadRemiConfig();

  const throttle = checkRemiThrottle({ userId, workspaceId, config });
  if (!throttle.allowed) return rateLimitedResponse(throttle.retryAfterSeconds);

  const dailyCap = await checkRemiDailyCap({ db, householdId, config, route: ROUTE });
  if (!dailyCap.allowed) return dailyLimitResponse();

  let history = [];
  if (conversationId) {
    const conv = await db.transaction((tx) => tx.getRemiConversation({ householdId, conversationId, userId }));
    // Null for unknown or non-owned conversations: nothing is read or written.
    if (!conv) return conversationNotFoundResponse();
    history = await db.transaction((tx) => tx.listRemiMessages({ householdId, conversationId, userId }));
  }

  // Generate the reply BEFORE any write. A failed model call leaves no conversation row.
  let result;
  try {
    result = await generateRemiResponse({
      db,
      householdId,
      userMessage: message,
      conversationHistory: history,
      apiKey,
      config,
    });
  } catch (error) {
    return remiModelFailureResponse(error, ROUTE);
  }

  // Persist user message, assistant message and (if new) the conversation in ONE transaction.
  let activeConversationId;
  try {
    activeConversationId = await db.transaction(async (tx) => {
      let convId = conversationId;
      if (!convId) {
        const conv = await tx.createRemiConversation({ householdId, userId, title: message.slice(0, 60) });
        convId = conv.id;
      }
      // appendRemiMessage returns null when the user does not own the conversation. Treat that
      // as a failed write so the transaction rolls back and no success response is returned.
      const userRow = await tx.appendRemiMessage({ conversationId: convId, householdId, userId, role: 'user', content: message, tokensUsed: 0 });
      const assistantRow = await tx.appendRemiMessage({
        conversationId: convId,
        householdId,
        userId,
        role: 'assistant',
        content: result.reply,
        tokensUsed: result.tokensUsed,
      });
      if (!userRow || !assistantRow) {
        throw new Error('Remi conversation write rejected: not owned by requesting user');
      }
      return convId;
    });
  } catch (error) {
    return persistenceFailureResponse(error, ROUTE);
  }

  return json({
    reply: result.reply,
    conversationId: activeConversationId,
    tier: 'paid',
    tokensUsed: result.tokensUsed,
  });
}
