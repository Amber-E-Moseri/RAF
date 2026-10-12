/**
 * Remi assistant — agentic tool loop.
 *
 * Architecture:
 *   User message
 *     → Claude chooses which RAF domain tool(s) to call
 *     → dispatchToolCall fetches from RAF engine (never self-calculates)
 *     → Claude interprets the result and either calls more tools or replies
 *
 * RAF calculates. Remi understands, explains, compares, helps the user act.
 *
 * Every upstream call goes through callBudgetedModel (remiGuards.js): budget reserved first,
 * reconciled after. Exhaustion, an incomplete reply, or an upstream failure throws, and the
 * route maps it to an explicit error. An empty or truncated reply is never returned.
 */

import { buildRemiSystemPrompt, buildKnowledgeBaseReply } from './prompts.js';
import { REMI_TOOLS } from './tools.js';
import { dispatchToolCall } from './toolHandlers.js';
import {
  createRemiAnthropicClient,
  callBudgetedModel,
  limitRemiHistory,
  REMI_LIMITS,
  RemiIncompleteError,
} from './remiGuards.js';

// ── Paid tier: full agentic loop ──────────────────────────────────────────────

// Throws RemiBudgetExhaustedError, RemiIncompleteError or an Anthropic/SDK error. The route
// maps them to a generic client response (remiGuards.remiErrorResponse).
export async function generateRemiResponse({
  db,
  householdId,
  userMessage,
  conversationHistory = [],
  apiKey,
  config,
  budget,
  client: injectedClient = null,
}) {
  if (!budget) {
    // Fail closed: without a budget gate no upstream call is allowed.
    throw new Error('Remi usage budget gate is required.');
  }
  const client = injectedClient ?? createRemiAnthropicClient({ apiKey, config });

  const today = new Date().toISOString().slice(0, 10);
  const activeMonth = today.slice(0, 7) + '-01';

  let householdName = null;
  try {
    const hh = await db.transaction((tx) => tx.getHousehold({ householdId }));
    householdName = hh?.name ?? null;
  } catch {
    // non-critical — system prompt degrades gracefully
  }

  const systemPrompt = buildRemiSystemPrompt({ householdName, activeMonth, today });

  const messages = [
    ...limitRemiHistory(conversationHistory).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let tokensSpent = 0;
  const callModel = async () => {
    const payload = {
      model: 'claude-sonnet-5',
      max_tokens: REMI_LIMITS.maxOutputTokens,
      system: systemPrompt,
      tools: REMI_TOOLS,
      messages,
    };
    const { response, tokens } = await callBudgetedModel({
      client,
      budget,
      payload,
      requestTokensSpent: tokensSpent,
    });
    tokensSpent += tokens;
    return response;
  };

  let response = await callModel();
  let rounds = 0;

  // Agentic loop: the model keeps calling tools until it replies or the round cap is hit.
  while (response.stop_reason === 'tool_use') {
    if (rounds >= REMI_LIMITS.maxToolRounds) {
      throw new RemiIncompleteError('tool_rounds');
    }
    rounds++;

    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');

    // Run all tool calls from this response (may be multiple in parallel)
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await dispatchToolCall({
          name: block.name,
          input: block.input ?? {},
          db,
          householdId,
        });

        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      }),
    );

    messages.push(
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    );

    response = await callModel();
  }

  if (response.stop_reason === 'max_tokens') {
    throw new RemiIncompleteError('max_tokens');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const reply = (textBlock?.text ?? '').trim();
  if (!reply) {
    throw new RemiIncompleteError('empty_reply');
  }

  return { reply, tokensUsed: tokensSpent };
}

// ── Free tier: static knowledge base (no AI call) ────────────────────────────

export async function generateKnowledgeBaseResponse(userMessage) {
  return {
    reply: buildKnowledgeBaseReply(userMessage),
    tokensUsed: 0,
  };
}
