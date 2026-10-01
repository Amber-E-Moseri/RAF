import { normalizeIsoDate, normalizeMoney, normalizeOptionalString, parseMoneyToCents } from './shared.js';

export const MIN_STATEMENT_DATE = '2000-01-01';
export const MAX_FUTURE_DAYS = 31;
export const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ABSOLUTE_CENTS = 999_999_999_999;

function normalizeAiAmountString(value) {
  const raw = String(value ?? '').trim();
  const negativeParens = raw.startsWith('(') && raw.endsWith(')');
  const body = (negativeParens ? raw.slice(1, -1) : raw).replace(/[$,\s]/g, '');
  return negativeParens && !body.startsWith('-') ? `-${body}` : body;
}

function maxAllowedDate(today) {
  const limit = new Date(today.getTime());
  limit.setUTCDate(limit.getUTCDate() + MAX_FUTURE_DAYS);
  return limit.toISOString().slice(0, 10);
}

export function validateStatementRow(row, { today = new Date() } = {}) {
  const reasons = [];
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, reasons: ['row_not_an_object'] };
  }

  let date = null;
  try {
    date = normalizeIsoDate(row.date, 'date');
    if (date < MIN_STATEMENT_DATE || date > maxAllowedDate(today)) {
      reasons.push('date_out_of_range');
    }
  } catch {
    reasons.push('invalid_date');
  }

  let amount = null;
  try {
    const candidate = typeof row.amount === 'number' ? row.amount : normalizeAiAmountString(row.amount);
    amount = normalizeMoney(candidate, 'amount');
    if (Math.abs(parseMoneyToCents(amount, 'amount')) > MAX_ABSOLUTE_CENTS) {
      reasons.push('amount_out_of_range');
    }
  } catch {
    reasons.push('invalid_amount');
  }

  const description = normalizeOptionalString(row.description)?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() ?? null;
  if (!description) {
    reasons.push('missing_description');
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    reasons.push('description_too_long');
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const rawDescription = normalizeOptionalString(row.rawDescription) ?? description;
  return {
    ok: true,
    row: {
      ...row,
      date,
      amount,
      description,
      rawDescription: rawDescription.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH),
    },
  };
}

export function validateStatementRows(rows, options = {}) {
  const valid = [];
  const rejected = [];

  rows.forEach((row, index) => {
    const result = validateStatementRow(row, options);
    if (result.ok) {
      valid.push({ index, row: result.row });
    } else {
      rejected.push({
        index,
        reasons: result.reasons,
        date: typeof row?.date === 'string' ? row.date.slice(0, 40) : null,
        description: typeof row?.description === 'string' ? row.description.slice(0, 80) : null,
      });
    }
  });

  return { valid, rejected };
}
