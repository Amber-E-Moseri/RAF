/**
 * Anthropic boundary for paid Remi.
 *
 * - One place that owns the model ID and the timeouts.
 * - Every upstream failure is mapped to a small set of sanitized kinds. Clients only ever
 *   receive the public message for that kind, never SDK error text, upstream bodies or keys.
 * - Malformed responses (no usable content) are treated as upstream failures.
 */

import Anthropic, {
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';

// Documented pinned snapshot for the Claude Sonnet 5 release (dateless IDs are fixed snapshots,
// see platform.claude.com model-ids-and-versions). Claude Sonnet 5.5 is `claude-sonnet-5-5`;
// moving to it is a deliberate model change, not part of this remediation.
export const REMI_MODEL = 'claude-sonnet-5';

// Per upstream call. The SDK retries once on connection errors, 429 and 5xx.
export const REMI_UPSTREAM_TIMEOUT_MS = 25_000;
// Total wall-clock budget for one user request (covers every tool-loop round).
export const REMI_REQUEST_BUDGET_MS = 60_000;

const PUBLIC_MESSAGES = {
  timeout: 'The AI assistant took too long to respond. Please try again.',
  rate_limited: 'The AI assistant is busy right now. Please try again shortly.',
  unavailable: 'The AI assistant is temporarily unavailable. Please try again later.',
  malformed: 'The AI assistant returned an unexpected response. Please try again.',
  misconfigured: 'The AI assistant is not available right now.',
};

const STATUS_BY_KIND = {
  timeout: 504,
  rate_limited: 429,
  unavailable: 502,
  malformed: 502,
  misconfigured: 503,
};

export class RemiUpstreamError extends Error {
  constructor(kind, { upstreamStatus = null } = {}) {
    super(PUBLIC_MESSAGES[kind] ?? PUBLIC_MESSAGES.unavailable);
    this.name = 'RemiUpstreamError';
    this.kind = PUBLIC_MESSAGES[kind] ? kind : 'unavailable';
    this.status = STATUS_BY_KIND[this.kind];
    this.upstreamStatus = upstreamStatus;
  }
}

export function createRemiClient(apiKey, { timeoutMs = REMI_UPSTREAM_TIMEOUT_MS } = {}) {
  return new Anthropic({ apiKey, timeout: timeoutMs });
}

// Maps any thrown value to a RemiUpstreamError. Never copies the SDK message.
export function classifyUpstreamError(err) {
  if (err instanceof RemiUpstreamError) return err;
  if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
    return new RemiUpstreamError('timeout');
  }
  if (err instanceof RateLimitError || err?.status === 429) {
    return new RemiUpstreamError('rate_limited', { upstreamStatus: 429 });
  }
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new RemiUpstreamError('misconfigured', { upstreamStatus: err.status });
  }
  return new RemiUpstreamError('unavailable', { upstreamStatus: typeof err?.status === 'number' ? err.status : null });
}

export function logUpstreamFailure(error, { route }) {
  // Structured, secret-free: kind and status only. No SDK message, body, headers or key.
  console.error(JSON.stringify({
    level: 'error',
    event: 'remi_upstream_error',
    route,
    kind: error.kind,
    status: error.status,
    upstreamStatus: error.upstreamStatus,
  }));
}

// Calls messages.create with the per-request deadline and error mapping.
export async function createMessageSafely(client, params, { deadline } = {}) {
  if (deadline && Date.now() >= deadline) {
    throw new RemiUpstreamError('timeout');
  }
  let response;
  try {
    response = await client.messages.create({ model: REMI_MODEL, ...params });
  } catch (err) {
    throw classifyUpstreamError(err);
  }
  assertWellFormed(response);
  return response;
}

// A response is usable only if it carries a content array with well-formed blocks.
export function assertWellFormed(response) {
  if (!response || !Array.isArray(response.content)) {
    throw new RemiUpstreamError('malformed');
  }
  for (const block of response.content) {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
      throw new RemiUpstreamError('malformed');
    }
    if (block.type === 'tool_use' && (typeof block.id !== 'string' || typeof block.name !== 'string')) {
      throw new RemiUpstreamError('malformed');
    }
    if (block.type === 'text' && typeof block.text !== 'string') {
      throw new RemiUpstreamError('malformed');
    }
  }
}

export function extractText(response) {
  const text = response.content.find((block) => block.type === 'text');
  if (!text || text.text.trim() === '') {
    throw new RemiUpstreamError('malformed');
  }
  return text.text;
}
