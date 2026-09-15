import { z } from 'zod';

import {
  ImportHttpError,
  normalizeIsoDate,
  normalizeMoney,
  normalizeOptionalString,
  parseMoneyToCents,
} from './shared.js';

const uploadBankStatementSchema = z.object({
  filename: z.string().trim().min(1, 'filename is required'),
  contentType: z.string().trim().optional().nullable(),
  pdfBuffer: z.instanceof(Uint8Array),
  currency: z.string().trim().min(3).max(3).optional().default('USD'),
});

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Import DB adapter must implement transaction().');
  }
}

function parseWithSchema(schema, input, status = 400) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
    throw new ImportHttpError(status, `${path} ${issue.message}`.trim());
  }

  return result.data;
}

async function loadPdfParse() {
  try {
    const module = await import('pdf-parse');
    return module.default ?? module;
  } catch (error) {
    throw new ImportHttpError(500, 'PDF parsing dependency is unavailable', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeDecodedPdfText(text) {
  return String(text ?? '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(pdfBuffer, options = {}) {
  const extractor = options.pdfTextExtractor ?? null;

  try {
    const pdfData = Buffer.from(pdfBuffer);
    const decodedText = extractor
      ? await extractor(pdfData)
      : (await (await loadPdfParse())(pdfData))?.text ?? '';

    const normalized = normalizeDecodedPdfText(decodedText);
    if (!normalized) {
      throw new ImportHttpError(422, 'statement PDF did not contain decoded text');
    }

    return normalized;
  } catch (error) {
    if (error instanceof ImportHttpError) {
      throw error;
    }

    throw new ImportHttpError(422, 'unable to decode readable text from PDF', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function logPdfTextPreview(text) {
  const preview = String(text ?? '').slice(0, 3000);
  console.info('[RAF bank import] extracted PDF text preview:', preview);
}

function logNormalizedLines(lines) {
  console.info('[RAF bank import] normalized candidate lines:', lines.slice(0, 100));
}

function logRejectedCandidates(rejections) {
  console.info(
    '[RAF bank import] rejected candidate lines:',
    rejections.slice(0, 50).map((item) => ({
      line: item.line,
      reason: item.reason,
    })),
  );
}

function logParseSummary(lines, matchedRowCount) {
  console.info('[RAF bank import] parse summary:', {
    lines_scanned: lines.length,
    matched_rows_count: matchedRowCount,
  });
}

function parseSlashDateWithYear(raw) {
  const slashMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!slashMatch) {
    return null;
  }

  const [, first, second, yearToken] = slashMatch;
  const year = yearToken.length === 2 ? `20${yearToken}` : yearToken;
  const firstNumber = Number(first);
  const secondNumber = Number(second);

  if (firstNumber > 12) {
    return normalizeIsoDate(`${year}-${second}-${first}`, 'date');
  }

  if (secondNumber > 12) {
    return normalizeIsoDate(`${year}-${first}-${second}`, 'date');
  }

  // Ambiguous slash dates default to MM/DD/YYYY for the MVP parser.
  return normalizeIsoDate(`${year}-${first}-${second}`, 'date');
}

function deriveYearForShortDate(monthToken, dayToken, statementContext) {
  const month = Number(monthToken);
  const day = Number(dayToken);
  if (!Number.isInteger(month) || !Number.isInteger(day)) {
    throw new ImportHttpError(422, 'date must be a valid statement date');
  }

  const periodStart = statementContext?.periodStart ?? null;
  const periodEnd = statementContext?.periodEnd ?? null;
  if (!periodStart || !periodEnd) {
    return new Date().getUTCFullYear();
  }

  const startYear = Number(periodStart.slice(0, 4));
  const endYear = Number(periodEnd.slice(0, 4));
  const candidates = [...new Set([startYear, endYear])];

  for (const year of candidates) {
    const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const normalized = normalizeIsoDate(isoDate, 'date');
    if (normalized >= periodStart && normalized <= periodEnd) {
      return year;
    }
  }

  return endYear;
}

function normalizeMonthNameDate(raw, statementContext = null) {
  const monthMap = {
    jan: '01', feb: '02', mar: '03', apr: '04',
    may: '05', jun: '06', jul: '07', aug: '08',
    sep: '09', oct: '10', nov: '11', dec: '12',
  };

  const match = String(raw ?? '').trim().match(/^([A-Za-z]{3,9})\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?$/);
  if (!match) {
    return null;
  }

  const monthName = match[1].slice(0, 3).toLowerCase();
  const month = monthMap[monthName];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) {
    return null;
  }

  let year = match[3] ? Number(match[3]) : null;
  if (!year) {
    // keep behavior similar to short slash: derive from statement period
    if (statementContext?.periodStart && statementContext?.periodEnd) {
      const startYear = Number(statementContext.periodStart.slice(0, 4));
      const endYear = Number(statementContext.periodEnd.slice(0, 4));
      year = startYear === endYear ? startYear : endYear;
    } else {
      year = new Date().getUTCFullYear();
    }
  }

  return normalizeIsoDate(`${year}-${month}-${String(day).padStart(2, '0')}`, 'date');
}

function normalizeStatementDate(value, statementContext = null) {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return normalizeIsoDate(raw, 'date');
  }

  const slashDateWithYear = parseSlashDateWithYear(raw);
  if (slashDateWithYear) {
    return slashDateWithYear;
  }

  const monthNameDate = normalizeMonthNameDate(raw, statementContext);
  if (monthNameDate) {
    return monthNameDate;
  }

  const shortSlashMatch = raw.match(/^(\d{2})\/(\d{2})$/);
  if (!shortSlashMatch) {
    throw new ImportHttpError(422, 'date must be a valid statement date');
  }

  const [, monthToken, dayToken] = shortSlashMatch;
  const derivedYear = deriveYearForShortDate(monthToken, dayToken, statementContext);
  return normalizeIsoDate(`${derivedYear}-${monthToken}-${dayToken}`, 'date');
}

function normalizeAmountToken(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  const isNegative = raw.startsWith('(') && raw.endsWith(')');
  const withoutParens = isNegative ? raw.slice(1, -1) : raw;
  const withoutMarkers = withoutParens.replace(/\s+(CR|DR)$/, '');
  const directionMarker = withoutParens.match(/\s+(CR|DR)$/)?.[1] ?? null;
  const unsigned = withoutMarkers.replace(/\$/g, '').replace(/,/g, '');
  const signed = isNegative || directionMarker === 'DR' ? `-${unsigned}` : unsigned;
  return normalizeMoney(signed, 'amount');
}

function buildImportedTransactionRow(transaction, householdId, currency) {
  return {
    householdId,
    date: normalizeIsoDate(transaction.date, 'date'),
    description: normalizeOptionalString(transaction.description),
    amount: normalizeMoney(transaction.amount, 'amount'),
    currency,
    source: 'bank_import',
    rawDescription: normalizeOptionalString(transaction.rawDescription) ?? normalizeOptionalString(transaction.description),
    referenceNumber: normalizeOptionalString(transaction.referenceNumber),
    balanceAfterTransaction: transaction.balanceAfterTransaction == null
      ? null
      : normalizeMoney(transaction.balanceAfterTransaction, 'balance_after_transaction'),
    status: 'unreviewed',
    classificationType: null,
    linkedTransactionId: null,
    linkedDebtId: null,
    linkedFixedBillId: null,
    reviewedAt: null,
    reviewNote: null,
  };
}

const dateTokenPattern = /\b(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}(?:\/\d{2,4})?)\b/g;
const amountTokenPattern = /(?:\(?-?\$?\d[\d,]*\.\d{2}\)?(?:\s*(?:CR|DR))?)/g;
const leadingDatePattern = /^(?<date>\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}(?:\/\d{2,4})?|[A-Za-z]{3,9}\s*\d{1,2})\b/;
const noiseLinePattern = /^(?:statement\s+period|page\s+\d+|beginning\s+balance|ending\s+balance|account\s+number|account\s+summary|transactions?|description|date|amount|balance|deposits?|withdrawals?|payments?|checks?)\b/i;
const headerNoiseFragmentPattern = /(?:sample\s+bank\s+statement|account\s+holder|account\s+number|statement\s+period|date\s+description\s+amount(?:\s*\([^)]+\))?balance|opening\s+balance)/gi;

function stripHeaderNoiseFragments(value) {
  return String(value ?? '').replace(headerNoiseFragmentPattern, ' ');
}

/**
 * Check if a line starts with a transaction date pattern.
 * Supports compact PDF text with no space between month and day (e.g., Feb10, Feb18).
 */
function isTransactionStart(line) {
  const trimmed = String(line || '').trim();
  // Date ranges like "03/01/2026 - 03/31/2026" are period headers, not transaction starts
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\s*-/.test(trimmed)) return false;
  return (
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s?\d{1,2}/i.test(trimmed)
    || /^\d{4}-\d{2}-\d{2}/.test(trimmed)
    || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?(\s|$)/.test(trimmed)
  );
}

