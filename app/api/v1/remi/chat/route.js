import { json, getDb, getHouseholdId } from '../../_shared/http.js';
import { generateRemiResponse, generateKnowledgeBaseResponse } from '../../../../../lib/remi/remiAssistant.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';
import { loadRemiConfig } from '../../../../../lib/server/env.js';
import { chatBodySchema } from '../../../../../lib/remi/validation.js';
import {
  REMI_LIMITS,
  parseRemiBody,
  invalidRequestResponse,
  checkRemiThrottle,
  rateLimitedResponse,
  checkRemiDailyCap,
  dailyLimitResponse,
  conversationNotFoundResponse,
  createRemiBudget,
  remiErrorResponse,
  persistenceFailureResponse,
} from '../../../../../lib/remi/remiGuards.js';

const ROUTE = 'chat';
const OWNERSHIP_LOST = 'REMI_CONVERSATION_OWNERSHIP_LOST';


export async function POST(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  // Validation first. Malformed input never reaches the limiter, entitlement, the DB, or Anthropic.
  const parsed = await parseRemiBody(request, chatBodySchema);
  if (!parsed.ok) return invalidRequestResponse();
  const { message } = parsed.data;
  const conversationId = parsed.data.conversationId ?? null;

  // Per-user throttle for every authenticated chat request (free and paid).
  const config = loadRemiConfig();
  const throttle = checkRemiThrottle({ userId, workspaceId, config });
  if (!throttle.allowed) return rateLimitedResponse(throttle.retryAfterSeconds);

  // Entitlement (membership + workspace tier) is derived at request time.
  // Auth and membership were already enforced by the router before this handler runs.
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized;

  // Non-members (and an unresolvable session) get the same 404 as an unowned
  // conversation, so the response does not reveal workspace membership.
  if (entitlement.reason === 'not_member' || entitlement.reason === 'invalid_context') {
    return conversationNotFoundResponse();
  }

  // FREE: knowledge-base response (no Anthropic call, no history, no persistence).
  if (!isPaid || !apiKey) {
    const { reply, tokensUsed } = await generateKnowledgeBaseResponse(message);
    return json({ reply, tier: 'free', tokensUsed });
  }

  // PAID: daily message cap, then history, then the budgeted model call.
  const dailyCap = await checkRemiDailyCap({ db, householdId, config, route: ROUTE });
  if (!dailyCap.allowed) return dailyLimitResponse();

  let history = [];
  if (conversationId) {
    const conv = await db.transaction((tx) => tx.getRemiConversation({ householdId, conversationId, userId }));
    // Null for unknown or non-owned conversations: nothing is read or written.
    if (!conv) return conversationNotFoundResponse();
    history = await db.transaction((tx) => tx.listRemiMessages({ householdId, conversationId, userId }));
  }

  // Generate the reply BEFORE any write. A failed, exhausted or incomplete model call leaves
  // no conversation row and no message row.
  const budget = createRemiBudget({ db, householdId, config, route: ROUTE });
  let result;
  try {
    result = await generateRemiResponse({
      db,
      householdId,
      userMessage: message,
      conversationHistory: history,
      apiKey,
      config,
      budget,
    });
  } catch (error) {
    return remiErrorResponse(error, ROUTE);
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
      // appendRemiMessage returns null (no write) when the session user does not own the
      // conversation; that aborts the transaction so both turns commit or neither does.
      const userRow = await tx.appendRemiMessage({ conversationId: convId, householdId, userId, role: 'user', content: message, tokensUsed: 0 });
      if (userRow === null) throw Object.assign(new Error(OWNERSHIP_LOST), { code: OWNERSHIP_LOST });
      const assistantRow = await tx.appendRemiMessage({
        conversationId: convId,
        householdId,
        userId,
        role: 'assistant',
        content: result.reply,
        tokensUsed: result.tokensUsed,
      });
      if (assistantRow === null) throw Object.assign(new Error(OWNERSHIP_LOST), { code: OWNERSHIP_LOST });
      return convId;
    });
  } catch (error) {
    if (error?.code === OWNERSHIP_LOST) return conversationNotFoundResponse();
    return persistenceFailureResponse(error, ROUTE);
  }

  return json({
    reply: result.reply,
    conversationId: activeConversationId,
    tier: 'paid',
    tokensUsed: result.tokensUsed,
  });
}
