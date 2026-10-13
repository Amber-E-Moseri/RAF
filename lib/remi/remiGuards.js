/**
 * Shared reliability guards for the paid Remi endpoints (chat, summary).
 *
 * - Throttle: per-user and per-workspace fixed windows (in-memory, per process).
 * - Daily cap: workspace-wide count of user messages in the last 24h, read from DB rows.
 * - Upstream failures: anthropicClient.js is the only error boundary. This module only turns
 *   a RemiUpstreamError into the client response and a structured log line.
 * - Structured JSON logs: event, route, kind, status numbers and error class name only.
 *   Never upstream message text, prompts, request bodies, or API keys.
 */

import { buildErrorBody } from '../../app/api/v1/_shared/http.js';
import { RemiUpstreamError, logUpstreamFailure } from './anthropicClient.js';
import { createKeyedWindowLimiter } from '../server/rateLimit.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAILY_RETRY_AFTER_SECONDS = 3600;
const UPSTREAM_RETRY_AFTER_SECONDS = 30;

export const REMI_BUSY_MESSAGE = 'Too many Remi requests. Please wait a moment and try again.';
export const REMI_DAILY_LIMIT_MESSAGE = 'Daily Remi message limit reached for this workspace. Please try again later.';
export const REMI_INVALID_REQUEST_MESSAGE = 'Invalid request.';
export const REMI_CONVERSATION_NOT_FOUND_MESSAGE = 'Conversation not found.';
export const REMI_SAVE_FAILED_MESSAGE = 'Remi could not save this conversation. Please try again.';

const userLimiter = createKeyedWindowLimiter({ windowMs: MINUTE_MS });
const workspaceLimiter = createKeyedWindowLimiter({ windowMs: MINUTE_MS });

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
 * Per-minute throttle. The user bucket is checked first, so a user over their own limit
 * never consumes workspace budget. Other users in the same workspace are unaffected by
 * one user's usage until the shared workspace bucket itself is exhausted.
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
 * Workspace-wide daily cap. Counts user messages persisted in the last 24 hours from live
 * rows via the repository method countRemiUserMessagesSince. If the adapter does not
 * provide that method the check cannot be verified: the request is allowed and a
 * structured warning is logged. Production runs on the Postgres adapter, which provides it.
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

/**
 * Converts a model-call failure into the client response. Only RemiUpstreamError (already
 * sanitized by anthropicClient.js) is handled here. Anything else is a bug and is rethrown,
 * so it reaches the generic 500 handler without leaking detail.
 */
export function remiModelFailureResponse(error, route) {
  if (!(error instanceof RemiUpstreamError)) {
    throw error;
  }
  logUpstreamFailure(error, { route });
  const headers = error.status === 429
    ? { 'Retry-After': String(UPSTREAM_RETRY_AFTER_SECONDS) }
    : {};
  return Response.json(
    { error: error.message, errorCode: error.errorCode },
    { status: error.status, headers },
  );
}

export function persistenceFailureResponse(error, route) {
  logRemiEvent('error', 'remi_persist_failure', { route, errorClass: error?.constructor?.name ?? 'Error' });
  return errorBody(500, REMI_SAVE_FAILED_MESSAGE);
}

export function conversationNotFoundResponse() {
  return errorBody(404, REMI_CONVERSATION_NOT_FOUND_MESSAGE);
}
