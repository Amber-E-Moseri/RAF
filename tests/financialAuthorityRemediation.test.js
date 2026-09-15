// Consumer financial authority remediation tests.
// Verifies that Remi and forecast consumers route through canonical authority sources
// rather than reconstructing their own financial truth from raw DB rows.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRemiSpendingContext,
  buildRemiGoalContext,
  buildRemiDebtContext,
  buildFinancialContext,
} from '../lib/remi/financialContext.js';
import { computeCashFlowForecast } from '../lib/raf/cashFlowForecasting.js';
import { resolveDebtBalanceAuthority } from '../lib/debts/debtBalanceAuthority.js';

// ── P1: Remi Spending Authority ──────────────────────────────────────────────

test('P1: debit-direction transactions are classified as spending', () => {
  const txns = [
    { amount: '50.00', direction: 'debit', merchant: 'Coffee Shop' },
    { amount: '100.00', direction: 'credit', merchant: 'Employer' },
  ];
  const ctx = buildRemiSpendingContext(txns, 1);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.totalForPeriod, '50.00');
});

test('P1: credit-direction transaction is not spending even if amount is negative', () => {
  // A reversed charge: amount could be negative in some representations.
  const txns = [{ amount: '-25.00', direction: 'credit', merchant: 'Refund' }];
  const ctx = buildRemiSpendingContext(txns, 1);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.totalForPeriod, '0.00');
});

test('P1: amount sign cannot override canonical direction — positive amount debit is spending', () => {
  const txns = [{ amount: '75.00', direction: 'debit', merchant: 'Grocery' }];
  const ctx = buildRemiSpendingContext(txns, 1);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.totalForPeriod, '75.00');
});

test('P1: transaction without direction field is not counted as spending', () => {
  const txns = [{ amount: '-50.00', merchant: 'Unknown' }];
  const ctx = buildRemiSpendingContext(txns, 1);
  assert.equal(ctx.transactionCount, 0);
});

test('P1: mixed direction set — only debits contribute to spending totals', () => {
  const txns = [
    { amount: '30.00', direction: 'debit', merchant: 'Gas' },
    { amount: '1000.00', direction: 'credit', merchant: 'Salary' },
    { amount: '20.00', direction: 'debit', merchant: 'Bus' },
  ];
  const ctx = buildRemiSpendingContext(txns, 1);
  assert.equal(ctx.transactionCount, 2);
  assert.equal(ctx.totalForPeriod, '50.00');
});

// ── P2: Remi Goal Authority ──────────────────────────────────────────────────

test('P2: goal progress uses qualifying linked transactions, not goal.currentAmount', () => {
  const goals = [{ id: 'g1', name: 'Vacation', targetAmount: '1000.00' }];
  const contributionMap = new Map([['g1', 40000]]); // 400.00 in cents
  const [result] = buildRemiGoalContext(goals, contributionMap);
  assert.equal(result.current, '400.00');
  assert.equal(result.percentComplete, 40);
});

test('P2: goal.currentAmount on the raw row has no effect on Remi goal context', () => {
  const goals = [{ id: 'g1', name: 'Car', targetAmount: '5000.00', currentAmount: 9999 }];
  const contributionMap = new Map([['g1', 100000]]); // 1000.00
  const [result] = buildRemiGoalContext(goals, contributionMap);
  assert.equal(result.current, '1000.00');
  assert.equal(result.percentComplete, 20);
});

test('P2: goal with no linked transactions shows zero progress', () => {
  const goals = [{ id: 'g2', name: 'Emergency', targetAmount: '500.00' }];
  const contributionMap = new Map(); // no entry for g2
  const [result] = buildRemiGoalContext(goals, contributionMap);
  assert.equal(result.current, '0.00');
  assert.equal(result.percentComplete, 0);
});

test('P2: unrelated transactions do not contribute to a goal', () => {
  const goals = [{ id: 'g3', name: 'Laptop', targetAmount: '2000.00' }];
  // No mapping for g3 — contributions must come from the map, not be computed here
  const contributionMap = new Map([['other_goal', 99999]]);
  const [result] = buildRemiGoalContext(goals, contributionMap);
  assert.equal(result.current, '0.00');
});

test('P2: no financial row is mutated by buildRemiGoalContext', () => {
  const goals = [{ id: 'g4', name: 'Funds', targetAmount: '100.00', currentAmount: 0 }];
  const frozen = Object.freeze({ ...goals[0] });
  const contributionMap = new Map([['g4', 5000]]);
  assert.doesNotThrow(() => buildRemiGoalContext([frozen], contributionMap));
});

// ── P3: Remi Debt Authority ──────────────────────────────────────────────────

