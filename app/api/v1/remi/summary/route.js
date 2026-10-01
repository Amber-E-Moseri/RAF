import { json, getDb, getHouseholdId } from '../../_shared/http.js';
import { buildFinancialContext } from '../../../../../lib/remi/financialContext.js';
import { REMI_SYSTEM_PROMPT, buildFinancialContextBlock } from '../../../../../lib/remi/prompts.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';
import Anthropic from '@anthropic-ai/sdk';

export async function GET(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  const url = new URL(request.url);
  const month = url.searchParams.get('month'); // YYYY-MM

  // Derive entitlement from workspace (request-time, never stale)
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized;

  const ctx = await buildFinancialContext({ db, householdId, months: 1 });
  const contextBlock = buildFinancialContextBlock(ctx);

  // FREE: metrics and basic snapshot only (no AI)
  if (!isPaid || !apiKey) {
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

  // PAID: AI-generated personalized summary
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 800,
    system: REMI_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Please generate a monthly financial summary for ${month ?? ctx.periodTo.slice(0, 7)}.\n\n${contextBlock}\n\nProvide:\n1. Overall financial health assessment (1-2 sentences)\n2. Top 2-3 wins this month\n3. Top 1-2 areas to improve\n4. One specific action item for next month\n\nKeep it encouraging and actionable.`,
      },
    ],
  });

  const summary = response.content[0]?.type === 'text' ? response.content[0].text : '';
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
