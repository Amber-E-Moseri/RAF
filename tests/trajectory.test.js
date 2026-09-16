import test from 'node:test';
import assert from 'node:assert/strict';

import { GET as getTrajectoryRoute } from '../app/api/v1/reports/trajectory/route.js';
import { buildTrajectoryProjections } from '../lib/trajectory/index.js';
import { getTrajectoryReport } from '../lib/reports/getTrajectoryReport.js';

function createDbDouble({
  household = { id: 'household_1', activeMonth: '2026-03-01', monthlyEssentialsBaseline: '200.00' },
  incomeEntries = [],
  incomeAllocations = [],
  allocationCategories = [],
  transactions = [],
  monthlyReviews = [],
  surplusSplitRules = [],
  debts = [],
  debtPayments = [],
} = {}) {
  const tx = {
    async getHousehold() {
      return household;
    },
    async listIncomeEntries() {
      return incomeEntries;
    },
    async listIncomeAllocations() {
      return incomeAllocations;
    },
    async listAllocationCategories() {
      return allocationCategories;
    },
    async listTransactions() {
      return transactions;
    },
    async listMonthlyReviews() {
      return monthlyReviews;
    },
    async listSurplusSplitRules() {
      return surplusSplitRules;
    },
    async listDebts() {
      return debts;
    },
    async listDebtPayments() {
      return debtPayments;
    },
  };

  return {
    async transaction(callback) {
      return callback(tx);
    },
  };
}

function trajectoryFixture() {
  return {
    household: { id: 'household_1', activeMonth: '2026-03-01', monthlyEssentialsBaseline: '200.00' },
    incomeEntries: [
      { receivedDate: '2026-01-10', amount: '900.00' },
      { receivedDate: '2026-02-10', amount: '1200.00' },
      { receivedDate: '2026-03-10', amount: '900.00' },
    ],
    incomeAllocations: [
      { slug: 'savings', allocatedAmount: '250.00' },
    ],
    allocationCategories: [
      { slug: 'savings', allocationPercent: '0.1000', sortOrder: 1, isActive: true },
      { slug: 'buffer', allocationPercent: '0.9000', sortOrder: 2, isActive: true },
    ],
    transactions: [
      { transactionDate: '2026-01-12', amount: '600.00', direction: 'debit' },
      { transactionDate: '2026-02-12', amount: '700.00', direction: 'debit' },
      { transactionDate: '2026-03-12', amount: '800.00', direction: 'debit' },
    ],
    monthlyReviews: [
      { reviewMonth: '2026-02-01', distributions: { emergency_fund: '100.00' } },
    ],
    surplusSplitRules: [
      { slug: 'emergency_fund', splitPercent: '0.5000', sortOrder: 1, isActive: true },
      { slug: 'investment', splitPercent: '0.5000', sortOrder: 2, isActive: true },
    ],
    debts: [
      { id: 'debt_1', startingBalance: '1000.00', minimumPayment: '50.00', monthlyPayment: '150.00', name: 'Visa' },
    ],
    debtPayments: [
      { debtId: 'debt_1', amount: '100.00', paymentDate: '2026-02-01' },
    ],
  };
}

test('trajectory engine calculates debt payoff timeline, savings growth, and emergency fund coverage', () => {
  const result = buildTrajectoryProjections({
    activeMonth: '2026-03-01',
    months: 2,
    ...trajectoryFixture(),
  });

  assert.deepEqual(result, {
    debtPayoffProjection: [
      {
        debtId: 'debt_1',
        debtName: 'Visa',
        payoffMonth: null,
        timeline: [
          { month: '2026-03-01', projectedBalance: '750.00' },
          { month: '2026-04-01', projectedBalance: '600.00' },
        ],
      },
    ],
    savingsGrowthProjection: [
      { month: '2026-03-01', projectedSavingsBalance: '350.00' },
      { month: '2026-04-01', projectedSavingsBalance: '450.00' },
    ],
    emergencyFundCoverageProjection: [
      { month: '2026-03-01', emergencyFundBalance: '250.00', coverageMonths: 1.25 },
      { month: '2026-04-01', emergencyFundBalance: '400.00', coverageMonths: 2 },
    ],
    assumptions: {
      projectedMonthlyIncome: '1000.00',
      projectedMonthlySpending: '700.00',
      projectedMonthlySurplus: '300.00',
      projectedMonthlySavingsContribution: '100.00',
    },
  });
});

test('trajectory report endpoint returns calculated projections', async () => {
  const db = createDbDouble(trajectoryFixture());

  const result = await getTrajectoryReport({
    db,
    householdId: 'household_1',
    months: 2,
  });

  assert.equal(result.debtPayoffProjection[0].timeline[0].projectedBalance, '750.00');
  assert.equal(result.savingsGrowthProjection[0].projectedSavingsBalance, '350.00');
  assert.equal(result.emergencyFundCoverageProjection[0].coverageMonths, 1.25);
});

test('trajectory route exposes projection payloads', async () => {
  const db = createDbDouble(trajectoryFixture());

  const response = await getTrajectoryRoute(
    new Request('http://localhost/api/v1/reports/trajectory?months=1', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.debtPayoffProjection));
  assert.ok(Array.isArray(payload.savingsGrowthProjection));
  assert.ok(Array.isArray(payload.emergencyFundCoverageProjection));
});