test('P3: manual debt snapshot has source manual_derived in Remi context', () => {
  const snapshots = [{
    name: 'Student Loan',
    currentBalance: '8500.00',
    balanceAuthority: { source: 'manual_derived', balance: null, asOf: null, financialAccountId: null },
    minimumPayment: '150.00',
    apr: 5.5,
  }];
  const [result] = buildRemiDebtContext(snapshots);
  assert.equal(result.balanceSource, 'manual_derived');
  assert.equal(result.balance, '8500.00');
  assert.equal(result.balanceAsOf, null);
});

test('P3: account-backed debt snapshot exposes financial_account source', () => {
  const snapshots = [{
    name: 'Chase Visa',
    currentBalance: '3200.00',
    balanceAuthority: {
      source: 'financial_account',
      balance: '3200.00',
      asOf: '2026-09-12',
      financialAccountId: 'acct_cc',
    },
    minimumPayment: '95.00',
    apr: 19.99,
  }];
  const [result] = buildRemiDebtContext(snapshots);
  assert.equal(result.balanceSource, 'financial_account');
  assert.equal(result.balance, '3200.00');
  assert.equal(result.balanceAsOf, '2026-09-12');
});

test('P3: account-backed debt uses account balance, not stale manual-derived balance', () => {
  // Account says 3100, ledger would say 3500 (stale). resolveDebtBalanceAuthority picks account.
  const account = { id: 'acct_1', currentBalance: '3100.00', balance_as_of: '2026-09-13' };
  const debt = { financialAccountId: 'acct_1', startingBalance: '5000.00' };
  const authority = resolveDebtBalanceAuthority({ debt, financialAccount: account });
  assert.equal(authority.source, 'financial_account');
  assert.equal(authority.balance, '3100.00');
});

test('P3: linked debt with missing financial account throws — never silently falls back', () => {
  const debt = { financialAccountId: 'acct_missing' };
  assert.throws(
    () => resolveDebtBalanceAuthority({ debt, financialAccount: null }),
    /linked debt requires a financial account/,
  );
});

test('P3: buildFinancialContext resolves debts through canonical path', async () => {
  const db = {
    async transaction(cb) {
      return cb({
        async getHousehold() { return { name: 'Test', activeMonth: '2026-09-01' }; },
        async listTransactions() { return []; },
        async listIncomeEntries() { return []; },
        async listDebts() {
          return [{
            id: 'debt_1', name: 'Car', startingBalance: '10000.00',
            minimumPayment: '200.00', monthlyPayment: '300.00', apr: 6.5, isActive: true,
          }];
        },
        async listDebtPayments() { return []; },
        async listDebtAdjustments() { return []; },
        async listGoals() { return []; },
        async listMonthlyReviews() { return []; },
      });
    },
  };
  const ctx = await buildFinancialContext({ db, householdId: 'hh1', months: 1 });
  assert.ok(Array.isArray(ctx.debts));
  const [debt] = ctx.debts;
  assert.ok(debt.balance, 'debt has balance');
  assert.equal(debt.balanceSource, 'manual_derived');
});

test('P3: buildFinancialContext with account-backed debt resolves account balance', async () => {
  const db = {
    async transaction(cb) {
      return cb({
        async getHousehold() { return { name: 'Test', activeMonth: '2026-09-01' }; },
        async listTransactions() { return []; },
        async listIncomeEntries() { return []; },
        async listDebts() {
          return [{
            id: 'debt_linked', name: 'AMEX', startingBalance: '4000.00',
            minimumPayment: '100.00', monthlyPayment: '200.00', apr: 24.99, isActive: true,
            financialAccountId: 'acct_amex',
          }];
        },
        async listDebtPayments() { return []; },
        async listDebtAdjustments() { return []; },
        async listGoals() { return []; },
        async listMonthlyReviews() { return []; },
        async getFinancialAccountById({ accountId }) {
          if (accountId === 'acct_amex') {
            return { id: 'acct_amex', currentBalance: '3750.00', balance_as_of: '2026-09-13', account_type: 'credit_card' };
          }
          return null;
        },
      });
    },
  };
  const ctx = await buildFinancialContext({ db, householdId: 'hh1', months: 1 });
  const [debt] = ctx.debts;
  assert.equal(debt.balanceSource, 'financial_account');
  assert.equal(debt.balance, '3750.00');
  assert.equal(debt.balanceAsOf, '2026-09-13');
});

test('P3: no account/debt/payment/adjustment is mutated by buildFinancialContext', async () => {
  const debtRow = Object.freeze({
    id: 'debt_frozen', name: 'Loan', startingBalance: '1000.00',
    minimumPayment: '50.00', monthlyPayment: '100.00', apr: 8.0, isActive: true,
  });
  const db = {
    async transaction(cb) {
      return cb({
        async getHousehold() { return { name: 'X' }; },
        async listTransactions() { return []; },
        async listIncomeEntries() { return []; },
        async listDebts() { return [debtRow]; },
        async listDebtPayments() { return []; },
        async listDebtAdjustments() { return []; },
        async listGoals() { return []; },
        async listMonthlyReviews() { return []; },
      });
    },
  };
  await assert.doesNotReject(buildFinancialContext({ db, householdId: 'hh1', months: 1 }));
});

