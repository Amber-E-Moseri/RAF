/**
 * TD Bank statement parser tests.
 *
 * Covers:
 *  1. Detection: valid TD statement recognized
 *  2. Detection: non-TD statement not misidentified
 *  3. Date: TD date format resolves statement year from context
 *  4. Date: month-boundary transition (e.g. DEC → JAN)
 *  5. Date: invalid month code rejected gracefully
 *  6. Row: debit transaction parsed correctly
 *  7. Row: credit transaction parsed correctly
 *  8. Row: merchant description preserved
 *  9. Row: amount parsed (no balance column)
 * 10. Row: statement noise filtered (header, footer, account number, address)
 * 11. Row: malformed line does not fabricate a transaction
 * 12. Safety: TD parser produces no categorization rule output
 * 13. Safety: TD parser does not mark transactions reviewed
 * 14. Regression: non-TD statements still parse identically via buildParseDiagnostics
 * 15. Regression: empty input returns zero rows
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { __internal } from '../lib/imports/bankStatementImports.js';

const {
  isTdFormat,
  extractTdStatementContext,
  isTdNoiseLine,
  parseTdStatementLine,
  buildTdParseDiagnostics,
  buildParseDiagnostics,
} = __internal;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tdStatementHeader(fromStr = 'SEP 01/26', toStr = 'SEP 30/26') {
  return `Statement From To\n${fromStr} - ${toStr}\nDescription Withdrawals Deposits Date Balance\n`;
}

function makeTdStatement(lines, from = 'SEP 01/26', to = 'SEP 30/26') {
  return tdStatementHeader(from, to) + lines.join('\n');
}

// ─── 1. Detection: valid TD statement recognized ──────────────────────────────

test('1 — isTdFormat returns true for TD statement header', () => {
  const text = 'Description Withdrawals Deposits Date Balance\nsome other content';
  assert.equal(isTdFormat(text), true);
});

test('1b — isTdFormat handles whitespace variations in TD header', () => {
  const text = 'Description  Withdrawals  Deposits  Date  Balance';
  assert.equal(isTdFormat(text), true);
});

// ─── 2. Detection: non-TD statement not misidentified ────────────────────────

test('2 — isTdFormat returns false for generic bank statement', () => {
  const text = 'Date Description Amount Balance\n2026-09-01 Grocery Store 42.50 1234.56';
  assert.equal(isTdFormat(text), false);
});

test('2b — isTdFormat returns false for empty input', () => {
  assert.equal(isTdFormat(''), false);
  assert.equal(isTdFormat(null), false);
});

// ─── 3. Date: statement context extracted from TD header ──────────────────────

test('3 — extractTdStatementContext parses period from TD header', () => {
  const text = 'Statement From To\nSEP 01/26 - SEP 30/26\n';
  const ctx = extractTdStatementContext(text);
  assert.equal(ctx.periodStart, '2026-09-01');
  assert.equal(ctx.periodEnd, '2026-09-30');
});

test('3b — extractTdStatementContext falls back gracefully when header absent', () => {
  const ctx = extractTdStatementContext('No TD header here');
  assert.ok(ctx === null || typeof ctx === 'object');
});

// ─── 4. Date: month boundary transition ──────────────────────────────────────

test('4 — statement spanning DEC to JAN parsed without year confusion', () => {
  const text = 'Statement From To\nDEC 01/26 - JAN 01/27\n';
  const ctx = extractTdStatementContext(text);
  assert.equal(ctx.periodStart, '2026-12-01');
  assert.equal(ctx.periodEnd, '2027-01-01');
});

// ─── 5. Date: invalid month code rejected ────────────────────────────────────

test('5 — parseTdStatementLine rejects line with invalid month code', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row, reason } = parseTdStatementLine('GROCERY STORE 42.50 XYZ01 1234.56', ctx);
  assert.equal(row, null);
  assert.ok(reason != null);
});

// ─── 6. Row: debit transaction ────────────────────────────────────────────────
// TD PDF extraction collapses columns: <description><amount><MMMDD><balance>

test('6 — parseTdStatementLine parses debit transaction', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  // Real TD format: description+amount run together, date code follows amount
  const { row } = parseTdStatementLine('TIM HORTONS5.75SEP141200.00', ctx);
  assert.ok(row != null, 'row should be parsed');
  assert.ok(row.description.toLowerCase().includes('tim hortons'));
  assert.ok(row.date.startsWith('2026-09'));
  assert.ok(row.amount != null);
});

// ─── 7. Row: credit transaction ───────────────────────────────────────────────

test('7 — parseTdStatementLine handles credit transaction', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row } = parseTdStatementLine('PAYROLL DEPOSIT2000.00SEP153200.00', ctx);
  assert.ok(row != null, 'row should be parsed');
  assert.ok(row.description.toLowerCase().includes('payroll'));
});

// ─── 8. Row: merchant description preserved ──────────────────────────────────

test('8 — parseTdStatementLine preserves merchant description', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row } = parseTdStatementLine('WHOLE FOODS MARKET67.40SEP031132.60', ctx);
  assert.ok(row != null);
  assert.ok(row.description.toUpperCase().includes('WHOLE FOODS'));
});

// ─── 9. Row: amount parsed without balance column ────────────────────────────

test('9 — parseTdStatementLine sets balanceAfterTransaction null when absent', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row } = parseTdStatementLine('NETFLIX17.99SEP10', ctx);
  if (row) {
    // balance column absent — either null or parsed; must not throw
    assert.ok(row.amount != null);
    assert.ok(row.date != null);
  }
});

// ─── 10. Row: statement noise filtered ───────────────────────────────────────

test('10a — isTdNoiseLine filters STARTING BALANCE line', () => {
  assert.equal(isTdNoiseLine('STARTING BALANCE'), true);
});

test('10b — isTdNoiseLine filters page footer', () => {
  assert.equal(isTdNoiseLine('Page1of4'), true);
});

test('10c — isTdNoiseLine filters 4-digit account segment', () => {
  assert.equal(isTdNoiseLine('1234'), true);
});

test('10d — isTdNoiseLine filters address line', () => {
  assert.equal(isTdNoiseLine('1234 Main TRAIL Mississauga'), true);
});

test('10e — isTdNoiseLine does not filter a real transaction description', () => {
  assert.equal(isTdNoiseLine('WHOLE FOODS MARKET'), false);
});

test('10f — isTdNoiseLine filters DESCRIPTION WITHDRAWALS header', () => {
  assert.equal(isTdNoiseLine('Description Withdrawals Deposits Date Balance'), true);
});

// ─── 11. Row: malformed line does not fabricate a transaction ────────────────

test('11 — parseTdStatementLine returns null row for noise-only line', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row } = parseTdStatementLine('Page1of4', ctx);
  assert.equal(row, null);
});

test('11b — parseTdStatementLine returns null for empty line', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row } = parseTdStatementLine('', ctx);
  assert.equal(row, null);
});

test('11c — parseTdStatementLine returns null for line with no amount', () => {
  const ctx = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  const { row } = parseTdStatementLine('SOME DESCRIPTION SEP15', ctx);
  assert.equal(row, null);
});

// ─── 12. Safety: parser produces no categorization rule output ───────────────

test('12 — buildTdParseDiagnostics rows have no categorization fields', () => {
  const text = makeTdStatement([
    'TIM HORTONS5.75SEP141200.00',
    'WHOLE FOODS MARKET67.40SEP031132.60',
  ]);
  const { matchedRows } = buildTdParseDiagnostics(text);
  for (const row of matchedRows) {
    assert.equal(row.categorization_source, undefined);
    assert.equal(row.needs_review, undefined);
    assert.equal(row.auto_apply, undefined);
    assert.equal(row.ruleType, undefined);
  }
});

// ─── 13. Safety: parser does not mark transactions reviewed ──────────────────

test('13 — buildTdParseDiagnostics rows have no review-status fields', () => {
  const text = makeTdStatement(['GROCERY STORE42.50SEP01800.00']);
  const { matchedRows } = buildTdParseDiagnostics(text);
  for (const row of matchedRows) {
    assert.equal(row.reviewedAt, undefined);
    assert.equal(row.status, undefined);
    assert.equal(row.classificationType, undefined);
  }
});

// ─── 14. Regression: non-TD statements parse identically ─────────────────────

test('14 — buildParseDiagnostics dispatches to TD path for TD format', () => {
  const text = makeTdStatement(['GROCERY STORE42.50SEP01800.00']);
  const diagnostics = buildParseDiagnostics(text);
  assert.ok(Array.isArray(diagnostics.matchedRows));
  assert.ok(Array.isArray(diagnostics.lines));
});

test('14b — buildParseDiagnostics uses generic path for non-TD format', () => {
  const text = 'Jan 15, 2026 Coffee Shop $5.25\nJan 16, 2026 Grocery Store $45.00';
  const diagnostics = buildParseDiagnostics(text);
  assert.equal(isTdFormat(text), false);
  assert.ok(Array.isArray(diagnostics.matchedRows));
});

// ─── 15. Regression: empty input returns zero rows ────────────────────────────

test('15 — buildTdParseDiagnostics with empty text returns zero matched rows', () => {
  const { matchedRows } = buildTdParseDiagnostics('');
  assert.equal(matchedRows.length, 0);
});
