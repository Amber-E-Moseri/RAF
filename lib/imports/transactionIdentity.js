import { createHash } from 'node:crypto';

import { parseMoneyToCents } from './shared.js';

export const IDENTITY_VERSION = 'v1';

export const DUPLICATE_STATE = Object.freeze({
  NONE: 'none',
  LIKELY: 'likely',
  EXACT: 'exact',
});

export function normalizeIdentityText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function signedCentsFromStatementAmount(amount) {
  return parseMoneyToCents(amount, 'amount');
}

export function signedCentsFromAmountAndDirection(amount, direction) {
  const cents = parseMoneyToCents(amount, 'amount');
  return direction === 'debit' ? -Math.abs(cents) : cents;
}

export function splitSignedCents(signedCents) {
  const direction = signedCents < 0 ? 'debit' : 'credit';
  const absolute = Math.abs(signedCents);
  const amount = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
  return { direction, amount };
}

// Account is deliberately excluded from the key: whether two events are the same
// depends on the account comparison rules in duplicateEvidence.js.
export function buildEventKey({ date, signedCents, description }) {
  return createHash('sha256')
    .update([IDENTITY_VERSION, date, String(signedCents), normalizeIdentityText(description)].join('\u001f'))
    .digest('hex');
}

// Nth occurrence of an identical key within one source gets ordinal N, so two real
// identical purchases in one statement stay distinct while the same pair re-appearing
// in an overlapping statement maps one-to-one.
export function assignEventOrdinals(eventKeys) {
  const seen = new Map();
  return eventKeys.map((key) => {
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    return next;
  });
}
