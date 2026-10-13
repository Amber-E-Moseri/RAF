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
 */

import { buildRemiSystemPrompt, buildKnowledgeBaseReply } from './prompts.js';
import { REMI_TOOLS } from './tools.js';
import { dispatchToolCall } from './toolHandlers.js';
import { createRemiAnthropicClient } from './remiGuards.js';

const MAX_TOOL_ROUNDS = 6;

// ── Paid tier: full agentic loop ──────────────────────────────────────────────

// Anthropic errors propagate to the caller, which maps them to a generic client response
// (remiGuards.remiModelFailureResponse). Upstream text is never returned or logged raw.
export async function generateRemiResponse({
  db,
  householdId,
  userMessage,
  conversationHistory = [],
  apiKey,
  config,
  client: injectedClient = null,
}) {
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
    ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let rounds = 0;

  let response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    system: systemPrompt,
    tools: REMI_TOOLS,
    messages,
  });

  totalInputTokens += response.usage?.input_tokens ?? 0;
  totalOutputTokens += response.usage?.output_tokens ?? 0;

  // Agentic loop: keep running until the model stops calling tools or we hit the round limit
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

    response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2048,
      system: systemPrompt,
      tools: REMI_TOOLS,
      messages,
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const reply = textBlock?.text ?? '';
  const tokensUsed = totalInputTokens + totalOutputTokens;

  return { reply, tokensUsed };
}

// ── Free tier: static knowledge base (no AI call) ────────────────────────────

export async function generateKnowledgeBaseResponse(userMessage) {
  return {
    reply: buildKnowledgeBaseReply(userMessage),
    tokensUsed: 0,
  };
}
