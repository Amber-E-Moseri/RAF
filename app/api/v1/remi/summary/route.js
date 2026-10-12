import { z } from 'zod';

import { json, getDb, getHouseholdId } from '../../_shared/http.js';
import { buildFinancialContext } from '../../../../../lib/remi/financialContext.js';
import { REMI_SYSTEM_PROMPT, buildFinancialContextBlock } from '../../../../../lib/remi/prompts.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';
import { loadRemiConfig } from '../../../../../lib/server/env.js';
import {
  parseRemiQuery,
  invalidRequestResponse,
  checkRemiThrottle,
  rateLimitedResponse,
  createRemiAnthropicClient,
  createRemiBudget,
  callBudgetedModel,
  remiErrorResponse,
  RemiIncompleteError,
} from '../../../../../lib/remi/remiGuards.js';

const ROUTE = 'summary';

const summaryQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

export async function GET(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  const url = new URL(request.url);
  const query = parseRemiQuery(url, summaryQuerySchema, ['month']);
  if (!query.ok) return invalidRequestResponse();
  const month = query.data.month ?? null; // YYYY-MM

  // Per-user throttle before any entitlement, DB or model work.
  const config = loadRemiConfig();
  const throttle = checkRemiThrottle({ userId, workspaceId, config });
  if (!throttle.allowed) return rateLimitedResponse(throttle.retryAfterSeconds);

  // Tier gate. Entitlement is derived at request time (never stale).
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized && Boolean(apiKey);

  // FREE: metrics and basic snapshot only (no AI). The snapshot itself is built from the
  // financial context, so the context is still loaded here; the response shape is unchanged.
  if (!isPaid) {
    const ctx = await buildFinancialContext({ db, householdId, months: 1 });
    const contextBlock = buildFinancialContextBlock(ctx);
    return json({
      tier: 'free',
      month: month ?? ctx.periodTo.slice(0, 7),
      summary: `Here's your financial snapshot:\n\n${contextBlock}\n\nUpgrade to the paid plan for an AI-generated personalized summary and recommendations.`,
      metrics: {
        avgMonthlyIncome: ctx.income.avgMonthly,
        avgMonthlySpending: ctx.spending.avgMonthly,
        savingsRate: ctx.savingsRate,
        debtCount: ctx.debts.length,
        goalCount: ctx.goals.length,
      },
    });
  }

  // PAID: AI-generated personalized summary. Context is loaded only on this branch.
  const ctx = await buildFinancialContext({ db, householdId, months: 1 });
  const contextBlock = buildFinancialContextBlock(ctx);
  const budget = createRemiBudget({ db, householdId, config, route: ROUTE });

  let response;
  try {
    const client = createRemiAnthropicClient({ apiKey, config });
    const payload = {
      model: 'claude-sonnet-5',
      max_tokens: 800,
      system: REMI_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Please generate a monthly financial summary for ${month ?? ctx.periodTo.slice(0, 7)}.\n\n${contextBlock}\n\nProvide:\n1. Overall financial health assessment (1-2 sentences)\n2. Top 2-3 wins this month\n3. Top 1-2 areas to improve\n4. One specific action item for next month\n\nKeep it encouraging and actionable.`,
        },
      ],
    };
    ({ response } = await callBudgetedModel({ client, budget, payload }));
    if (response.stop_reason === 'max_tokens') throw new RemiIncompleteError('max_tokens');
  } catch (error) {
    return remiErrorResponse(error, ROUTE);
  }

  const summary = response.content.find((block) => block.type === 'text')?.text?.trim() ?? '';
  if (!summary) return remiErrorResponse(new RemiIncompleteError('empty_reply'), ROUTE);
  const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

  return json({
    tier: 'paid',
    month: month ?? ctx.periodTo.slice(0, 7),
    summary,
    tokensUsed,
    metrics: {
      avgMonthlyIncome: ctx.income.avgMonthly,
      avgMonthlySpending: ctx.spending.avgMonthly,
      savingsRate: ctx.savingsRate,
      debtCount: ctx.debts.length,
      goalCount: ctx.goals.length,
    },
  });
}
