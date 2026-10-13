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
 * Bounds: at most MAX_TOOL_ROUNDS tool rounds, and one wall-clock budget per request.
 * Upstream failures surface as RemiUpstreamError (sanitized) — see anthropicClient.js.
 */

import { buildRemiSystemPrompt, buildKnowledgeBaseReply } from './prompts.js';
import { REMI_TOOLS } from './tools.js';
import { dispatchToolCall } from './toolHandlers.js';
import {
  REMI_REQUEST_BUDGET_MS,
  REMI_UPSTREAM_MAX_RETRIES,
  REMI_UPSTREAM_TIMEOUT_MS,
  createMessageSafely,
  createRemiClient,
  extractText,
} from './anthropicClient.js';

export const MAX_TOOL_ROUNDS = 6;
export const MAX_TOKENS_PER_CALL = 2048;
export const TOOL_LIMIT_REPLY =
  'I could not finish gathering the details for that request. Please ask a narrower question.';

// ── Paid tier: full agentic loop ──────────────────────────────────────────────

// Upstream failures propagate as RemiUpstreamError (sanitized, see anthropicClient.js). The
// route maps them to a generic response (remiGuards.remiModelFailureResponse). Upstream text is
// never returned or logged raw.
export async function generateRemiResponse({
  db,
  householdId,
  userMessage,
  conversationHistory = [],
  apiKey,
  config = null,
  client: injectedClient = null,
  requestBudgetMs = REMI_REQUEST_BUDGET_MS,
}) {
  const timeoutMs = config?.anthropicTimeoutMs ?? REMI_UPSTREAM_TIMEOUT_MS;
  const client = injectedClient ?? createRemiClient(apiKey, {
    timeoutMs,
    maxRetries: config?.anthropicMaxRetries ?? REMI_UPSTREAM_MAX_RETRIES,
  });
  const deadline = Date.now() + requestBudgetMs;

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
    ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const callModel = () => createMessageSafely(client, {
    max_tokens: MAX_TOKENS_PER_CALL,
    system: systemPrompt,
    tools: REMI_TOOLS,
    messages,
  }, { deadline, timeoutMs });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let rounds = 0;

  let response = await callModel();
  totalInputTokens += response.usage?.input_tokens ?? 0;
  totalOutputTokens += response.usage?.output_tokens ?? 0;

  // Agentic loop: keep running until the model stops calling tools or we hit the round limit.
  while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
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
    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;
  }

  const tokensUsed = totalInputTokens + totalOutputTokens;

  // Round limit reached while the model still wants tools: say so explicitly. Never return
  // an empty or partial answer as if it were complete.
  if (response.stop_reason === 'tool_use') {
    return { reply: TOOL_LIMIT_REPLY, tokensUsed, truncated: true };
  }

  return { reply: extractText(response), tokensUsed, truncated: false };
}

// ── Free tier: static knowledge base (no AI call) ────────────────────────────

export async function generateKnowledgeBaseResponse(userMessage) {
  return {
    reply: buildKnowledgeBaseReply(userMessage),
    tokensUsed: 0,
  };
}
