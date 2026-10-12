/**
 * Shared reliability guards for the paid Remi endpoints (chat, summary).
 *
 * - Throttle: per-user and per-workspace fixed windows. In-memory, PER PROCESS ONLY: each
 *   Render instance keeps its own counters, so the effective limit is roughly limit x instances.
 * - Daily message cap: workspace-wide count of user messages in the last 24h (advisory;
 *   read-then-write, so a race can exceed it by a few requests). The hard limit is the budget.
 * - Usage budget: per workspace, per UTC day, counted in calls and tokens. Reserved atomically
 *   via the repository (reserveRemiBudget) BEFORE each upstream call, reconciled to the actual
 *   usage afterwards. Budget exhaustion returns 429 with no upstream call and no retry.
 * - Limits: message length, history window, output tokens, tool rounds, per-request token
 *   ceiling. Constants live in REMI_LIMITS.
 * - Anthropic client factory with explicit timeout and retry policy.
 * - Upstream error mapping: no upstream body, message or key ever reaches the client.
 * - Structured JSON logs: event, route, kind, status numbers and error class name only.
 *   Never upstream message text, prompts, request bodies, or API keys.
 */

import Anthropic from '@anthropic-ai/sdk';

import { loadRemiConfig } from '../server/env.js';
import { createKeyedWindowLimiter } from '../server/rateLimit.js';
import { buildErrorBody } from '../../app/api/v1/_shared/http.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAILY_RETRY_AFTER_SECONDS = 3600;
const UPSTREAM_RETRY_AFTER_SECONDS = 30;

/** Hard limits for the paid path. Changing these is a product decision, not a tuning knob. */
export const REMI_LIMITS = Object.freeze({
  maxMessageChars: 2000,
  maxHistoryMessages: 20, // most recent messages (user + assistant) sent to the model
  maxOutputTokens: 1024, // max_tokens on every upstream call
  maxToolRounds: 4, // tool-result rounds per request; at most maxToolRounds + 1 model calls
  maxTokensPerRequest: 100000, // total estimated + actual input/output tokens for one request
});

export const REMI_UNAVAILABLE_MESSAGE = 'Remi is temporarily unavailable. Please try again.';
export const REMI_TIMEOUT_MESSAGE = 'Remi took too long to respond. Please try again.';
export const REMI_SAVE_FAILED_MESSAGE = 'Remi could not save this conversation. Please try again.';
export const REMI_BUSY_MESSAGE = 'Too many Remi requests. Please wait a moment and try again.';
export const REMI_DAILY_LIMIT_MESSAGE = 'Daily Remi message limit reached for this workspace. Please try again later.';
export const REMI_BUDGET_MESSAGE = 'The Remi usage budget for this workspace is used up for today. Please try again tomorrow.';
export const REMI_INCOMPLETE_MESSAGE = 'Remi could not finish a complete answer. Try a more specific question.';
export const REMI_INVALID_REQUEST_MESSAGE = 'Invalid request.';
export const REMI_CONVERSATION_NOT_FOUND_MESSAGE = 'Conversation not found.';

const userLimiter = createKeyedWindowLimiter({ windowMs: MINUTE_MS });
const workspaceLimiter = createKeyedWindowLimiter({ windowMs: MINUTE_MS });

export class RemiBudgetExhaustedError extends Error {
  constructor() {
    super('remi usage budget exhausted');
    this.name = 'RemiBudgetExhaustedError';
  }
}

export class RemiIncompleteError extends Error {
  constructor(reason) {
    super('remi reply incomplete');
    this.name = 'RemiIncompleteError';
    this.reason = reason; // tool_rounds | token_ceiling | max_tokens | empty_reply
  }
}

export function logRemiEvent(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else console.warn(line);
}

function errorBody(status, message) {
  return Response.json(buildErrorBody({ status, message }), { status });
}

