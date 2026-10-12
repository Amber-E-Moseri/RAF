/**
 * Single choke point for free-text values that reach Remi model context.
 *
 * Every free-text field that originates from bank imports, household setup or
 * user-entered names (obligation descriptions, debt names, goal names, merchant
 * and driver names, bucket labels, household name) MUST pass through
 * sanitizeFreeText before it is placed in a tool result or prompt.
 *
 * It does three things:
 *   1. strips control and bidi/zero-width characters and collapses whitespace,
 *   2. masks card, account and long identifier fragments,
 *   3. caps the length.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

const MASK = '****';

const MASK_PATTERNS = [
  // Masked fragments: XXXX1234, ****1234, •••• 1234, …1234
  [/(?<![A-Za-z0-9])[xX*•·…]{2,}[\s-]*\d{3,}(?![A-Za-z0-9])/g, MASK],
  // Labelled fragments: ending 1234, ending in 1234, last 4 1234, last four 1234,
  // acct 987654321, acct …1234, account # 1234, card 1234, a/c 1234, no. 1234
  [/\b(?:ending(?:\s+in)?|last\s+(?:4|four|digits)|acct|account|card|a\/c|no\.?|#)\s*[#:.\-]?\s*[xX*•·….\s-]*\d{3,}(?![A-Za-z0-9])/gi, MASK],
  // Digit runs of 4+, optionally separated by single spaces or hyphens:
  // 4111111111111111, 4111 1111 1111 1111, 4111-1111-1111-1111
  [/(?<![A-Za-z0-9])\d(?:[ -]?\d){3,}(?![A-Za-z0-9])/g, MASK],
  // Long mixed letter+digit identifiers (8+ chars): ID1234567, AMZN8842XY
  [/(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}(?![A-Za-z0-9])/g, MASK],
  // Hash-prefixed references: #A1234
  [/#\s*[A-Za-z0-9]*\d[A-Za-z0-9]*/g, MASK],
];

export const FREE_TEXT_MAX_LENGTH = 120;

export function sanitizeFreeText(value, { maxLength = FREE_TEXT_MAX_LENGTH, fallback = '' } = {}) {
  if (value === null || value === undefined) return fallback;

  let text = String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of MASK_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  if (text.length > maxLength) {
    text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  return text || fallback;
}

export function sanitizeMerchantName(name) {
  return sanitizeFreeText(name, { fallback: 'Unknown' });
}
