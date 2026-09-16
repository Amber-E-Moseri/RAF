import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCashFlowForecast } from '../lib/raf/cashFlowForecasting.js';

// ─── Section 1: Pure Function Properties ─────────────────────────────────────

test('1.1 — computeCashFlowForecast is deterministic — same inputs produce same outputs', () => {
  const args = {
    accounts: [
      { id: 'acc1', accountType: 'checking', currentBalance: '1000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 30,
  };
  const first = computeCashFlowForecast(args);
  const second = computeCashFlowForecast(args);
  assert.strictEqual(first.assumptions.startingBalance, second.assumptions.startingBalance, 'Same starting balance');
  assert.strictEqual(first.projections.length, second.projections.length, 'Same projection count');
  assert.strictEqual(first.days, 30, 'days is 30');
});

test('1.2 — computeCashFlowForecast does not mutate its input arrays', () => {
  const accounts = [
    { id: 'acc1', accountType: 'checking', currentBalance: '5000.00', balanceAsOf: '2026-01-01', status: 'active' },
  ];
  const fixedBills = [
    { id: 'b1', name: 'Rent', expectedAmount: '1200.00', dueDayOfMonth: 1, active: true },
  ];
  const accountsBefore = JSON.stringify(accounts);
  const billsBefore = JSON.stringify(fixedBills);

  computeCashFlowForecast({ accounts, fixedBills, startDate: '2026-01-01', days: 30 });

  assert.strictEqual(JSON.stringify(accounts), accountsBefore, 'accounts array not mutated');
  assert.strictEqual(JSON.stringify(fixedBills), billsBefore, 'fixedBills array not mutated');
});

test('1.3 — computeCashFlowForecast returns projections array with one entry per day', () => {
  const result = computeCashFlowForecast({ startDate: '2026-01-01', days: 14 });
  assert.strictEqual(result.projections.length, 14, '14-day forecast has 14 projection entries');
  assert.strictEqual(result.projections[0].date, '2026-01-01', 'First entry is the start date');
  assert.strictEqual(result.projections[13].date, '2026-01-14', 'Last entry is startDate + 13 days');
});

// ─── Section 2: Input Validation ─────────────────────────────────────────────

test('2.1 — computeCashFlowForecast throws when startDate is missing', () => {
  assert.throws(
    () => computeCashFlowForecast({ days: 30 }),
    /startDate/i,
    'Must throw for missing startDate',
  );
});

test('2.2 — computeCashFlowForecast throws when startDate is malformed', () => {
  assert.throws(
    () => computeCashFlowForecast({ startDate: 'January 1, 2026', days: 30 }),
    /startDate/i,
    'Must throw for non-ISO startDate',
  );
});

test('2.3 — computeCashFlowForecast throws when days is 0', () => {
  assert.throws(
    () => computeCashFlowForecast({ startDate: '2026-01-01', days: 0 }),
    /days/i,
    'Must throw for days=0',
  );
});

test('2.4 — computeCashFlowForecast throws when days exceeds 365', () => {
  assert.throws(
    () => computeCashFlowForecast({ startDate: '2026-01-01', days: 366 }),
    /days/i,
    'Must throw for days=366',
  );
});

// ─── Section 3: Account Type Authority — Opening Balance ─────────────────────

test('3.1 — Checking account balance is included in startingBalance', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'acc1', accountType: 'checking', currentBalance: '2000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 1,
  });
  assert.strictEqual(result.assumptions.startingBalance, '2000.00', 'Checking account included in opening balance');
});

test('3.2 — Savings account balance is included in startingBalance', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'acc1', accountType: 'savings', currentBalance: '5000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 1,
  });
  assert.strictEqual(result.assumptions.startingBalance, '5000.00', 'Savings account included in opening balance');
});

test('3.3 — Investment account is EXCLUDED from startingBalance (authority boundary)', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'inv1', accountType: 'investment', currentBalance: '50000.00', balanceAsOf: '2026-01-01', status: 'active' },
      { id: 'chk1', accountType: 'checking', currentBalance: '1000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 1,
  });
  assert.strictEqual(
    result.assumptions.startingBalance,
    '1000.00',
    'INVARIANT BREACH: investment must not inflate starting cash balance',
  );
  assert.strictEqual(
    result.assumptions.investmentAccountsExcluded,
    '50000.00',
    'Investment amount reported separately in assumptions',
  );
});

test('3.4 — Credit card (liability) account is EXCLUDED from startingBalance', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'cc1', accountType: 'credit_card', currentBalance: '3000.00', balanceAsOf: '2026-01-01', status: 'active' },
      { id: 'chk1', accountType: 'checking', currentBalance: '1000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 1,
  });
  assert.strictEqual(
    result.assumptions.startingBalance,
    '1000.00',
    'INVARIANT BREACH: credit card balance must not inflate available cash',
  );
});

test('3.5 — Inactive accounts are excluded from startingBalance', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'acc1', accountType: 'checking', currentBalance: '5000.00', balanceAsOf: '2026-01-01', status: 'closed' },
      { id: 'acc2', accountType: 'checking', currentBalance: '1000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 1,
  });
  assert.strictEqual(result.assumptions.startingBalance, '1000.00', 'Only active account contributes to balance');
});