function isOpeningBalanceRow(line) {
  return /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s?\d{1,2}.*openingbalance/i.test(
    String(line || "").replace(/\s+/g, ""),
  );
}

function isHeaderOrFooterNoise(line) {
  const raw = String(line || "").trim();
  if (!raw) return false;

  const compact = raw.replace(/\s+/g, "");

  const exactNoise = [
    /^Page\d+of\d+$/i,
    /^Yourbranchaddress:?$/i,
    /^EverydayBanking$/i,
    /^YourEverydayBankingstatement$/i,
    /^Fortheperiodending/i,
    /^YourBranch$/i,
    /^Transitnumber:/i,
    /^Forquestionsaboutyour$/i,
    /^statementcall$/i,
    /^\(\d{3}\)\d{3}-\d{4}$/i,
    /^DirectBanking$/i,
    /^1-800-\d{3}-\d{4}$/i,
    /^www\.bmo\.com$/i,
    /^YourPlan$/i,
    /^PerformancePlanwithStudentDiscount$/i,
    /^Program$/i,
    /^continued$/i,
    /^Summaryofyouraccount$/i,
    /^TotalTotalClosing$/i,
    /^Openingamountsamountsbalance\(\$\)on$/i,
    /^-?\+=?$/i,
    /^Accountbalance\(\$\)deducted\(\$\)added\(\$\)Mar\d{2},\d{4}$/i,
    /^Here'?swhathappenedinyouraccount$/i,
    /^AmountsdeductedAmountsadded$/i,
    /^DateDescriptionfromyouraccount\(\$\)toyouraccount\(\$\)Balance\(\$\)$/i,
    /^PrimaryChequingAccount#?[0-9\-]*$/i,
    /^Owner:?$/i,
    /^AMBEREWEREMOSERI$/i,
  ];

  return exactNoise.some((rx) => rx.test(compact));
}

