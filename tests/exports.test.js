/**
 * Export HTTP route + buildDataExport lib tests.
 *
 * Scope:
 *   - buildDataExport: shape, date-range filtering, field projection, tenant isolation
 *   - rowsToCsv: headers, quoting
 *   - GET /exports: validation, json format, csv format, date params, missing household
 *
 * The existing exportDeletion.test.js covers cross-workspace isolation via
 * a full server spawn. These tests cover the route and lib layer directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDataExport, rowsToCsv } from '../lib/exports/buildDataExport.js';
import { GET as exportsGet } from '../app/api/v1/exports/route.js';

// ── Minimal db double for buildDataExport ─────────────────────────────────────

function makeExportDb({
  transactions = [],
  income = [],
  debts = [],
  goals = [],
  monthlyReviews = [],
  allocationCategories = [],
} = {}) {
  return {
    async transaction(cb) {
      return cb({
        async listTransactions() { return { items: transactions }; },
        async listIncomeEntries() { return income; },
        async listDebts() { return debts; },
        async listGoals() { return goals; },
        async listMonthlyReviews() { return monthlyReviews; },
        async listAllocationCategories() { return allocationCategories; },
      });
    },
  };
}

// ── buildDataExport: shape ────────────────────────────────────────────────────

test('buildDataExport returns all six top-level entity arrays', async () => {
  const db = makeExportDb();
  const result = await buildDataExport({ db, householdId: 'household_1' });

  assert.ok(typeof result.exported_at === 'string');
  assert.equal(result.household_id, 'household_1');
  assert.ok(Array.isArray(result.transactions));
  assert.ok(Array.isArray(result.income));
  assert.ok(Array.isArray(result.debts));
  assert.ok(Array.isArray(result.goals));
  assert.ok(Array.isArray(result.monthly_reviews));
  assert.ok(Array.isArray(result.allocation_categories));
});

test('buildDataExport projects transactions to the expected fields only', async () => {
  const db = makeExportDb({
    transactions: [{
      id: 'txn_1',
      transactionDate: '2026-03-10',
      merchant: 'Coffee Shop',
      description: 'Coffee Shop receipt line',
      amount: '4.50',
      direction: 'debit',
      categorySlug: 'personal_spending',
      source: 'manual',
      // fields that must not appear in export
      householdId: 'household_1',
      accountNumber: '****1234',
      rawBankText: 'COFFEESHOP 12345678 STMT',
    }],
  });

  const result = await buildDataExport({ db, householdId: 'household_1' });
  assert.equal(result.transactions.length, 1);

  const tx = result.transactions[0];
  assert.ok(Object.hasOwn(tx, 'id'));
  assert.ok(Object.hasOwn(tx, 'date'));
  assert.ok(Object.hasOwn(tx, 'merchant'));
  assert.ok(Object.hasOwn(tx, 'amount'));
  assert.ok(Object.hasOwn(tx, 'direction'));
  assert.ok(Object.hasOwn(tx, 'category_slug'));
  assert.ok(Object.hasOwn(tx, 'source'));

  // Sensitive / internal fields must not be exported
  assert.equal(Object.hasOwn(tx, 'householdId'), false);
  assert.equal(Object.hasOwn(tx, 'accountNumber'), false);
  assert.equal(Object.hasOwn(tx, 'rawBankText'), false);
});

test('buildDataExport projects income entries to the expected fields', async () => {
  const db = makeExportDb({
    income: [{ id: 'inc_1', receivedDate: '2026-03-05', sourceName: 'Employer A', amount: '3000.00', householdId: 'h1' }],
  });
  const result = await buildDataExport({ db, householdId: 'household_1' });
  const entry = result.income[0];
  assert.ok(Object.hasOwn(entry, 'id'));
  assert.ok(Object.hasOwn(entry, 'date'));
  assert.ok(Object.hasOwn(entry, 'source'));
  assert.ok(Object.hasOwn(entry, 'amount'));
  assert.equal(Object.hasOwn(entry, 'householdId'), false);
});

test('buildDataExport projects debts without internal IDs or allocation details', async () => {
  const db = makeExportDb({
    debts: [{ id: 'debt_1', name: 'Visa', currentBalance: '2500.00', interestRate: 19.99, minimumPayment: '90.00', householdId: 'h1' }],
  });
  const result = await buildDataExport({ db, householdId: 'household_1' });
  const debt = result.debts[0];
  assert.ok(Object.hasOwn(debt, 'id'));
  assert.ok(Object.hasOwn(debt, 'name'));
  assert.ok(Object.hasOwn(debt, 'balance'));
  assert.ok(Object.hasOwn(debt, 'apr'));
  assert.ok(Object.hasOwn(debt, 'minimum_payment'));
  assert.equal(Object.hasOwn(debt, 'householdId'), false);
});

// ── buildDataExport: date range filtering ─────────────────────────────────────

test('buildDataExport fromMonth excludes transactions before that date', async () => {
  const db = makeExportDb({
    transactions: [
      { id: 'jan', transactionDate: '2026-01-15', amount: '10.00', direction: 'debit' },
      { id: 'mar', transactionDate: '2026-03-15', amount: '20.00', direction: 'debit' },
    ],
  });
  const result = await buildDataExport({ db, householdId: 'household_1', fromMonth: '2026-03-01' });
  const ids = result.transactions.map((t) => t.id);
  assert.ok(!ids.includes('jan'), 'January transaction must be excluded');
  assert.ok(ids.includes('mar'), 'March transaction must be included');
});

test('buildDataExport toMonth excludes transactions after that date', async () => {
  const db = makeExportDb({
    transactions: [
      { id: 'jan', transactionDate: '2026-01-15', amount: '10.00', direction: 'debit' },
      { id: 'apr', transactionDate: '2026-04-10', amount: '20.00', direction: 'debit' },
    ],
  });
  const result = await buildDataExport({ db, householdId: 'household_1', toMonth: '2026-02-28' });
  const ids = result.transactions.map((t) => t.id);
  assert.ok(ids.includes('jan'));
  assert.ok(!ids.includes('apr'), 'April transaction must be excluded');
});

test('buildDataExport from+to date range filters income entries', async () => {
  const db = makeExportDb({
    income: [
      { id: 'inc_feb', receivedDate: '2026-02-05', amount: '2000.00' },
      { id: 'inc_apr', receivedDate: '2026-04-05', amount: '2000.00' },
    ],
  });
  const result = await buildDataExport({ db, householdId: 'household_1', fromMonth: '2026-03-01', toMonth: '2026-03-31' });
  assert.equal(result.income.length, 0, 'no income entries fall in the March window');
});

test('buildDataExport date_range field reflects passed params', async () => {
  const db = makeExportDb();
  const result = await buildDataExport({ db, householdId: 'h1', fromMonth: '2026-01-01', toMonth: '2026-12-31' });
  assert.equal(result.date_range.from, '2026-01-01');
  assert.equal(result.date_range.to, '2026-12-31');
});

test('buildDataExport date_range is null-null when no params given', async () => {
  const db = makeExportDb();
  const result = await buildDataExport({ db, householdId: 'h1' });
  assert.equal(result.date_range.from, null);
  assert.equal(result.date_range.to, null);
});

// ── rowsToCsv ─────────────────────────────────────────────────────────────────

test('rowsToCsv produces a header row followed by data rows', () => {
  const csv = rowsToCsv(['id', 'amount', 'direction'], [
    { id: 'txn_1', amount: '12.50', direction: 'debit' },
    { id: 'txn_2', amount: '3.00', direction: 'credit' },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'id,amount,direction');
  assert.equal(lines[1], 'txn_1,12.50,debit');
  assert.equal(lines[2], 'txn_2,3.00,credit');
});

test('rowsToCsv quotes values containing commas', () => {
  const csv = rowsToCsv(['merchant'], [{ merchant: 'Coffee, Baked Goods & More' }]);
  const lines = csv.split('\n');
  assert.equal(lines[1], '"Coffee, Baked Goods & More"');
});

test('rowsToCsv quotes values containing double quotes and escapes them', () => {
  const csv = rowsToCsv(['note'], [{ note: 'She said "hello"' }]);
  const lines = csv.split('\n');
  assert.equal(lines[1], '"She said ""hello"""');
});

test('rowsToCsv outputs empty string for null/undefined values', () => {
  const csv = rowsToCsv(['a', 'b'], [{ a: null, b: undefined }]);
  const lines = csv.split('\n');
  assert.equal(lines[1], ',');
});

// ── GET /exports HTTP route ───────────────────────────────────────────────────

function exportReq(params = '', { householdId = 'household_1' } = {}) {
  const url = `http://localhost/api/v1/exports${params ? `?${params}` : ''}`;
  return new Request(url, { headers: { 'x-household-id': householdId } });
}

function exportCtx(db, householdId = 'household_1') {
  return { db, householdId };
}

test('exports GET returns 400 when householdId is missing', async () => {
  const db = makeExportDb();
  const req = new Request('http://localhost/api/v1/exports');
  const res = await exportsGet(req, { db, householdId: null });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string');
});

test('exports GET returns 400 for invalid format parameter', async () => {
  const db = makeExportDb();
  const res = await exportsGet(exportReq('format=xml'), exportCtx(db));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /format/);
});

test('exports GET format=json returns 200 with correct structure', async () => {
  const db = makeExportDb({
    transactions: [{ id: 'tx1', transactionDate: '2026-03-01', merchant: 'Store', amount: '10.00', direction: 'debit' }],
  });
  const res = await exportsGet(exportReq('format=json'), exportCtx(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.exported_at === 'string');
  assert.ok(Array.isArray(body.transactions));
  assert.ok(Array.isArray(body.income));
  assert.ok(Array.isArray(body.debts));
  assert.ok(Array.isArray(body.goals));
  assert.ok(Array.isArray(body.monthly_reviews));
  assert.ok(Array.isArray(body.allocation_categories));
});

test('exports GET default format is json', async () => {
  const db = makeExportDb();
  const res = await exportsGet(exportReq(''), exportCtx(db));
  assert.equal(res.status, 200);
  const contentType = res.headers.get('content-type') ?? '';
  assert.ok(contentType.includes('application/json'), `expected json content-type, got: ${contentType}`);
});

test('exports GET format=csv returns text/csv with Content-Disposition attachment', async () => {
  const db = makeExportDb({
    transactions: [{ id: 'tx1', transactionDate: '2026-03-01', merchant: 'Store', amount: '10.00', direction: 'debit', categorySlug: 'spending', source: 'manual' }],
  });
  const res = await exportsGet(exportReq('format=csv'), exportCtx(db));
  assert.equal(res.status, 200);
  const contentType = res.headers.get('content-type') ?? '';
  assert.ok(contentType.includes('text/csv'), `expected text/csv, got: ${contentType}`);
  const disposition = res.headers.get('content-disposition') ?? '';
  assert.ok(disposition.includes('attachment'), `expected attachment disposition, got: ${disposition}`);
  assert.ok(disposition.includes('transactions'), 'filename should reference transactions');
});

test('exports GET format=csv body starts with the correct CSV header row', async () => {
  const db = makeExportDb();
  const res = await exportsGet(exportReq('format=csv'), exportCtx(db));
  const text = await res.text();
  const firstLine = text.split('\n')[0];
  assert.equal(firstLine, 'id,date,merchant,description,amount,direction,category_slug,source');
});

test('exports GET from/to query params are applied to the export', async () => {
  const db = makeExportDb({
    transactions: [
      { id: 'jan', transactionDate: '2026-01-10', merchant: 'Jan Store', amount: '5.00', direction: 'debit' },
      { id: 'mar', transactionDate: '2026-03-10', merchant: 'Mar Store', amount: '8.00', direction: 'debit' },
    ],
  });
  const res = await exportsGet(exportReq('format=json&from=2026-03-01&to=2026-03-31'), exportCtx(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.transactions.map((t) => t.id);
  assert.ok(!ids.includes('jan'), 'January transaction must be excluded by from param');
  assert.ok(ids.includes('mar'));
  assert.equal(body.date_range.from, '2026-03-01');
  assert.equal(body.date_range.to, '2026-03-31');
});
