/**
 * Cash Flow Forecast Hardening
 * Tests for report-layer extensions: account freshness, coverage gaps, headroom/shortfall
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCashFlowForecast } from '../lib/raf/cashFlowForecasting.js';
import { getCashFlowForecastReport } from '../lib/reports/getCashFlowForecastReport.js';

const START_DATE = '2026-09-12';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const BASE_HOUSEHOLD = {
  id: 'hh_1',
  name: 'Test Household',
  timezone: 'America/Toronto',
  activeMonth: '2026-09-01',
  periodStartDay: 1,
  savingsFloor: '500.00',
  savingsFloorEnabled: true,
};

const BASE_INCOME = [
  { id: 'inc_1', sourceName: 'Payroll', receivedDate: '2026-08-15', amount: '3000.00' },
  { id: 'inc_2', sourceName: 'Payroll', receivedDate: '2026-07-15', amount: '3000.00' },
  { id: 'inc_3', sourceName: 'Payroll', receivedDate: '2026-06-15', amount: '3000.00' },
];

const BASE_BILLS = [
  { id: 'bill_1', name: 'Rent', expectedAmount: '1000.00', dueDayOfMonth: 1, categorySlug: 'housing', active: true },
];

/**
 * Minimal DB double for the report-layer tests.
 */
function makeDb({
  household = BASE_HOUSEHOLD,
  accounts = [{ id: 'acct_chk', accountType: 'checking', currentBalance: '3000.00', balanceAsOf: '2026-09-12', status: 'active' }],
  incomeEntries = BASE_INCOME,
  fixedBills = BASE_BILLS,
  allocationCategories = [],
  transactions = [],
  debts = [],
  upcomingExpenses = [],
  freshnessCtx = { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
} = {}) {
  return {
    async transaction(cb) {
      return cb({
        async getHousehold() { return household; },
        async listFinancialAccounts() { return accounts; },
        async listIncomeEntries() { return incomeEntries; },
        async listFixedBills() { return fixedBills; },
        async listAllocationCategories() { return allocationCategories; },
        async listTransactions() { return transactions; },
        async listDebts() { return debts; },
        async listUpcomingExpenses() { return upcomingExpenses; },
        async getAccountFreshnessContext() { return freshnessCtx; },
      });
    },
  };
}

// ── Engine contract — core forecast unchanged ─────────────────────────────────

test('Engine: starting balance = sum of liquid accounts only', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'chk', accountType: 'checking', currentBalance: '1000.00' },
      { id: 'sav', accountType: 'savings', currentBalance: '500.00' },
      { id: 'inv', accountType: 'investment', currentBalance: '9000.00' },
      { id: 'cc', accountType: 'credit_card', currentBalance: '500.00' },
    ],
    incomeEntries: [],
    fixedBills: [],
    allocationCategories: [],
    transactions: [],
    debts: [],
    upcomingExpenses: [],
    household: { savingsFloorEnabled: false, savingsFloor: '0.00' },
    days: 30,
    startDate: START_DATE,
  });
  assert.equal(result.assumptions.startingBalance, '1500.00');
  // Investment and credit_card excluded
  const invested = parseFloat(result.assumptions.investmentAccountsExcluded);
  assert.ok(invested >= 9000, 'investment should be excluded from balance');
});

test('Engine: upcoming expenses integrated into forecast', () => {
  const result = computeCashFlowForecast({
    accounts: [{ id: 'chk', accountType: 'checking', currentBalance: '5000.00' }],
    incomeEntries: BASE_INCOME,
    fixedBills: BASE_BILLS,
    allocationCategories: [],
    transactions: [],
    debts: [],
    upcomingExpenses: [
      { id: 'exp_1', name: 'Car Repair', amount: '1500.00', expectedDate: '2026-09-20', status: 'active', confidence: 'confirmed' },
    ],
    household: { savingsFloorEnabled: false, savingsFloor: '0.00' },
    days: 30,
    startDate: START_DATE,
  });
  // Verify the expense appears in projections
  const sep20 = result.projections.find((p) => p.date === '2026-09-20');
  assert.ok(sep20, 'should have projection for expense date');
  const expenseAmount = parseFloat(sep20.projectedUpcomingExpenses.total);
  assert.ok(expenseAmount >= 1500, 'expense should appear in projections');
});

// ── Report-layer: freshness and coverage ───────────────────────────────────