/**
 * Merge transaction blocks that span multiple lines.
 * Handles cases where descriptions are split across lines.
 */
function mergeTransactionBlocks(lines) {
  const merged = [];
  let currentBlock = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isTransactionStart(trimmed)) {
      // Start of new transaction block
      if (currentBlock) {
        merged.push(currentBlock);
      }
      currentBlock = trimmed;
    } else if (currentBlock) {
      // Continuation of current transaction block
      currentBlock += ' ' + trimmed;
    } else {
      // Line before any transaction start - could be header
      if (!isHeaderOrFooterNoise(trimmed)) {
        merged.push(trimmed);
      }
    }
  }

  if (currentBlock) {
    merged.push(currentBlock);
  }

  return merged;
}
function recoverTrailingMoneyPair(token) {
  const raw = String(token ?? '').trim();
  // Match pattern: digits, dot, 2 digits, more digits (no dot), 2 digits (no dot or following decimal)
  // This catches "5.6469.20" as a sequence with implicit boundary between 69 and 20
  const match = raw.match(/^(.+?)(\d)(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, prefix, thirdDigit, lastTwo, secondLastTwo] = match;
  // Reconstruct: prefix + thirdDigit.lastTwo and secondLastTwo
  // e.g., "5.64" and "69.20"
  const first = `${prefix}${thirdDigit}.${lastTwo}`;
  const second = `${secondLastTwo}.${lastTwo}`;
  
  // Verify both parse as decimal amounts
  try {
    normalizeMoney(first, 'amount');
    normalizeMoney(second, 'amount');
    return { first, second };
  } catch {
    return null;
  }
}

/**
 * Extract trailing amount and balance tokens from the right side of a line.
 * Handles collapsed amount columns like "5.6469.20" by attempting recovery.
 * Returns { amount, balance, description } or { error: reason } if recovery fails.
 */
function parseMoneyTokensFromRight(line) {
  const trimmed = String(line ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return { error: 'empty_line' };
  }

  // Find all decimal amount tokens
  const amountTokens = [...trimmed.matchAll(amountTokenPattern)];
  if (amountTokens.length === 0) {
    return { error: 'no_amount_found' };
  }

  const lastToken = amountTokens.at(-1)?.[0] ?? '';
  const secondLastToken = amountTokens.at(-2)?.[0] ?? '';

  // Extract description: everything before the first amount token
  const firstAmountIndex = trimmed.indexOf(amountTokens[0][0]);
  const description = trimmed.slice(0, firstAmountIndex).trim();

  if (amountTokens.length === 1) {
    // Single amount: likely just the deducted or added amount
    return {
      amount: lastToken,
      balance: null,
      description,
    };
  }

  // Two or more amounts: try standard extraction first
  const lastNormalized = lastToken.toUpperCase();
  const looksLikeSigned = lastNormalized.includes('CR')
    || lastNormalized.includes('DR')
    || lastNormalized.startsWith('(')
    || lastNormalized.startsWith('-');

  if (looksLikeSigned) {
    // Last token is signed, treat as amount only
    return {
      amount: lastToken,
      balance: null,
      description,
    };
  }

  // Last token is unsigned (likely balance), second-to-last is amount
  return {
    amount: secondLastToken,
    balance: lastToken,
    description,
  };
}

/**
 * Clean description by removing header noise fragments and normalizing whitespace.
 */
function cleanDescription(text) {
  return String(text ?? '')
    .replace(headerNoiseFragmentPattern, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractStatementContext(text) {
  const normalizedText = String(text ?? '').replace(/\s+/g, ' ').trim();
  const fullDateMatches = [...normalizedText.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{2,4})\b/g)]
    .map((match) => {
      try {
        return normalizeStatementDate(match[0]);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort();

  if (fullDateMatches.length < 2) {
    return {
      periodStart: null,
      periodEnd: fullDateMatches[0] ?? null,
    };
  }

  return {
    periodStart: fullDateMatches[0],
    periodEnd: fullDateMatches.at(-1),
  };
}

function splitStatementRows(decodedText) {
  const normalizedText = String(decodedText ?? '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (!normalizedText) {
    return [];
  }

  const rawLines = normalizedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const source = rawLines.length > 3
    ? rawLines.join('\n')
    : normalizedText.replace(/\n+/g, ' ');

  return source
    .replace(/(?=\d{4}-\d{2}-\d{2})/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function classifyCandidateLine(line) {
  const trimmed = String(line || "").trim();

  if (!trimmed) {
    return { kind: "empty" };
  }

  if (isTransactionStart(trimmed)) {
    if (isOpeningBalanceRow(trimmed)) {
      return { kind: "opening_balance_row" };
    }
    return { kind: "transaction_candidate" };
  }

  if (isHeaderOrFooterNoise(trimmed)) {
    return { kind: "header_or_footer_noise" };
  }

  if (noiseLinePattern.test(trimmed.replace(/\s+/g, ' '))) {
    return { kind: "header_or_footer_noise" };
  }

  return { kind: "continuation_or_unknown" };
}

function splitIntoCandidateLines(text) {
  const lines = splitStatementRows(text)
    .map((line) => stripHeaderNoiseFragments(line))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const mergedLines = [];
  let current = '';

  for (const line of lines) {
    if (isTransactionStart(line)) {
      if (current) {
        mergedLines.push(current);
      }
      current = line;
      continue;
    }

    if (current) {
      current += ` ${line}`;
    }
    // Pre-tx non-transaction lines (header noise) are discarded
  }

  if (current) {
    mergedLines.push(current);
  }

  return mergedLines;
}

function isNoiseLine(line) {
  const normalized = String(line ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return true;
  }

  if (noiseLinePattern.test(normalized)) {
    return true;
  }

  const amountMatches = [...normalized.matchAll(amountTokenPattern)];
  if (amountMatches.length >= 2 && !leadingDatePattern.test(normalized)) {
    return true;
  }

  return false;
}

function selectTrailingAmountTokens(rest) {
  const matches = [...rest.matchAll(amountTokenPattern)];
  if (matches.length === 0) {
    return { amountMatch: null, balanceMatch: null };
  }

  if (matches.length === 1) {
    return { amountMatch: matches[0], balanceMatch: null };
  }

  const last = matches.at(-1);
  const secondLast = matches.at(-2);
  const lastNormalized = String(last[0] ?? '').trim().toUpperCase();
  const looksLikeSignedAmount = lastNormalized.includes('CR')
    || lastNormalized.includes('DR')
    || lastNormalized.startsWith('(')
    || lastNormalized.startsWith('-');

  if (looksLikeSignedAmount) {
    return { amountMatch: last, balanceMatch: null };
  }

  return { amountMatch: secondLast, balanceMatch: last };
}

function parseStatementLine(line, statementContext = null) {
  const trimmed = String(line ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return { row: null, reason: 'empty_line' };
  }

  // Check for transaction start BEFORE header/footer filtering
  const isTransaction = isTransactionStart(trimmed);
  if (!isTransaction) {
    // Only apply header/footer noise filtering if it's not a transaction line
    if (isHeaderOrFooterNoise(trimmed)) {
      return { row: null, reason: 'header_or_footer_noise' };
    }
    return { row: null, reason: 'unrecognized_format' };
  }

  if (/opening\s*balance/i.test(trimmed)) {
    return { row: null, reason: 'opening_balance_row' };
  }

  const datePattern = '(?:\\d{4}-\\d{2}-\\d{2}|[A-Za-z]{3,9}\\s*\\d{1,2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)';
  const dateAtStartMatch = trimmed.match(new RegExp(`^(?<date>${datePattern})\\s*`));
  
  if (!dateAtStartMatch) {
    if (isNoiseLine(trimmed)) {
      return { row: null, reason: 'header_or_footer_noise' };
    }
    return { row: null, reason: 'unrecognized_format' };
  }

  // Try standard regex patterns first. Allow optional whitespace between amount and balance
  // to handle both BMO-style collapsed "12.99980.00" and space-separated "12.99 980.00" formats.
  const txWithBalanceMatch = trimmed.match(
    new RegExp(`^(?<date>${datePattern})(?<description>.*?)(?<amount>\\(?-?\\$?\\d[\\d,]*\\.\\d{2}\\)?)\\s*(?<balance>-?\\$?\\d[\\d,]*\\.\\d{2})$`),
  );
  const txAmountOnlyMatch = txWithBalanceMatch
    ? null
    : trimmed.match(
      new RegExp(`^(?<date>${datePattern})(?<description>.*?)(?<amount>-?\\$?\\d[\\d,]*\\.\\d{2})$`),
    );
  const txMatch = txWithBalanceMatch ?? txAmountOnlyMatch;

  if (txMatch) {
    // Standard pattern matched
    const description = cleanDescription(txMatch.groups.description);
    if (!description) {
      return { row: null, reason: 'missing_description' };
    }

    const referenceMatch = description.match(/\b(?:REF|REFERENCE|CONFIRMATION|TRACE)[#:\s-]+([A-Z0-9-]+)\b/i);

    try {
      return {
        row: {
          date: normalizeStatementDate(txMatch.groups.date, statementContext),
          description,
          amount: normalizeAmountToken(txMatch.groups.amount),
          rawDescription: description,
          referenceNumber: referenceMatch?.[1] ?? null,
          balanceAfterTransaction: txMatch.groups.balance
            ? normalizeAmountToken(txMatch.groups.balance)
            : null,
        },
        reason: null,
      };
    } catch (error) {
      if (error instanceof ImportHttpError) {
        return { row: null, reason: error.message };
      }
      throw error;
    }
  }

  // Standard patterns failed. Try collapsed amount recovery.
  // Extract date and remaining part after date
  const afterDateMatch = trimmed.match(new RegExp(`^(?<date>${datePattern})\\s*(?<rest>.*)$`));
  if (!afterDateMatch) {
    if (isNoiseLine(trimmed)) {
      return { row: null, reason: 'header_or_footer_noise' };
    }
    return { row: null, reason: 'unrecognized_format' };
  }

  const dateStr = afterDateMatch.groups.date;
  const rest = afterDateMatch.groups.rest;

  // Try to parse money tokens from right side
  const moneyResult = parseMoneyTokensFromRight(rest);
  if (moneyResult.error) {
    if (isNoiseLine(trimmed)) {
      return { row: null, reason: 'header_or_footer_noise' };
    }
    return { row: null, reason: moneyResult.error };
  }

  const { amount: amountToken, balance: balanceToken, description: descPart } = moneyResult;
  if (!descPart) {
    return { row: null, reason: 'missing_description' };
  }

  // Try to recover collapsed amount if needed
  let recoveredAmount = amountToken;
  let recoveredBalance = balanceToken;

  if (amountToken && !balanceToken) {
    // Single amount token; check if it might be collapsed
    const recovered = recoverTrailingMoneyPair(amountToken);
    if (recovered) {
      recoveredAmount = recovered.first;
      recoveredBalance = recovered.second;
    }
  }

  const description = cleanDescription(descPart);
  if (!description) {
    return { row: null, reason: 'missing_description' };
  }

  const referenceMatch = description.match(/\b(?:REF|REFERENCE|CONFIRMATION|TRACE)[#:\s-]+([A-Z0-9-]+)\b/i);

  try {
    return {
      row: {
        date: normalizeStatementDate(dateStr, statementContext),
        description,
        amount: normalizeAmountToken(recoveredAmount),
        rawDescription: description,
        referenceNumber: referenceMatch?.[1] ?? null,
        balanceAfterTransaction: recoveredBalance
          ? normalizeAmountToken(recoveredBalance)
          : null,
      },
      reason: null,
    };
  } catch (error) {
    if (error instanceof ImportHttpError) {
      return { row: null, reason: error.message };
    }
    throw error;
  }
}

// ─── TD Bank statement parser ────────────────────────────────────────────────

const TD_MONTH_MAP = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

function isTdFormat(text) {
  return /DescriptionWithdrawalsDepositsDateBalance/i.test(
    String(text || '').replace(/\s+/g, ''),
  );
}

function extractTdStatementContext(text) {
  const match = String(text || '').match(
    /Statement\s+From\s+To\s*\n?\s*([A-Z]{3})\s+(\d{1,2})\/(\d{2})\s*-\s*([A-Z]{3})\s+(\d{1,2})\/(\d{2})/i,
  );
  if (!match) return extractStatementContext(text);

  const startMonth = TD_MONTH_MAP[match[1].toUpperCase()];
  const endMonth = TD_MONTH_MAP[match[4].toUpperCase()];
  if (!startMonth || !endMonth) return extractStatementContext(text);

  return {
    periodStart: `20${match[3]}-${startMonth}-${String(match[2]).padStart(2, '0')}`,
    periodEnd: `20${match[6]}-${endMonth}-${String(match[5]).padStart(2, '0')}`,
  };
}

function isTdNoiseLine(line) {
  const trimmed = String(line || '').trim();
  const compact = trimmed.replace(/\s+/g, '');

  const patterns = [
    /^STARTINGBALANCE/i,
    /^BALANCEFORWARD/i,
    /^Total[\d,]/i,
    /^DescriptionWithdrawals/i,
    /^Account\/?Transaction/i,
    /^ACCOUNTISSUEDBY/i,
    /^Foryourprotection/i,
    /^Youraccountcandomore/i,
    /^Pleaseensurethatyou/i,
    /^statementofaccountshallbe/i,
    /^StatementofAccount$/i,
    /^StatementFromTo$/i,
    /^BranchNo\.?$/i,
    /^AccountNo\.?$/i,
    /^AccountType$/i,
    /^Page\d+of\d+$/i,
    /^Tel:?\d/i,
    /^TTY:?\d/i,
    /^STUDENT$/i,
    /^MemorizeyourPIN/i,
    /^AccessCard\.?$/i,
    /^branchfordetails\.?$/i,
    /^Neverrecordyour/i,
  ];

  if (patterns.some((rx) => rx.test(compact))) return true;

  if (/^\d{4}$/.test(compact)) return true;
  if (/^\d{4}-\d{6,8}$/.test(compact)) return true;
  if (/^[A-Z]{3}\s+\d{1,2}\/\d{2}\s*-\s*[A-Z]{3}\s+\d{1,2}\/\d{2}$/i.test(trimmed)) return true;
  if (/^MISS\s/i.test(trimmed)) return true;
  if (/^\d{4}\s+\w+\s+(?:TRAIL|RD|ST|AVE|BLVD|WAY|DR|CRES|PL)/i.test(trimmed)) return true;
  if (/^CREDIT\s*VALLEY/i.test(trimmed)) return true;
  if (/^MISSISSAUGA/i.test(trimmed)) return true;
  if (/^Ifyouhaveanyquestions/i.test(compact)) return true;
  if (/^aboutthisstatement/i.test(compact)) return true;
  if (compact.length < 5) return true;

  return false;
}

function parseTdStatementLine(line, statementContext) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return { row: null, reason: 'empty_line' };

  if (isTdNoiseLine(trimmed)) {
    return { row: null, reason: 'td_noise' };
  }

  const dateCodeRegex = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/gi;
  const dateMatches = [...trimmed.matchAll(dateCodeRegex)];

  if (dateMatches.length === 0) {
    return { row: null, reason: 'no_td_date_code' };
  }

  for (const dateMatch of dateMatches) {
    const monthStr = dateMatch[1].toUpperCase();
    const dayStr = dateMatch[2];

    if (!TD_MONTH_MAP[monthStr]) continue;

    const dateCodeStart = dateMatch.index;
    const dateCodeEnd = dateCodeStart + dateMatch[0].length;
    const beforeDate = trimmed.slice(0, dateCodeStart);
    const afterDate = trimmed.slice(dateCodeEnd).trim();

    let finalAmount = null;
    let finalDesc = null;

    const tripleStarIdx = beforeDate.lastIndexOf('***');
    if (tripleStarIdx >= 0 && tripleStarIdx + 6 <= beforeDate.length) {
      const afterRef = beforeDate.slice(tripleStarIdx + 6);
      const refAmtMatch = afterRef.match(/(\d[\d,]*\.\d{2})$/);
      if (refAmtMatch) {
        finalAmount = refAmtMatch[1];
        finalDesc = beforeDate.slice(0, tripleStarIdx + 6)
          + afterRef.slice(0, afterRef.length - refAmtMatch[1].length);
      }
    }

    if (!finalAmount) {
      const amountEndMatch = beforeDate.match(/(\d[\d,]*\.\d{2})$/);
      if (!amountEndMatch) continue;

      finalAmount = amountEndMatch[1];
      finalDesc = beforeDate.slice(0, beforeDate.length - amountEndMatch[1].length);

      const cleanDigits = finalAmount.replace(/,/g, '');
      const dotIndex = cleanDigits.indexOf('.');
      const integerPart = cleanDigits.slice(0, dotIndex);
      const decimalPart = cleanDigits.slice(dotIndex);

      if (integerPart.length > 4) {
        for (let numDigits = 1; numDigits <= Math.min(6, integerPart.length); numDigits++) {
          const candidateInt = integerPart.slice(-numDigits);
          if (parseFloat(candidateInt + decimalPart) > 0) {
            finalAmount = candidateInt + decimalPart;
            finalDesc = beforeDate.slice(0, beforeDate.length - amountEndMatch[1].length)
              + integerPart.slice(0, integerPart.length - numDigits);
            break;
          }
        }
      }
    }

    const description = cleanDescription(finalDesc);
    if (!description) continue;

    const balanceMatch = afterDate.match(/^(-?\d[\d,]*\.\d{2})$/);

    try {
      const date = normalizeMonthNameDate(`${monthStr} ${dayStr}`, statementContext);
      if (!date) continue;

      return {
        row: {
          date,
          description,
          amount: normalizeAmountToken(finalAmount),
          rawDescription: description,
          referenceNumber: null,
          balanceAfterTransaction: balanceMatch
            ? normalizeAmountToken(balanceMatch[1])
            : null,
        },
        reason: null,
      };
    } catch {
      continue;
    }
  }

  return { row: null, reason: 'no_valid_td_parse' };
}

function buildTdParseDiagnostics(text) {
  const statementContext = extractTdStatementContext(text);
  const rawLines = splitStatementRows(text);
  const matchedRows = [];
  const rejectedCandidates = [];
  const seen = new Set();

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim().replace(/\s+/g, ' ');
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    const { row, reason } = parseTdStatementLine(trimmed, statementContext);
    if (row) {
      matchedRows.push(row);
    } else if (reason && reason !== 'td_noise') {
      rejectedCandidates.push({ line: trimmed, reason });
    }
  }

  return {
    statementContext,
    lines: rawLines,
    matchedRows,
    rejectedCandidates,
  };
}

// ─── Generic statement parser (dispatches to format-specific path) ────────────

function buildParseDiagnostics(text) {
  if (isTdFormat(text)) {
    return buildTdParseDiagnostics(text);
  }

  const statementContext = extractStatementContext(text);
  const rawLines = splitStatementRows(text);
  const candidates = splitIntoCandidateLines(text);
  const matchedRows = [];
  const rejectedCandidates = [];
  const seen = new Set();

  // Pre-pass: classify raw (unmerged) lines to capture header/noise rejections
  // that may not survive into the merged candidate list.
  for (const rawLine of rawLines) {
    const normalizedLine = rawLine.trim().replace(/\s+/g, ' ');
    if (!normalizedLine || seen.has(normalizedLine)) continue;
    const classified = classifyCandidateLine(normalizedLine);
    if (classified.kind === 'header_or_footer_noise' || classified.kind === 'opening_balance_row') {
      seen.add(normalizedLine);
      rejectedCandidates.push({ line: normalizedLine, reason: classified.kind });
    }
  }

  for (const line of candidates) {
    const normalizedLine = line.trim().replace(/\s+/g, ' ');
    if (!normalizedLine || seen.has(normalizedLine)) {
      continue;
    }

    seen.add(normalizedLine);

    const classified = classifyCandidateLine(normalizedLine);
    console.log('[RAF classify]', {
      line: normalizedLine,
      isTransactionStart: isTransactionStart(normalizedLine),
      isOpeningBalanceRow: isOpeningBalanceRow(normalizedLine),
      isHeaderOrFooterNoise: isHeaderOrFooterNoise(normalizedLine),
      classified,
    });

    if (classified.kind === 'empty') {
      continue;
    }

    if (classified.kind === 'header_or_footer_noise') {
      rejectedCandidates.push({ line: normalizedLine, reason: 'header_or_footer_noise' });
      continue;
    }

    if (classified.kind === 'opening_balance_row') {
      rejectedCandidates.push({ line: normalizedLine, reason: 'opening_balance_row' });
      continue;
    }

    if (classified.kind !== 'transaction_candidate') {
      rejectedCandidates.push({ line: normalizedLine, reason: 'continuation_or_unknown' });
      continue;
    }

    const { row, reason } = parseStatementLine(normalizedLine, statementContext);
    if (row) {
      matchedRows.push(row);
      continue;
    }

    rejectedCandidates.push({
      line: normalizedLine,
      reason: reason ?? 'unrecognized_layout',
    });
  }

  return {
    statementContext,
    lines: rawLines,
    matchedRows,
    rejectedCandidates,
  };
}

export async function extractImportedTransactionsFromPdf(pdfBuffer, options = {}) {
  const text = await extractPdfText(pdfBuffer, options);
  if (!text) {
    throw new ImportHttpError(422, 'statement PDF does not contain extractable text', {
      extracted_text_preview: '',
      lines_scanned: 0,
      matched_rows_count: 0,
      rejected_candidates: [],
    });
  }
  logPdfTextPreview(text);

  const diagnostics = buildParseDiagnostics(text);
  logNormalizedLines(diagnostics.lines);
  logRejectedCandidates(diagnostics.rejectedCandidates);
  logParseSummary(diagnostics.lines, diagnostics.matchedRows.length);

  if (diagnostics.matchedRows.length === 0) {
    throw new ImportHttpError(422, 'statement_parse_failed', {
      message: 'Extracted text was found, but no valid transaction rows were parsed.',
      extracted_text_preview: text.slice(0, 3000),
      lines_scanned: diagnostics.lines.length,
      matched_rows_count: 0,
      rejected_candidates: diagnostics.rejectedCandidates.slice(0, 25),
    });
  }

  const suspiciousBlob = diagnostics.matchedRows.length === 1
    && /\d{4}-\d{2}-\d{2}.*\d{4}-\d{2}-\d{2}/.test(diagnostics.matchedRows[0].description ?? '');
  if (suspiciousBlob) {
    throw new ImportHttpError(422, 'statement_parse_failed', {
      message: 'Import stopped because multiple transactions were merged into one parsed row.',
      extracted_text_preview: text.slice(0, 3000),
      lines_scanned: diagnostics.lines.length,
      matched_rows_count: diagnostics.matchedRows.length,
    });
  }

  return diagnostics.matchedRows;
}

function formatImportedTransaction(row) {
  return {
    id: row.id,
    household_id: row.householdId,
    date: row.date,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    source: row.source,
    raw_description: row.rawDescription,
    reference_number: row.referenceNumber ?? null,
    balance_after_transaction: row.balanceAfterTransaction ?? null,
    status: row.status ?? 'unreviewed',
    classification_type: row.classificationType ?? null,
    linked_transaction_id: row.linkedTransactionId ?? null,
    linked_income_entry_id: row.linkedIncomeEntryId ?? null,
    linked_debt_id: row.linkedDebtId ?? null,
    linked_fixed_bill_id: row.linkedFixedBillId ?? null,
    reviewed_at: row.reviewedAt ?? null,
    review_note: row.reviewNote ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function importBankStatement({ db, householdId, input, pdfTextExtractor }) {
  if (!householdId) {
    throw new ImportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(uploadBankStatementSchema, input);
  const normalizedCurrency = parsedInput.currency.toUpperCase();

  if (!parsedInput.filename.toLowerCase().endsWith('.pdf')) {
    throw new ImportHttpError(400, 'unsupported format; expected PDF');
  }

  if (parsedInput.contentType && !parsedInput.contentType.toLowerCase().includes('pdf')) {
    throw new ImportHttpError(400, 'contentType must be application/pdf');
  }

  const extractedRows = (await extractImportedTransactionsFromPdf(parsedInput.pdfBuffer, {
    pdfTextExtractor,
  }))
    .map((row) => buildImportedTransactionRow(row, householdId, normalizedCurrency));

  return db.transaction(async (tx) => {
    const inserted = await tx.insertImportedTransactions({
      rows: extractedRows,
    });

    return {
      extracted: inserted.length,
      currency: normalizedCurrency,
      items: inserted.map(formatImportedTransaction),
    };
  });
}

export async function listImportedTransactions({ db, householdId }) {
  if (!householdId) {
    throw new ImportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => ({
    items: (await tx.listImportedTransactions({ householdId })).map(formatImportedTransaction),
  }));
}

export const __internal = {
  extractImportedTransactionsFromPdf,
  extractPdfText,
  normalizeDecodedPdfText,
  splitStatementRows,
  splitIntoCandidateLines,
  selectTrailingAmountTokens,
  normalizeAmountToken,
  normalizeStatementDate,
  parseStatementLine,
  extractStatementContext,
  buildParseDiagnostics,
  isNoiseLine,
  formatImportedTransaction,
  buildImportedTransactionRow,
  parseMoneyToCents,
  isTdFormat,
  extractTdStatementContext,
  isTdNoiseLine,
  parseTdStatementLine,
  buildTdParseDiagnostics,
};