/** Parses a JSON request body against a Zod schema. Never throws. */
export async function parseRemiBody(request, schema) {
  let raw;
  try {
    raw = await request.json();
  } catch {
    return { ok: false };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

/** Parses query parameters against a Zod schema. Never throws. */
export function parseRemiQuery(url, schema, keys) {
  const input = {};
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value !== null) input[key] = value;
  }
  const result = schema.safeParse(input);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

export function invalidRequestResponse() {
  return errorBody(400, REMI_INVALID_REQUEST_MESSAGE);
}

/**
 * Per-minute throttle keyed by authenticated user ID. The user bucket is checked first, so a
 * user over their own limit never consumes workspace budget. The workspace bucket caps the
 * whole workspace. Per process only (see the header comment).
 */
export function checkRemiThrottle({ userId, workspaceId, config, now = Date.now() }) {
  const user = userLimiter.consume(`${workspaceId}:${userId}`, { max: config.userPerMinute, now });
  if (!user.allowed) {
    return { allowed: false, scope: 'user', retryAfterSeconds: user.retryAfterSeconds };
  }
  const workspace = workspaceLimiter.consume(String(workspaceId), { max: config.workspacePerMinute, now });
  if (!workspace.allowed) {
    return { allowed: false, scope: 'workspace', retryAfterSeconds: workspace.retryAfterSeconds };
  }
  return { allowed: true };
}

export function rateLimitedResponse(retryAfterSeconds) {
  return Response.json(
    buildErrorBody({ status: 429, message: REMI_BUSY_MESSAGE }),
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * Workspace-wide daily cap on user messages (advisory; see header). If the adapter does not
 * provide countRemiUserMessagesSince the check cannot run and a structured warning is logged.
 */
export async function checkRemiDailyCap({ db, householdId, config, route, now = Date.now() }) {
  const since = new Date(now - DAY_MS).toISOString();
  const count = await db.transaction((tx) => (
    typeof tx.countRemiUserMessagesSince === 'function'
      ? tx.countRemiUserMessagesSince({ householdId, since })
      : null
  ));
  if (count === null || count === undefined) {
    logRemiEvent('warn', 'remi_daily_cap_unverified', { route });
    return { allowed: true };
  }
  return { allowed: Number(count) < config.dailyMessageLimit };
}

export function dailyLimitResponse() {
  return Response.json(
    buildErrorBody({ status: 429, message: REMI_DAILY_LIMIT_MESSAGE }),
    { status: 429, headers: { 'Retry-After': String(DAILY_RETRY_AFTER_SECONDS) } },
  );
}

// ── Usage budget ──────────────────────────────────────────────────────────────

/** UTC calendar day, YYYY-MM-DD. Budgets reset at 00:00 UTC. */
export function utcUsageDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsUntilNextUtcDay(now = Date.now()) {
  const d = new Date(now);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(Math.ceil((nextMidnight - now) / 1000), 1);
}

/**
 * Token estimate for a request payload: about 3 characters per token (typical English is
 * closer to 4, so this errs high) plus the full output allowance. Over-estimating only makes
 * the budget trip earlier; the reconciliation step then refunds the difference.
 */
export function estimateRemiTokens(payload) {
  return Math.ceil(JSON.stringify(payload).length / 3) + REMI_LIMITS.maxOutputTokens;
}

/**
 * Budget gate for one request. reserve() runs its own committed transaction BEFORE the
 * upstream call, so concurrent requests cannot oversubscribe the day's budget. settle()
 * adjusts the reservation to the actual usage. If the upstream call failed, the reservation
 * is kept (conservative: a failed call may still be billed).
 */
export function createRemiBudget({ db, householdId, config, route }) {
  return {
    async reserve(estimatedTokens) {
      const usageDay = utcUsageDay();
      const decision = await db.transaction((tx) => {
        if (typeof tx.reserveRemiBudget !== 'function') {
          throw new Error('Remi usage budget is not supported by this repository.');
        }
        return tx.reserveRemiBudget({
          householdId,
          usageDay,
          reserveCalls: 1,
          reserveTokens: estimatedTokens,
          callLimit: config.dailyCallBudget,
          tokenLimit: config.dailyTokenBudget,
        });
      });
      if (!decision?.allowed) {
        logRemiEvent('warn', 'remi_budget_exhausted', { route });
        throw new RemiBudgetExhaustedError();
      }
      return { usageDay, reservedTokens: estimatedTokens };
    },

    async settle(reservation, actualTokens) {
      if (actualTokens === null || actualTokens === undefined) return;
      const deltaTokens = actualTokens - reservation.reservedTokens;
      if (deltaTokens === 0) return;
      try {
        await db.transaction((tx) => tx.settleRemiBudget({
          householdId,
          usageDay: reservation.usageDay,
          deltaTokens,
        }));
      } catch (error) {
        // The reply already exists; the reservation stays counted, which is the safe side.
        logRemiEvent('error', 'remi_budget_settle_failed', { route, errorClass: error?.constructor?.name ?? 'Error' });
      }
    },
  };
}

/**
 * One budgeted upstream call: ceiling check, reserve, call, reconcile. The budget check runs
 * before the SDK call, so a denial never reaches Anthropic and is never retried.
 * Returns the response and the actual tokens used.
 */
export async function callBudgetedModel({ client, budget, payload, requestTokensSpent = 0 }) {
  const estimate = estimateRemiTokens(payload);
  if (requestTokensSpent + estimate > REMI_LIMITS.maxTokensPerRequest) {
    throw new RemiIncompleteError('token_ceiling');
  }
  const reservation = await budget.reserve(estimate);
  let response;
  try {
    response = await client.messages.create(payload);
  } catch (error) {
    await budget.settle(reservation, null);
    throw error;
  }
  const tokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  await budget.settle(reservation, tokens);
  return { response, tokens };
}

/** Keeps the most recent history messages and makes the first one a user turn. */
export function limitRemiHistory(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-REMI_LIMITS.maxHistoryMessages);
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
  return turns;
}

// ── Anthropic client and error mapping ────────────────────────────────────────

export function createRemiAnthropicClient({ apiKey, config = loadRemiConfig() }) {
  return new Anthropic({
    apiKey,
    timeout: config.anthropicTimeoutMs,
    maxRetries: config.anthropicMaxRetries,
  });
}

/** Maps an error from the Anthropic SDK to a coarse, non-sensitive kind. */
export function classifyRemiError(error) {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout', upstreamStatus: null };
  if (error instanceof Anthropic.APIUserAbortError) return { kind: 'network', upstreamStatus: null };
  if (error instanceof Anthropic.APIConnectionError) return { kind: 'network', upstreamStatus: null };
  if (error instanceof Anthropic.RateLimitError) return { kind: 'rate_limited', upstreamStatus: 429 };
  if (error instanceof Anthropic.APIError) {
    const upstreamStatus = typeof error.status === 'number' ? error.status : null;
    if (upstreamStatus !== null && upstreamStatus >= 500) return { kind: 'upstream_5xx', upstreamStatus };
    if (upstreamStatus === 401 || upstreamStatus === 403) return { kind: 'upstream_auth', upstreamStatus };
    return { kind: 'upstream_4xx', upstreamStatus };
  }
  return { kind: 'unexpected', upstreamStatus: null };
}

/**
 * Converts any failure from the model path into one generic client response. Mapping:
 *   timeout            -> 504 REMI_TIMEOUT
 *   upstream 429       -> 429 REMI_UNAVAILABLE with Retry-After (RAF rate-limit semantics)
 *   upstream 5xx       -> 502 REMI_UPSTREAM_ERROR
 *   upstream 401/403   -> 503 REMI_UNAVAILABLE (server key misconfiguration; status logged only)
 *   other 4xx, network -> 503 REMI_UNAVAILABLE
 *   anything else      -> 500 ERROR
 */
export function remiModelFailureResponse(error, route) {
  const { kind, upstreamStatus } = classifyRemiError(error);
  logRemiEvent('error', 'remi_model_failure', {
    route,
    kind,
    upstreamStatus,
    errorClass: error?.constructor?.name ?? 'Error',
  });

  switch (kind) {
    case 'timeout':
      return Response.json({ error: REMI_TIMEOUT_MESSAGE, errorCode: 'REMI_TIMEOUT' }, { status: 504 });
    case 'rate_limited':
      return Response.json(
        { error: REMI_UNAVAILABLE_MESSAGE, errorCode: 'REMI_UNAVAILABLE' },
        { status: 429, headers: { 'Retry-After': String(UPSTREAM_RETRY_AFTER_SECONDS) } },
      );
    case 'upstream_5xx':
      return Response.json({ error: REMI_UNAVAILABLE_MESSAGE, errorCode: 'REMI_UPSTREAM_ERROR' }, { status: 502 });
    case 'unexpected':
      return Response.json({ error: REMI_UNAVAILABLE_MESSAGE, errorCode: 'ERROR' }, { status: 500 });
    default:
      return Response.json({ error: REMI_UNAVAILABLE_MESSAGE, errorCode: 'REMI_UNAVAILABLE' }, { status: 503 });
  }
}

export function budgetExhaustedResponse(route) {
  logRemiEvent('warn', 'remi_budget_response', { route });
  return Response.json(
    { error: REMI_BUDGET_MESSAGE, errorCode: 'REMI_BUDGET_EXHAUSTED' },
    { status: 429, headers: { 'Retry-After': String(secondsUntilNextUtcDay()) } },
  );
}

export function incompleteResponse(route, reason) {
  logRemiEvent('warn', 'remi_incomplete', { route, reason });
  return Response.json({ error: REMI_INCOMPLETE_MESSAGE, errorCode: 'REMI_INCOMPLETE' }, { status: 422 });
}

/** Single entry point for failures on the paid model path. Never returns upstream text. */
export function remiErrorResponse(error, route) {
  if (error instanceof RemiBudgetExhaustedError) return budgetExhaustedResponse(route);
  if (error instanceof RemiIncompleteError) return incompleteResponse(route, error.reason);
  return remiModelFailureResponse(error, route);
}

export function persistenceFailureResponse(error, route) {
  logRemiEvent('error', 'remi_persist_failure', { route, errorClass: error?.constructor?.name ?? 'Error' });
  return errorBody(500, REMI_SAVE_FAILED_MESSAGE);
}

export function conversationNotFoundResponse() {
  return errorBody(404, REMI_CONVERSATION_NOT_FOUND_MESSAGE);
}
