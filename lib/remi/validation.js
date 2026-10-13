/**
 * Zod validation for Remi inputs.
 *
 * Covers the chat and summary request surfaces and every tool input that
 * dispatchToolCall accepts from the model. Validation runs before any RAF
 * calculation so an invalid input never produces a partial result.
 */

import { z } from 'zod';
import { parseMoneyToCents } from '../raf/reporting.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SLUG_RE = /^[a-z0-9_]{1,64}$/;
const MONEY_RE = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;

export const MAX_SCENARIO_AMOUNT = '1000000.00';
const MAX_SCENARIO_CENTS = parseMoneyToCents(MAX_SCENARIO_AMOUNT);
export const MAX_CHAT_MESSAGE_LENGTH = 2000;
export const MAX_TOOL_TEXT_LENGTH = 500;

function isRealIsoDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const isoDate = z.string().regex(ISO_DATE_RE, 'must be a date in YYYY-MM-DD format')
  .refine(isRealIsoDate, 'must be a real calendar date');

const periodStart = z.string().regex(PERIOD_RE, 'must be the first day of a month in YYYY-MM-01 format')
  .refine(isRealIsoDate, 'must be a real calendar date');

const entityId = z.string().trim().min(1).max(64);

const categorySlug = z.string().regex(SLUG_RE, 'must be a bucket slug of lowercase letters, digits and underscores (max 64)');

// Zod 4 still runs refinements after a failed regex, so the refinement must not throw.
function centsOrNull(value) {
  try {
    return parseMoneyToCents(value);
  } catch {
    return null;
  }
}

// Positive decimal string, at most 2 decimal places, at most MAX_SCENARIO_AMOUNT.
export const positiveMoneyAmount = z.string()
  .regex(MONEY_RE, 'must be a positive decimal string with at most 2 decimal places, e.g. "400.00"')
  .refine((value) => {
    const cents = centsOrNull(value);
    return cents !== null && cents > 0 && cents <= MAX_SCENARIO_CENTS;
  }, `must be greater than 0 and at most ${MAX_SCENARIO_AMOUNT}`);

// ── Chat and summary request surfaces ────────────────────────────────────────

export const chatBodySchema = z.object({
  message: z.string().trim().min(1, 'is required').max(MAX_CHAT_MESSAGE_LENGTH, `must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer`),
  conversationId: z.union([z.string().regex(UUID_RE, 'must be a UUID'), z.null()]).optional(),
});

export const summaryQuerySchema = z.object({
  month: z.string().regex(MONTH_RE, 'must be YYYY-MM').optional(),
});

function firstIssueMessage(error, labels) {
  const issue = error.issues[0];
  const field = String(issue?.path?.[0] ?? 'input');
  const label = labels[field] ?? field;
  return `${label} ${issue?.message ?? 'is invalid'}`;
}

export function parseChatBody(body) {
  if (typeof body?.message !== "string" || !body.message.trim()) {
    return { ok: false, error: 'message is required' };
  }
  const result = chatBodySchema.safeParse(body ?? {});
  if (!result.success) {
    return { ok: false, error: firstIssueMessage(result.error, { message: 'message', conversationId: 'conversationId' }) };
  }
  return { ok: true, data: result.data };
}

export function parseSummaryQuery(searchParams) {
  const raw = searchParams?.get?.('month');
  const result = summaryQuerySchema.safeParse({ month: raw === null || raw === undefined ? undefined : raw });
  if (!result.success) {
    return { ok: false, error: firstIssueMessage(result.error, { month: 'month' }) };
  }
  return { ok: true, data: result.data };
}

// ── Tool inputs ──────────────────────────────────────────────────────────────

const forecastDays = z.coerce.number().int()
  .refine((value) => [30, 60, 90].includes(value), 'days must be 30, 60, or 90')
  .optional();

export const toolInputSchemas = {
  get_current_plan: z.object({ period: periodStart.optional() }),
  get_available_resources: z.object({}),
  get_upcoming_obligations: z.object({
    days: z.coerce.number().int().min(1).max(90).optional(),
  }),
  get_goal_progress: z.object({ goalId: entityId.optional() }),
  get_debt_strategy: z.object({}),
  get_cashflow_forecast: z.object({ days: forecastDays }),
  compare_periods: z.object({
    periodA: periodStart,
    periodB: periodStart.optional(),
  }),
  explain_variance: z.object({
    categorySlug,
    period: periodStart.optional(),
  }),
  get_transaction_summary: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    categorySlug: categorySlug.optional(),
  }).refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'from must be on or before to',
    path: ['from'],
  }),
  create_scenario: z.object({
    description: z.string().trim().min(1).max(200),
    categorySlug: categorySlug.optional(),
    amountDelta: positiveMoneyAmount,
  }),
  propose_allocation_change: z.object({
    action: z.enum(['add_to_goal', 'redirect_surplus']),
    targetId: entityId.optional(),
    amount: positiveMoneyAmount,
    rationale: z.string().trim().min(1).max(MAX_TOOL_TEXT_LENGTH),
  }),
};

export function formatToolInputIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ');
}

export { UUID_RE };