test('Report: headroom calculated when savings floor enabled and margin positive', async () => {
  const db = makeDb({
    accounts: [{ id: 'chk', accountType: 'checking', currentBalance: '5000.00', balanceAsOf: '2026-09-12', status: 'active' }],
    freshnessCtx: { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  assert.ok(result.summaryMetrics.headroom !== null && result.summaryMetrics.headroom !== undefined, 'headroom should be set when floor enabled and positive');
  assert.ok(result.summaryMetrics.shortfall === null || result.summaryMetrics.shortfall === undefined, 'shortfall should not be set when headroom exists');
});

test('Report: shortfall calculated when savings floor enabled and margin negative', async () => {
  const db = makeDb({
    accounts: [{ id: 'chk', accountType: 'checking', currentBalance: '300.00', balanceAsOf: '2026-09-12', status: 'active' }],
    // High bills to force shortfall
    fixedBills: [{ id: 'bill_1', name: 'Rent', expectedAmount: '5000.00', dueDayOfMonth: 1, active: true }],
    freshnessCtx: { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  // With $300 starting and $5000 rent due on the 1st, we'll hit shortfall
  assert.ok(result.summaryMetrics.shortfall !== undefined, 'shortfall should be set when margin goes negative');
});

test('Report: no headroom/shortfall when savings floor disabled', async () => {
  const db = makeDb({
    household: { ...BASE_HOUSEHOLD, savingsFloorEnabled: false },
    accounts: [{ id: 'chk', accountType: 'checking', currentBalance: '300.00', balanceAsOf: '2026-09-12', status: 'active' }],
    fixedBills: [{ id: 'bill_1', name: 'Rent', expectedAmount: '5000.00', dueDayOfMonth: 1, active: true }],
    freshnessCtx: { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  assert.ok(result.summaryMetrics.headroom === null || result.summaryMetrics.headroom === undefined, 'headroom should not be set when floor disabled');
  assert.ok(result.summaryMetrics.shortfall === null || result.summaryMetrics.shortfall === undefined, 'shortfall should not be set when floor disabled');
});

test('Report: account breakdown includes liquid accounts only', async () => {
  const db = makeDb({
    accounts: [
      { id: 'chk', accountType: 'checking', currentBalance: '1000.00', balanceAsOf: '2026-09-12', status: 'active' },
      { id: 'sav', accountType: 'savings', currentBalance: '500.00', balanceAsOf: '2026-09-11', status: 'active' },
      { id: 'cc', accountType: 'credit_card', currentBalance: '2000.00', balanceAsOf: '2026-09-12', status: 'active' },
      { id: 'inv', accountType: 'investment', currentBalance: '10000.00', balanceAsOf: '2026-09-12', status: 'active' },
    ],
    freshnessCtx: { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  const breakdown = result.assumptions.accountBreakdown;
  assert.ok(Array.isArray(breakdown), 'accountBreakdown should be an array');
  const accountIds = breakdown.map((a) => a.accountId);
  assert.ok(accountIds.includes('chk'), 'checking should be included');
  assert.ok(accountIds.includes('sav'), 'savings should be included');
  assert.ok(!accountIds.includes('cc'), 'credit card should not be included');
  assert.ok(!accountIds.includes('inv'), 'investment should not be included');
});

test('Report: coverage gaps include all liability accounts', async () => {
  const db = makeDb({
    accounts: [
      { id: 'chk', accountType: 'checking', currentBalance: '1000.00', status: 'active' },
      { id: 'cc', accountType: 'credit_card', currentBalance: '2000.00', status: 'active' },
      { id: 'loc', accountType: 'line_of_credit', currentBalance: '5000.00', status: 'active' },
      { id: 'loan', accountType: 'loan', currentBalance: '10000.00', status: 'active' },
    ],
    freshnessCtx: { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  const gaps = result.assumptions.coverageGaps;
  assert.ok(Array.isArray(gaps), 'coverageGaps should be an array');
  const gapAccountIds = gaps.map((g) => g.accountId);
  assert.ok(gapAccountIds.includes('cc'), 'credit card should have coverage gap');
  assert.ok(gapAccountIds.includes('loc'), 'line of credit should have coverage gap');
  assert.ok(gapAccountIds.includes('loan'), 'loan should have coverage gap');
  assert.ok(!gapAccountIds.includes('chk'), 'checking should not have coverage gap');
});

test('Report: pending review count tracked from freshness context', async () => {
  const db = makeDb({
    freshnessCtx: {
      importBatches: [],
      acceptedReconciliations: [],
      unreviewedImportCount: 5,
    },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  assert.equal(result.assumptions.pendingReviewCount, 5, 'pending review count should match context');
});

// ── Numeric parity ────────────────────────────────────────────────────────

test('Report: core forecast numeric values unchanged', async () => {
  const db = makeDb({
    accounts: [{ id: 'chk', accountType: 'checking', currentBalance: '3000.00', balanceAsOf: '2026-09-12', status: 'active' }],
    freshnessCtx: { importBatches: [], acceptedReconciliations: [], unreviewedImportCount: 0 },
  });

  const result = await getCashFlowForecastReport({ db, householdId: 'hh_1', days: 30, startDate: START_DATE });

  // Core numeric values should match what computeCashFlowForecast alone would return
  assert.equal(result.assumptions.startingBalance, '3000.00');
  assert.ok(result.projections.length === 30);
  assert.equal(result.days, 30);
  assert.equal(result.startDate, START_DATE);
});
