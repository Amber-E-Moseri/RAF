import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchToolCall } from '../lib/remi/toolHandlers.js';
import { REMI_TOOLS } from '../lib/remi/tools.js';

const householdId = 'household_1';

function incrementMonth(month) {
  const value = new Date(`${month}T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 10);
}

function isWithinMonthRange(date, from = '0001-01-01', to = '9999-12-31') {
  return date >= from && date < incrementMonth(to);
}

function createRemiDbDouble() {
  const writes = [];
  const household = {
    id: householdId,
    name: 'Test Household',
    activeMonth: '2026-03-01',
    timezone: 'America/Toronto',
    periodStartDay: 1,
    savingsFloor: '2000.00',
    savingsFloorEnabled: true,
    monthlyEssentialsBaseline: '1800.00',
  };

  const allocationCategories = [
    { id: 'bucket_savings', slug: 'savings', label: 'Savings', isActive: true, sortOrder: 1 },
    { id: 'bucket_spending', slug: 'personal_spending', label: 'Personal Spending', isActive: true, sortOrder: 2 },
    { id: 'bucket_debt', slug: 'debt_payoff', label: 'Debt Payoff', isActive: true, sortOrder: 3 },
  ];

  const incomeEntries = [
    { id: 'income_1', receivedDate: '2026-03-05', amount: '3000.00' },
    { id: 'income_2', receivedDate: '2026-02-05', amount: '3000.00' },
  ];

  const incomeAllocations = [
    { incomeEntryId: 'income_1', receivedDate: '2026-03-05', allocationCategoryId: 'bucket_savings', slug: 'savings', allocatedAmount: '600.00' },
    { incomeEntryId: 'income_1', receivedDate: '2026-03-05', allocationCategoryId: 'bucket_spending', slug: 'personal_spending', allocatedAmount: '1200.00' },
    { incomeEntryId: 'income_1', receivedDate: '2026-03-05', allocationCategoryId: 'bucket_debt', slug: 'debt_payoff', allocatedAmount: '1200.00' },
    { incomeEntryId: 'income_2', receivedDate: '2026-02-05', allocationCategoryId: 'bucket_savings', slug: 'savings', allocatedAmount: '600.00' },
  ];

  const transactions = [
    {
      id: 'txn_1',
      transactionDate: '2026-03-10',
      description: 'Private Store 4111111111111111 receipt line',
      merchant: 'Private Store 4111111111111111',
      amount: '75.25',
      direction: 'debit',
      categoryId: 'bucket_spending',
      categorySlug: 'personal_spending',
    },
    {
      id: 'txn_2',
      transactionDate: '2026-03-11',
      description: 'Private Store 4111111111111111 second receipt line',
      merchant: 'Private Store 4111111111111111',
      amount: '24.75',
      direction: 'debit',
      categoryId: 'bucket_spending',
      categorySlug: 'personal_spending',
    },
    {
      id: 'txn_goal_secret',
      transactionDate: '2026-03-12',
      description: 'Emergency transfer from acct 987654321',
      merchant: 'Bank transfer 987654321',
      amount: '140.00',
      direction: 'debit',
      categoryId: 'bucket_savings',
      categorySlug: 'savings',
      linkedGoalId: 'goal_1',
    },
  ];

  const debts = [
    {
      id: 'debt_1',
      name: 'Visa',
      startingBalance: '2500.00',
      apr: 19.99,
      minimumPayment: '90.00',
      monthlyPayment: '150.00',
      active: true,
    },
  ];

  const goals = [
    {
      id: 'goal_1',
      householdId,
      bucketId: 'bucket_savings',
      name: 'Emergency Fund',
      targetAmount: '2000.00',
      active: true,
    },
  ];

  const tx = {
    async getHousehold() {
      return household;
    },
    async listFinancialAccounts() {
      return [{ id: 'account_1', accountType: 'checking', currentBalance: '2500.00', status: 'active' }];
    },
    async listIncomeEntries({ from = '0001-01-01', to = '9999-12-31' } = {}) {
      return incomeEntries.filter((entry) => isWithinMonthRange(entry.receivedDate, from, to));
    },
    async listIncomeAllocations({ from = '0001-01-01', to = '9999-12-31' } = {}) {
      return incomeAllocations.filter((entry) => isWithinMonthRange(entry.receivedDate, from, to));
    },
    async listTransactions({ from = '0001-01-01', to = '9999-12-31', categoryIds = null } = {}) {
      return transactions.filter((entry) => (
        isWithinMonthRange(entry.transactionDate, from, to)
        && (!categoryIds || categoryIds.includes(entry.categoryId))
      ));
    },
    async listDebtPayments() {
      return [];
    },
    async listDebtAdjustments() {
      return [];
    },
    async listDebts() {
      return debts;
    },
    async listFixedBills() {
      return [{ id: 'bill_1', name: 'Rent', categorySlug: 'fixed_bills', expectedAmount: '1800.00', dueDayOfMonth: 1, active: true }];
    },
    async listUpcomingExpenses() {
      return [];
    },
    async listGoals() {
      return goals;
    },
    async listAllocationCategories() {
      return allocationCategories;
    },
    async listImportedTransactions() {
      return [];
    },
    async insertTransaction(payload) {
      writes.push(['insertTransaction', payload]);
      throw new Error('Remi tool tests must remain read-only');
    },
    async updateTransaction(payload) {
      writes.push(['updateTransaction', payload]);
      throw new Error('Remi tool tests must remain read-only');
    },
    async deleteTransaction(payload) {
      writes.push(['deleteTransaction', payload]);
      throw new Error('Remi tool tests must remain read-only');
    },
  };

  return {
    writes,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

test('Remi paid tool surface is explicit and provider payload tests cover every tool', () => {
  assert.deepEqual(
    REMI_TOOLS.map((tool) => tool.name).sort(),
    [
      'compare_periods',
      'create_scenario',
      'explain_variance',
      'get_available_resources',
      'get_cashflow_forecast',
      'get_current_plan',
      'get_debt_strategy',
      'get_goal_progress',
      'get_transaction_summary',
      'get_upcoming_obligations',
      'propose_allocation_change',
    ].sort(),
  );
});

test('Remi transaction summary aggregates spending and sanitizes merchant digit sequences', async () => {
  const db = createRemiDbDouble();

  const result = await dispatchToolCall({
    name: 'get_transaction_summary',
    input: { from: '2026-03-01', to: '2026-03-31' },
    db,
    householdId,
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.total_spending, '240.00');
  assert.equal(result.transaction_count, 3);
  assert.equal(result.top_merchants.some((row) => (
    row.merchant === 'Private Store ****' && row.total === '100.00'
  )), true);
  assert.doesNotMatch(serialized, /4111111111111111|987654321|receipt line|txn_1/);
});

test('Remi variance explanation returns aggregated sanitized drivers, not raw transaction rows', async () => {
  const db = createRemiDbDouble();

  const result = await dispatchToolCall({
    name: 'explain_variance',
    input: { categorySlug: 'personal_spending', period: '2026-03-01' },
    db,
    householdId,
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.category, 'personal_spending');
  assert.equal(result.transaction_count, 2);
  assert.deepEqual(result.top_transaction_drivers, [{ description: 'Private Store ****', total: '100.00' }]);
  assert.equal(Object.hasOwn(result, 'top_transactions'), false);
  assert.doesNotMatch(serialized, /4111111111111111|receipt line|2026-03-10|txn_1/);
});

test('Remi goal progress exposes progress figures without underlying linked transaction details', async () => {
  const db = createRemiDbDouble();

  const result = await dispatchToolCall({
    name: 'get_goal_progress',
    input: {},
    db,
    householdId,
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.goals[0].name, 'Emergency Fund');
  assert.equal(result.goals[0].current, '140.00');
  assert.equal(result.goals[0].target, '2000.00');
  assert.doesNotMatch(serialized, /txn_goal_secret|987654321|Bank transfer|Emergency transfer/);
});

test('Remi debt strategy is necessarily detailed but still sourced from deterministic debt services', async () => {
  const db = createRemiDbDouble();

  const result = await dispatchToolCall({
    name: 'get_debt_strategy',
    input: {},
    db,
    householdId,
  });

  assert.equal(result.strategy.includes('avalanche'), true);
  assert.equal(result.debts[0].name, 'Visa');
  assert.equal(result.debts[0].apr, 19.99);
  assert.equal(result.debts[0].minimum_payment, '90.00');
});

test('Remi plan, resource, comparison, forecast, and scenario tools stay summarized and read-only', async () => {
  const db = createRemiDbDouble();
  const calls = [
    ['get_current_plan', { period: '2026-03-01' }],
    ['get_available_resources', {}],
    ['get_upcoming_obligations', { days: 30 }],
    ['get_cashflow_forecast', { days: 30 }],
    ['compare_periods', { periodA: '2026-02-01', periodB: '2026-03-01' }],
    ['create_scenario', { description: 'Spend 50 on a purchase', categorySlug: 'personal_spending', amountDelta: '50.00' }],
    ['propose_allocation_change', { action: 'add_to_goal', targetId: 'goal_1', amount: '50.00', rationale: 'Extra margin' }],
  ];

  for (const [name, input] of calls) {
    const result = await dispatchToolCall({ name, input, db, householdId });
    const serialized = JSON.stringify(result);
    assert.equal(result.error, undefined, `${name} returned ${result.error}`);
    assert.doesNotMatch(serialized, /4111111111111111|987654321|receipt line|txn_1|txn_goal_secret/);
  }

  assert.deepEqual(db.writes, []);
});

// ── R4: Lock-in tests for correct-behavior tools ──────────────────────────────
//
// These tests assert the current correct behavior so a future change cannot
// silently regress it. They cover:
//
//   1. The architectural split: financialContext.js (buildFinancialContext) is
//      the minimization layer for the SUMMARY route only. The tool loop in
//      remiAssistant.js does NOT call buildFinancialContext — each handler owns
//      its own mapping. This means minimization for the tool loop is enforced
//      per-handler, not by a shared context builder.
//
//   2. compare_periods does not reconstruct individual transaction rows: it
//      returns only per-bucket aggregated deltas, never transaction-level data.
//
//   3. create_scenario is read-only: no database write methods are invoked.
//
//   4. get_goal_progress returns only progress figures, consistent with Part 1's
//      finding that the goal-progress mechanism reads linkedGoalId from
//      transactions but the tool handler projects only aggregated amounts.

import { buildFinancialContext } from '../lib/remi/financialContext.js';

test('R4: financialContext.buildFinancialContext is a separate code path from the tool loop', async () => {
  // buildFinancialContext calls tx.listGoals and returns a summarized context
  // object. The tool loop dispatchers (in toolHandlers.js) never import or call
  // buildFinancialContext — they call getDashboardReport or domain functions
  // directly. This test confirms the function is importable and produces the
  // expected sanitized shape, locking in that its outputs (not the raw DB rows)
  // are what the summary route hands to the model.
  const db = {
    async transaction(callback) {
      return callback({
        async getHousehold() { return { name: 'Test Household' }; },
        async listTransactions() {
          return [
            { amount: '-75.25', direction: 'debit', merchant: 'Private Store 4111111111111111', transactionDate: '2026-03-10' },
          ];
        },
        async listIncomeEntries() { return [{ amount: '3000.00', receivedDate: '2026-03-05' }]; },
        async listDebts() {
          return [{
            id: 'debt_r4', name: 'Visa', startingBalance: '2500.00',
            minimumPayment: '90.00', monthlyPayment: '150.00', apr: 19.99, isActive: true,
          }];
        },
        async listDebtPayments() { return []; },
        async listDebtAdjustments() { return []; },
        async listGoals() {
          return [{ id: 'goal_1', name: 'Emergency Fund', targetAmount: '2000.00' }];
        },
        async listMonthlyReviews() { return []; },
      });
    },
  };

  const ctx = await buildFinancialContext({ db, householdId, months: 1 });

  // Summarized shape — not raw DB rows.
  assert.ok(typeof ctx.income.totalForPeriod === 'string');
  assert.ok(typeof ctx.spending.totalForPeriod === 'string');
  assert.ok(Array.isArray(ctx.goals));
  assert.ok(Array.isArray(ctx.debts));

  // Goals appear as {name, target, current, percentComplete} — no linkedGoalId,
  // no transaction IDs, no bucket IDs.
  const goal = ctx.goals[0];
  assert.ok(Object.hasOwn(goal, 'name'));
  assert.ok(Object.hasOwn(goal, 'target'));
  assert.ok(Object.hasOwn(goal, 'current'));
  assert.ok(Object.hasOwn(goal, 'percentComplete'));
  assert.equal(Object.hasOwn(goal, 'linkedGoalId'), false);
  assert.equal(Object.hasOwn(goal, 'bucketId'), false);

  // Merchant digit sequences are sanitized.
  const serialized = JSON.stringify(ctx);
  assert.doesNotMatch(serialized, /4111111111111111|987654321/);
});

test('R4: compare_periods returns per-bucket aggregated deltas, never individual transaction rows', async () => {
  const db = createRemiDbDouble();

  const result = await dispatchToolCall({
    name: 'compare_periods',
    input: { periodA: '2026-02-01', periodB: '2026-03-01' },
    db,
    householdId,
  });

  assert.equal(result.error, undefined);

  // Result shape: top-level summaries + per-bucket deltas.
  assert.ok(typeof result.income.period_a === 'string');
  assert.ok(typeof result.income.period_b === 'string');
  assert.ok(Array.isArray(result.buckets));

  for (const bucket of result.buckets) {
    assert.ok(typeof bucket.slug === 'string');
    assert.ok(typeof bucket.period_a_used === 'string');
    assert.ok(typeof bucket.period_b_used === 'string');
    // No transaction-level fields should appear.
    assert.equal(Object.hasOwn(bucket, 'transactions'), false);
    assert.equal(Object.hasOwn(bucket, 'items'), false);
  }

  // No raw transaction data in the serialized result.
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /4111111111111111|987654321|txn_1|txn_goal_secret|receipt line/);
});

test('R4: create_scenario is enforced read-only at the handler level — no DB writes occur', async () => {
  const db = createRemiDbDouble();

  await dispatchToolCall({
    name: 'create_scenario',
    input: {
      description: 'Buy a coffee machine',
      categorySlug: 'personal_spending',
      amountDelta: '80.00',
    },
    db,
    householdId,
  });

  assert.deepEqual(db.writes, [], 'create_scenario must not invoke any write method');
});

test('R4: get_goal_progress exposes only aggregated progress — linked transaction details stay internal', async () => {
  // This locks in the Part 1 finding: goal progress is computed from
  // transactions.linkedGoalId inside the report engine, but the tool handler
  // projects only {id, name, current, target, remaining, progress_percent, bucket}.
  // The underlying transaction that was linked (txn_goal_secret / $140) must
  // not appear in the payload the model receives.
  const db = createRemiDbDouble();

  const result = await dispatchToolCall({
    name: 'get_goal_progress',
    input: {},
    db,
    householdId,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.goals[0].current, '140.00');

  // Projection must include only progress-level fields.
  const goal = result.goals[0];
  assert.ok(Object.hasOwn(goal, 'id'));
  assert.ok(Object.hasOwn(goal, 'name'));
  assert.ok(Object.hasOwn(goal, 'current'));
  assert.ok(Object.hasOwn(goal, 'target'));
  assert.ok(Object.hasOwn(goal, 'remaining'));
  assert.ok(Object.hasOwn(goal, 'progress_percent'));
  assert.ok(Object.hasOwn(goal, 'bucket'));

  // Must NOT expose the transaction that funded the progress.
  assert.equal(Object.hasOwn(goal, 'transactions'), false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /txn_goal_secret|987654321|Bank transfer|Emergency transfer/);
});