// ── P4: Forecast Provenance ──────────────────────────────────────────────────

function makeForecastInputs(accounts = []) {
  return {
    startDate: '2026-09-15',
    days: 30,
    accounts,
    fixedBills: [],
    incomeEntries: [],
    transactions: [],
    upcomingExpenses: [],
    allocationCategories: [],
    debts: [],
    household: {},
  };
}

test('P4: assumptions.accountBalanceAsOf is oldest known as-of date across liquid accounts', () => {
  const accounts = [
    { id: 'a1', account_type: 'checking', current_balance: '1000.00', balance_as_of: '2026-09-10', status: 'active' },
    { id: 'a2', account_type: 'savings', current_balance: '500.00', balance_as_of: '2026-09-08', status: 'active' },
  ];
  const result = computeCashFlowForecast(makeForecastInputs(accounts));
  assert.equal(result.assumptions.accountBalanceAsOf, '2026-09-08');
});

test('P4: assumptions.accountBalanceAsOf is null when no liquid account has a known date', () => {
  const accounts = [
    { id: 'a1', account_type: 'checking', current_balance: '1000.00', status: 'active' },
  ];
  const result = computeCashFlowForecast(makeForecastInputs(accounts));
  assert.equal(result.assumptions.accountBalanceAsOf, null);
  assert.equal(result.assumptions.daysSinceOldestBalance, null);
});

test('P4: assumptions.accountBreakdown contains only liquid accounts', () => {
  const accounts = [
    { id: 'liq', account_type: 'checking', current_balance: '800.00', balance_as_of: '2026-09-10', status: 'active' },
    { id: 'inv', account_type: 'investment', current_balance: '50000.00', balance_as_of: '2026-09-01', status: 'active' },
    { id: 'cc', account_type: 'credit_card', current_balance: '1200.00', balance_as_of: '2026-09-10', status: 'active' },
  ];
  const result = computeCashFlowForecast(makeForecastInputs(accounts));
  const ids = result.assumptions.accountBreakdown.map((a) => a.accountId);
  assert.ok(ids.includes('liq'));
  assert.ok(!ids.includes('inv'), 'investment excluded from breakdown');
  assert.ok(!ids.includes('cc'), 'credit_card excluded from breakdown');
});

test('P4: no freshness label (stalenessWarning) is added — factual provenance only', () => {
  const accounts = [
    { id: 'a1', account_type: 'checking', current_balance: '500.00', balance_as_of: '2026-08-01', status: 'active' },
  ];
  const result = computeCashFlowForecast(makeForecastInputs(accounts));
  assert.equal(Object.hasOwn(result.assumptions, 'stalenessWarning'), false,
    'stalenessWarning must not be added (deferred product threshold)');
});

test('P4: starting balance is numerically unchanged by provenance additions', () => {
  const accounts = [
    { id: 'a1', account_type: 'checking', current_balance: '1200.00', balance_as_of: '2026-09-12', status: 'active' },
    { id: 'a2', account_type: 'savings', current_balance: '800.00', balance_as_of: '2026-09-12', status: 'active' },
  ];
  const result = computeCashFlowForecast(makeForecastInputs(accounts));
  assert.equal(result.assumptions.startingBalance, '2000.00');
  assert.equal(result.assumptions.liquidCashBalance, '1200.00');
  assert.equal(result.assumptions.savingsAccountBalance, '800.00');
});

test('P4: daysSinceOldestBalance reflects days from oldest as-of to forecast start', () => {
  const accounts = [
    { id: 'a1', account_type: 'checking', current_balance: '1000.00', balance_as_of: '2026-09-08', status: 'active' },
  ];
  const result = computeCashFlowForecast({ ...makeForecastInputs(accounts), startDate: '2026-09-15' });
  assert.equal(result.assumptions.daysSinceOldestBalance, 7);
});

// ── Financial Non-Mutation Audit ─────────────────────────────────────────────

test('NON_MUTATION: buildRemiSpendingContext does not mutate transaction array', () => {
  const txns = [{ amount: '50.00', direction: 'debit', merchant: 'Shop' }];
  const frozen = txns.map((t) => Object.freeze({ ...t }));
  assert.doesNotThrow(() => buildRemiSpendingContext(frozen, 1));
});

test('NON_MUTATION: buildRemiDebtContext does not mutate snapshot array', () => {
  const snapshots = [Object.freeze({
    name: 'Loan',
    currentBalance: '500.00',
    balanceAuthority: Object.freeze({ source: 'manual_derived', balance: null, asOf: null, financialAccountId: null }),
    minimumPayment: '25.00',
    apr: 5.0,
  })];
  assert.doesNotThrow(() => buildRemiDebtContext(snapshots));
});
