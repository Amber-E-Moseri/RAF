import { json, getDb, getHouseholdId, buildErrorBody } from '../../_shared/http.js';
import { buildFinancialContext } from '../../../../../lib/remi/financialContext.js';
import { REMI_SYSTEM_PROMPT, buildFinancialContextBlock } from '../../../../../lib/remi/prompts.js';
import { getRemiEntitlementForRequest } from '../../../../../lib/entitlement/remiEntitlement.js';
import {
  REMI_UPSTREAM_TIMEOUT_MS,
  RemiUpstreamError,
  createMessageSafely,
  createRemiClient,
  extractText,
  logUpstreamFailure,
} from '../../../../../lib/remi/anthropicClient.js';
import { remiSummaryQuerySchema, firstIssueMessage } from '../../../../../lib/remi/requestSchemas.js';
import { remiUsageLimits, rateLimitedBody } from '../../../../../lib/remi/usageLimiter.js';

export async function GET(request, context) {
  const db = getDb(context);
  const householdId = getHouseholdId(request, context);
  const workspaceId = context?.workspaceId ?? householdId;
  const userId = context?.userId ?? 'local-user';
  const apiKey = context?.anthropicApiKey ?? null;

  const url = new URL(request.url);
  const parsed = remiSummaryQuerySchema.safeParse({ month: url.searchParams.get('month') });
  if (!parsed.success) {
    return json(buildErrorBody({ status: 400, message: firstIssueMessage(parsed.error) }), 400);
  }
  const month = parsed.data.month ?? null; // YYYY-MM, validated

  // Derive entitlement from workspace (request-time, never stale)
  const entitlement = await getRemiEntitlementForRequest(db, userId, workspaceId);
  const isPaid = entitlement.authorized;

  const usage = remiUsageLimits.summary.consume(`${workspaceId}:${userId}`);
  if (!usage.allowed) {
    return json(rateLimitedBody(usage.retryAfterSeconds), 429);
  }

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
  let response;
  try {
    const client = createRemiClient(apiKey, { timeoutMs: REMI_UPSTREAM_TIMEOUT_MS });
    response = await createMessageSafely(client, {
      max_tokens: 800,
      system: REMI_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Please generate a monthly financial summary for ${month ?? ctx.periodTo.slice(0, 7)}.\n\n${contextBlock}\n\nProvide:\n1. Overall financial health assessment (1-2 sentences)\n2. Top 2-3 wins this month\n3. Top 1-2 areas to improve\n4. One specific action item for next month\n\nKeep it encouraging and actionable.`,
        },
      ],
    });
  } catch (err) {
    if (err instanceof RemiUpstreamError) {
      logUpstreamFailure(err, { route: 'remi.summary' });
      return json(buildErrorBody({ status: err.status, message: err.message }), err.status);
    }
    throw err;
  }

  const summary = extractText(response);
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