test('3.6 — Mixed liquid accounts (checking + savings + cash + other) all contribute', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'a1', accountType: 'checking', currentBalance: '1000.00', balanceAsOf: '2026-01-01', status: 'active' },
      { id: 'a2', accountType: 'savings', currentBalance: '2000.00', balanceAsOf: '2026-01-01', status: 'active' },
      { id: 'a3', accountType: 'cash', currentBalance: '100.00', balanceAsOf: '2026-01-01', status: 'active' },
      { id: 'a4', accountType: 'other', currentBalance: '500.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 1,
  });
  assert.strictEqual(result.assumptions.startingBalance, '3600.00', 'All four liquid types sum correctly');
});

// ─── Section 4: Income Projection on 15th of Month ───────────────────────────

test('4.1 — Income is projected on the 15th of each month within the forecast window', () => {
  const incomeEntries = [
    { receivedDate: '2025-10-15', amount: '3000.00' },
    { receivedDate: '2025-11-15', amount: '3000.00' },
    { receivedDate: '2025-12-15', amount: '3000.00' },
  ];
  const result = computeCashFlowForecast({
    incomeEntries,
    startDate: '2026-01-01',
    days: 31,
  });
  const jan15 = result.projections.find((p) => p.date === '2026-01-15');
  assert.ok(jan15, 'Jan 15 projection exists');
  assert.ok(
    jan15.projectedIncome.amount !== '0.00',
    'Income amount is non-zero on Jan 15',
  );
  assert.strictEqual(jan15.projectedIncome.sourceType, 'income', 'Income sourceType is income');
});

test('4.2 — Zero income when no entries — forecast still produces valid projections', () => {
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'acc1', accountType: 'checking', currentBalance: '500.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    startDate: '2026-01-01',
    days: 7,
  });
  assert.strictEqual(result.projections.length, 7, 'Projection has 7 entries');
  assert.strictEqual(result.assumptions.avgMonthlyIncome, '0.00', 'Zero income when no entries');
});

// ─── Section 5: Double-Counting Prevention ────────────────────────────────────

test('5.1 — Category slugs from fixed bills are excluded from variable-spending baseline', () => {
  const fixedBills = [
    { id: 'b1', name: 'Rent', expectedAmount: '1200.00', dueDayOfMonth: 1, active: true, categorySlug: 'housing' },
  ];
  const result = computeCashFlowForecast({
    fixedBills,
    startDate: '2026-01-01',
    days: 30,
  });
  const excludedSlugs = result.assumptions.obligationCategoriesExcluded;
  assert.ok(excludedSlugs.includes('housing'), 'housing slug from fixed bill is excluded from variable baselines');
});

test('5.2 — debt_payment slug always excluded from variable baselines (hardcoded guard)', () => {
  const result = computeCashFlowForecast({
    startDate: '2026-01-01',
    days: 30,
  });
  const excludedSlugs = result.assumptions.obligationCategoriesExcluded;
  assert.ok(
    excludedSlugs.includes('debt_payment') || excludedSlugs.includes('debt_payments'),
    'debt_payment/debt_payments always excluded from variable baselines',
  );
});

// ─── Section 6: Forecast Completeness ─────────────────────────────────────────

test('6.1 — Forecast result contains required top-level fields', () => {
  const result = computeCashFlowForecast({ startDate: '2026-01-01', days: 30 });
  assert.ok(result.forecastPeriod, 'forecastPeriod present');
  assert.ok(result.generatedAt, 'generatedAt present');
  assert.ok(result.startDate, 'startDate present');
  assert.ok(result.endDate, 'endDate present');
  assert.ok(result.assumptions, 'assumptions present');
  assert.ok(Array.isArray(result.projections), 'projections is an array');
  assert.ok(result.summaryMetrics, 'summaryMetrics present');
});

test('6.2 — Fixed bill outflows appear on their due day in projections', () => {
  const fixedBills = [
    { id: 'b1', name: 'Rent', expectedAmount: '1200.00', dueDayOfMonth: 5, active: true },
  ];
  const result = computeCashFlowForecast({
    accounts: [
      { id: 'acc1', accountType: 'checking', currentBalance: '5000.00', balanceAsOf: '2026-01-01', status: 'active' },
    ],
    fixedBills,
    startDate: '2026-01-01',
    days: 10,
  });
  const jan5 = result.projections.find((p) => p.date === '2026-01-05');
  assert.ok(jan5, 'Jan 5 projection exists');
  const rentEvent = (jan5.projectedFixedBills?.bills ?? []).find((b) => b.description === 'Rent');
  assert.ok(rentEvent, 'Rent bill appears in projectedFixedBills.bills on Jan 5');
  assert.strictEqual(rentEvent.direction, 'outflow', 'Rent is an outflow');
});

test('6.3 — Inactive fixed bills are excluded from projections', () => {
  const fixedBills = [
    { id: 'b1', name: 'Inactive Bill', expectedAmount: '200.00', dueDayOfMonth: 5, active: false },
  ];
  const result = computeCashFlowForecast({
    fixedBills,
    startDate: '2026-01-01',
    days: 10,
  });
  const jan5 = result.projections.find((p) => p.date === '2026-01-05');
  const inactiveBillEvents = (jan5?.projectedFixedBills?.bills ?? []).filter((b) => b.description === 'Inactive Bill');
  assert.strictEqual(inactiveBillEvents.length, 0, 'Inactive bills must not appear in projections');
});
