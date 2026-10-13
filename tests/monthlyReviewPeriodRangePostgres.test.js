/**
 * Monthly review period totals against real PostgreSQL.
 *
 * Regression for: review reads passed from = to = the first of the month. Postgres range
 * filters are inclusive, so only day one counted (income 100.00 instead of 600.00). Transaction
 * reads were also a single default page of 50, so spending above 50 rows was understated.
 *
 * Gate: runs only when BOTH are set:
 *   RAF_CONFIRM_NON_PRODUCTION_DB=true
 *   POSTGRES_CONNECTION_STRING=postgresql://<owner>@127.0.0.1:<port>/<disposable_db_name_containing_test>
 * Never point this at a production or Neon database.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { createPostgresDb } from '../lib/server/postgresDb.js';
import { getMonthlyReviewReport } from '../lib/reports/getMonthlyReviewReport.js';
import { monthRangeFor } from '../lib/dates.js';

const adminUrl = process.env.POSTGRES_CONNECTION_STRING ?? '';

function isDisposableLocalUrl(value) {
  try {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return local && /(test|_ci)$/i.test(dbName);
  } catch {
    return false;
  }
}

const shouldRun = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true'
  && adminUrl !== ''
  && isDisposableLocalUrl(adminUrl);
const maybeTest = shouldRun ? test : test.skip;

// ── Pure range contract (no database) ─────────────────────────────────────────

test('monthRangeFor covers the full calendar month, inclusive on both ends', () => {
  assert.deepEqual(monthRangeFor('2026-09-01'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthRangeFor('2026-02-01'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRangeFor('2028-02-01'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthRangeFor('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
});

test('monthRangeFor rejects malformed anchors', () => {
  assert.throws(() => monthRangeFor('2026-9'));
  assert.throws(() => monthRangeFor(undefined));
});

// ── Real PostgreSQL ───────────────────────────────────────────────────────────

const SEP_TXN_COUNT = 60; // more than one default page (50)
const SEP_DEBIT_EACH = '1.00';
let owner;
let db;
let workspaceId;

before(async () => {
  if (!shouldRun) return;
  owner = new pg.Pool({ connectionString: adminUrl, max: 2 });
  // Seed through the real adapter write path (no session_replication_role, which needs superuser
  // and CI's owner role is not one). Mirrors seedWorkspaceWithBuffer in postgresAtomicBufferClose.
  const ownerDb = createPostgresDb({ connectionString: adminUrl, ssl: false });
  const ownerUserId = crypto.randomUUID();
  await ownerDb.transaction(async (tx) => {
    await tx.createUser({ id: ownerUserId, email: `review-range-${crypto.randomUUID()}@test.test`, passwordHash: 'test-hash' });
    const workspace = await tx.createWorkspace({ ownerUserId, name: 'Review range' });
    workspaceId = workspace.id;
    await tx.createWorkspaceMember({ workspaceId, userId: ownerUserId, role: 'owner', status: 'active' });
  });
  const householdId = workspaceId;
  const bufferCategoryId = await ownerDb.transaction(async (tx) => {
    const cats = await tx.listAllocationCategories({ householdId, asOf: '2026-09-01' });
    return cats.find((c) => c.isBuffer === true && c.isActive !== false)?.id ?? null;
  });
  if (!bufferCategoryId) throw new Error(`No buffer category for workspace ${householdId}`);

  const income = (receivedDate, amount) => ownerDb.transaction(async (tx) => {
    const entry = await tx.insertIncomeEntry({ householdId, receivedDate, amount, sourceName: 'Pay' });
    await tx.insertIncomeAllocations([{
      householdId,
      incomeEntryId: entry.id,
      allocationCategoryId: bufferCategoryId,
      allocatedAmount: amount,
      allocationPercent: '1.0000',
    }]);
  });
  await income('2026-09-01', '100.00');
  await income('2026-09-15', '200.00');
  await income('2026-09-30', '300.00');
  await income('2026-10-01', '400.00'); // outside September: must be excluded

  const debit = (transactionDate, amount) => ownerDb.transaction((tx) => tx.insertTransaction({
    householdId,
    transactionDate,
    description: 'Purchase',
    merchant: 'Shop',
    amount,
    direction: 'debit',
    categoryId: null,
    source: 'manual',
  }));
  for (let i = 0; i < SEP_TXN_COUNT; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    await debit(`2026-09-${day}`, SEP_DEBIT_EACH);
  }
  await debit('2026-10-01', '999.00'); // outside September: must be excluded

  await ownerDb.close?.();
  db = createPostgresDb({ connectionString: adminUrl, ssl: false });
});

after(async () => {
  if (db?.close) await db.close();
  if (owner) await owner.end();
});

maybeTest('review income covers every day of the month, not only the 1st', async () => {
  const report = await getMonthlyReviewReport({ db, householdId: workspaceId, year: 2026, periodMonth: 9 });
  assert.equal(report.monthlySummary.totalIncome, '600.00');
});

maybeTest('review spending reads every page of September transactions, not only the first 50', async () => {
  const report = await getMonthlyReviewReport({ db, householdId: workspaceId, year: 2026, periodMonth: 9 });
  const expected = (SEP_TXN_COUNT * Number(SEP_DEBIT_EACH)).toFixed(2);
  assert.equal(report.monthlySummary.totalSpent, expected);
});

maybeTest('review excludes transactions and income outside the requested month', async () => {
  const report = await getMonthlyReviewReport({ db, householdId: workspaceId, year: 2026, periodMonth: 9 });
  assert.notEqual(report.monthlySummary.totalIncome, '1000.00');
  assert.notEqual(report.monthlySummary.totalSpent, (SEP_TXN_COUNT + 999).toFixed(2));
});

maybeTest('financial health active-month income covers the whole month (cumulative reads are not cut at the 1st)', async () => {
  const { getFinancialHealthReport } = await import('../lib/reports/getFinancialHealthReport.js');
  const report = await getFinancialHealthReport({ db, householdId: workspaceId, month: '2026-09-01' });
  assert.equal(report.activeMonthIncome, '600.00');
});

maybeTest('dashboard September spending covers all 60 transactions, not only the first page of 50', async () => {
  const { getDashboardReport } = await import('../lib/reports/getDashboardReport.js');
  const report = await getDashboardReport({ db, householdId: workspaceId, year: 2026, month: 9 });
  assert.equal(report.periods[0].spendingTotal, (SEP_TXN_COUNT * Number(SEP_DEBIT_EACH)).toFixed(2));
});

maybeTest('data export includes every transaction, not only the first page of 50', async () => {
  const { buildDataExport } = await import('../lib/exports/buildDataExport.js');
  const data = await buildDataExport({ db, householdId: workspaceId });
  assert.equal(data.transactions.length, SEP_TXN_COUNT + 1, 'all September debits plus the October debit');
});
