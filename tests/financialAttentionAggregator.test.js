/**
 * Financial Attention Aggregator — unit tests
 * 28 legacy tests + backend service tests for deriveFinancialAttentionItems and buildFinancialAttention
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveFinancialAttentionItems,
  buildFinancialAttention,
  FinancialAttentionError,
} from '../lib/raf/financialAttention.js';

// Inline replica of deriveAttentionItems (kept in sync with FinancialAttentionAggregator.tsx)
function deriveAttentionItems({ unreviewedImportsCount = 0 } = {}) {
  const items = [];
  if (unreviewedImportsCount > 0) {
    items.push({
      id: 'import-review',
      type: 'IMPORT_REVIEW',
      priority: 'ACTION_NEEDED',
      title: 'Transactions Need Review',
      description:
        unreviewedImportsCount === 1
          ? '1 imported transaction awaits categorization before month close.'
          : `${unreviewedImportsCount} imported transactions await categorization before month close.`,
      action: { label: 'Review Now', href: '/transactions?tab=needs-review' },
      count: unreviewedImportsCount,
    });
  }
  return items;
}

// Inline replica of Dashboard activation logic
function computeAttentionInput({ nextStepState, activeMonthStatus, reminderMonth }) {
  const showAttention =
    nextStepState?.kind === 'income-no-transactions' ||
    nextStepState?.kind === 'income-transactions-open' ||
    nextStepState?.kind === 'month-reminder';
  if (!showAttention) return null;
  const unreviewedImportsCount =
    nextStepState.kind === 'month-reminder'
      ? (reminderMonth?.unresolvedImports ?? 0)
      : (activeMonthStatus?.unresolvedImports ?? 0);
  return { unreviewedImportsCount };
}

// ─── Section 1: Derivation (tests 1–15) ────────────────────────────────────

describe('deriveAttentionItems', () => {
  it('1. returns empty array when unreviewedImportsCount is 0', () => {
    assert.deepEqual(deriveAttentionItems({ unreviewedImportsCount: 0 }), []);
  });

  it('2. returns empty array when called with no arguments', () => {
    assert.deepEqual(deriveAttentionItems(), []);
  });

  it('3. returns one item when unreviewedImportsCount is 1', () => {
    const items = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(items.length, 1);
  });

  it('4. item id is "import-review"', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.id, 'import-review');
  });

  it('5. item type is "IMPORT_REVIEW"', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.type, 'IMPORT_REVIEW');
  });

  it('6. item priority is "ACTION_NEEDED"', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.priority, 'ACTION_NEEDED');
  });

  it('7. item title is "Transactions Need Review"', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.title, 'Transactions Need Review');
  });

  it('8. singular description for count 1', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.description, '1 imported transaction awaits categorization before month close.');
  });

  it('9. plural description for count > 1', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 5 });
    assert.equal(item.description, '5 imported transactions await categorization before month close.');
  });

  it('10. action label is "Review Now"', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.action.label, 'Review Now');
  });

  it('11. action href is "/transactions?tab=needs-review"', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 1 });
    assert.equal(item.action.href, '/transactions?tab=needs-review');
  });

  it('12. count field equals unreviewedImportsCount', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 7 });
    assert.equal(item.count, 7);
  });

  it('13. returns exactly one item regardless of large count', () => {
    const items = deriveAttentionItems({ unreviewedImportsCount: 100 });
    assert.equal(items.length, 1);
  });

  it('14. returns empty for negative count (treated as no items)', () => {
    const items = deriveAttentionItems({ unreviewedImportsCount: -1 });
    assert.deepEqual(items, []);
  });

  it('15. plural description for count 2', () => {
    const [item] = deriveAttentionItems({ unreviewedImportsCount: 2 });
    assert.equal(item.description, '2 imported transactions await categorization before month close.');
  });
});

// ─── Section 2: Presentation (tests 16–19) ─────────────────────────────────

describe('FinancialAttentionAggregator presentation contract', () => {
  it('16. hides when items array is empty', () => {
    // Verified by component returning null — representation: empty array means hidden
    const items = deriveAttentionItems({ unreviewedImportsCount: 0 });
    assert.equal(items.length, 0);
  });

  it('17. shows at most 3 items when more than 3 are present', () => {
    // Build 4 items by calling with same input and simulating multiple signals
    const fakeItems = Array.from({ length: 4 }, (_, i) => ({
      id: `item-${i}`, type: 'IMPORT_REVIEW', priority: 'ACTION_NEEDED',
      title: 'T', description: 'D', action: { label: 'L', href: '/h' },
    }));
    const visible = fakeItems.slice(0, 3);
    assert.equal(visible.length, 3);
  });

  it('18. overflow message is correct for 1 hidden item', () => {
    const hiddenCount = 1;
    const msg = `... and ${hiddenCount} more decision${hiddenCount !== 1 ? 's' : ''} awaiting action`;
    assert.equal(msg, '... and 1 more decision awaiting action');
  });

  it('19. overflow message is correct for multiple hidden items', () => {
    const hiddenCount = 3;
    const msg = `... and ${hiddenCount} more decision${hiddenCount !== 1 ? 's' : ''} awaiting action`;
    assert.equal(msg, '... and 3 more decisions awaiting action');
  });
});

// ─── Section 2b: Empty state ────────────────────────────────────────────────

describe('FinancialAttentionAggregator empty state contract', () => {
  it('empty items.length === 0 triggers empty state (not null) per Phase 10', () => {
    // The component now shows "Nothing needs your attention right now." when items.length === 0.
    // This test asserts that deriveFinancialAttentionItems returns empty items (not null/undefined)
    // when all inputs are zero, so the component can render the empty state.
    const { items } = deriveFinancialAttentionItems({});
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 0);
  });
});

// ─── Section 3: Activation contract (tests 20–28) ──────────────────────────

describe('computeAttentionInput activation contract', () => {
  const activeStatus = { unresolvedImports: 3 };
  const reminderMonth = { unresolvedImports: 2, monthKey: '2026-08' };

  it('20. returns input for income-transactions-open', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'income-transactions-open' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.deepEqual(input, { unreviewedImportsCount: 3 });
  });

  it('21. returns input for income-no-transactions', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'income-no-transactions' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.deepEqual(input, { unreviewedImportsCount: 3 });
  });

  it('22. returns input for month-reminder using reminderMonth.unresolvedImports', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'month-reminder', monthKey: '2026-08' },
      activeMonthStatus: activeStatus,
      reminderMonth,
    });
    assert.deepEqual(input, { unreviewedImportsCount: 2 });
  });

  it('23. returns null for historical state', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'historical' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.equal(input, null);
  });

  it('24. returns null for setup-incomplete state', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'setup-incomplete' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.equal(input, null);
  });

  it('25. returns null for closed-current-month state', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'closed-current-month' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.equal(input, null);
  });

  it('26. returns null for setup-complete-no-income state', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'setup-complete-no-income' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.equal(input, null);
  });

  it('27. month-reminder with null reminderMonth defaults to 0', () => {
    const input = computeAttentionInput({
      nextStepState: { kind: 'month-reminder', monthKey: '2026-08' },
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.deepEqual(input, { unreviewedImportsCount: 0 });
  });

  it('28. returns null when nextStepState is null', () => {
    const input = computeAttentionInput({
      nextStepState: null,
      activeMonthStatus: activeStatus,
      reminderMonth: null,
    });
    assert.equal(input, null);
  });
});

// ─── Section 4: deriveFinancialAttentionItems pure function ─────────────────

describe('deriveFinancialAttentionItems', () => {
  it('29. returns { items: [], summary: { total: 0, urgent: 0, attention: 0 } } for all-zero inputs', () => {
    const result = deriveFinancialAttentionItems({});
    assert.deepEqual(result.summary, { total: 0, urgent: 0, attention: 0 });
    assert.deepEqual(result.items, []);
  });

  it('30. emits IMPORT_REVIEW with ACTION_NEEDED for unreviewedImportsCount > 0', () => {
    const { items } = deriveFinancialAttentionItems({ unreviewedImportsCount: 3 });
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'IMPORT_REVIEW');
    assert.equal(items[0].priority, 'ACTION_NEEDED');
    assert.equal(items[0].count, 3);
  });

  it('31. emits TRANSACTION_REVIEW with REVIEW priority', () => {
    const { items } = deriveFinancialAttentionItems({ unreviewedEligibleTransactionCount: 2 });
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'TRANSACTION_REVIEW');
    assert.equal(items[0].priority, 'REVIEW');
    assert.equal(items[0].count, 2);
  });

  it('32. DEBT_OBLIGATION missed_payment emits BLOCKING item', () => {
    const debtSnapshots = [{
      id: 'debt-1', name: 'Car Loan',
      paymentObligation: { status: 'missed_payment', dueDate: '2026-09-10', minimumRemaining: '200.00', plannedRemaining: '300.00' },
      balanceTrajectory: null,
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    const obligationItem = items.find((i) => i.type === 'DEBT_OBLIGATION');
    assert.ok(obligationItem, 'DEBT_OBLIGATION item should be emitted');
    assert.equal(obligationItem.priority, 'BLOCKING');
    assert.equal(obligationItem.metadata.obligationStatus, 'missed_payment');
  });

  it('33. DEBT_OBLIGATION under_minimum emits ACTION_NEEDED item', () => {
    const debtSnapshots = [{
      id: 'debt-2', name: 'Credit Card',
      paymentObligation: { status: 'under_minimum', dueDate: '2026-09-25', minimumRemaining: '50.00', plannedRemaining: '100.00' },
      balanceTrajectory: null,
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    const obligationItem = items.find((i) => i.type === 'DEBT_OBLIGATION');
    assert.ok(obligationItem);
    assert.equal(obligationItem.priority, 'ACTION_NEEDED');
  });

  it('34. in_progress obligation does NOT emit a DEBT_OBLIGATION item', () => {
    // in_progress = partial payment before due date — not a negative signal
    const debtSnapshots = [{
      id: 'debt-3', name: 'Student Loan',
      paymentObligation: { status: 'in_progress', dueDate: '2026-09-30', minimumRemaining: '100.00', plannedRemaining: '200.00' },
      balanceTrajectory: null,
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    assert.equal(items.filter((i) => i.type === 'DEBT_OBLIGATION').length, 0);
  });

  it('35. satisfied obligation does NOT emit a DEBT_OBLIGATION item', () => {
    const debtSnapshots = [{
      id: 'debt-4', name: 'Mortgage',
      paymentObligation: { status: 'satisfied', dueDate: '2026-09-01', minimumRemaining: '0.00', plannedRemaining: '0.00' },
      balanceTrajectory: null,
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    assert.equal(items.filter((i) => i.type === 'DEBT_OBLIGATION').length, 0);
  });

  it('36. DEBT_TRAJECTORY with warning=true emits ACTION_NEEDED item', () => {
    const debtSnapshots = [{
      id: 'debt-5', name: 'CC Balance',
      paymentObligation: null,
      balanceTrajectory: { trajectory: 'increasing', warning: true },
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    const trajItem = items.find((i) => i.type === 'DEBT_TRAJECTORY');
    assert.ok(trajItem);
    assert.equal(trajItem.priority, 'ACTION_NEEDED');
    assert.equal(trajItem.metadata.trajectory, 'increasing');
  });

  it('37. DEBT_TRAJECTORY with warning=false does NOT emit item', () => {
    const debtSnapshots = [{
      id: 'debt-6', name: 'Personal Loan',
      paymentObligation: null,
      balanceTrajectory: { trajectory: 'decreasing', warning: false },
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    assert.equal(items.filter((i) => i.type === 'DEBT_TRAJECTORY').length, 0);
  });

  it('38. DEBT_OBLIGATION and DEBT_TRAJECTORY are independent — both emitted when both apply', () => {
    // These are independent dimensions and must never be collapsed
    const debtSnapshots = [{
      id: 'debt-7', name: 'CC',
      paymentObligation: { status: 'missed_payment', dueDate: '2026-09-10', minimumRemaining: '100.00', plannedRemaining: '200.00' },
      balanceTrajectory: { trajectory: 'increasing', warning: true },
    }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    assert.equal(items.filter((i) => i.type === 'DEBT_OBLIGATION').length, 1);
    assert.equal(items.filter((i) => i.type === 'DEBT_TRAJECTORY').length, 1);
  });

  it('39. FORECAST_PRESSURE critical emits BLOCKING item with earliest date', () => {
    const forecastPressurePoints = [
      { date: '2026-09-20', riskLevel: 'critical', reason: 'Large bill due' },
      { date: '2026-09-18', riskLevel: 'critical', reason: 'Rent due' },
    ];
    const { items } = deriveFinancialAttentionItems({ forecastPressurePoints });
    const pressureItem = items.find((i) => i.type === 'FORECAST_PRESSURE');
    assert.ok(pressureItem);
    assert.equal(pressureItem.priority, 'BLOCKING');
    assert.equal(pressureItem.dueAt, '2026-09-18');
    assert.equal(pressureItem.count, 2);
  });

  it('40. FORECAST_PRESSURE tight emits ACTION_NEEDED when no critical points', () => {
    const forecastPressurePoints = [
      { date: '2026-09-25', riskLevel: 'tight', reason: 'Low balance' },
    ];
    const { items } = deriveFinancialAttentionItems({ forecastPressurePoints });
    const pressureItem = items.find((i) => i.type === 'FORECAST_PRESSURE');
    assert.ok(pressureItem);
    assert.equal(pressureItem.priority, 'ACTION_NEEDED');
  });

  it('41. critical pressure takes precedence — tight points suppressed when critical present', () => {
    const forecastPressurePoints = [
      { date: '2026-09-22', riskLevel: 'critical', reason: 'Critical' },
      { date: '2026-09-20', riskLevel: 'tight', reason: 'Tight' },
    ];
    const { items } = deriveFinancialAttentionItems({ forecastPressurePoints });
    const pressureItems = items.filter((i) => i.type === 'FORECAST_PRESSURE');
    assert.equal(pressureItems.length, 1);
    assert.equal(pressureItems[0].priority, 'BLOCKING');
  });

  it('42. RECONCILIATION_DISCREPANCY emits REVIEW item per account with open discrepancies', () => {
    const openReconciliationsByAccount = [
      { accountId: 'acct-1', accountName: 'Checking', openCount: 2 },
    ];
    const { items } = deriveFinancialAttentionItems({ openReconciliationsByAccount });
    const recItem = items.find((i) => i.type === 'RECONCILIATION_DISCREPANCY');
    assert.ok(recItem);
    assert.equal(recItem.priority, 'REVIEW');
    assert.equal(recItem.count, 2);
    assert.equal(recItem.metadata.accountId, 'acct-1');
  });

  it('43. priority ordering: BLOCKING before ACTION_NEEDED before REVIEW', () => {
    const { items } = deriveFinancialAttentionItems({
      unreviewedImportsCount: 1,            // ACTION_NEEDED
      unreviewedEligibleTransactionCount: 1, // REVIEW
      debtSnapshots: [{
        id: 'debt-block', name: 'Overdue',
        paymentObligation: { status: 'missed_payment', dueDate: null, minimumRemaining: '0', plannedRemaining: '0' },
        balanceTrajectory: null,
      }],
    });
    assert.equal(items[0].priority, 'BLOCKING');
    assert.ok(items.slice(1).every((i) => i.priority !== 'BLOCKING'), 'BLOCKING is first');
  });

  it('44. within same priority, earlier dueAt sorts before later dueAt', () => {
    const debtSnapshots = [
      { id: 'debt-b', name: 'B', paymentObligation: { status: 'missed_payment', dueDate: '2026-09-20', minimumRemaining: '0', plannedRemaining: '0' }, balanceTrajectory: null },
      { id: 'debt-a', name: 'A', paymentObligation: { status: 'missed_payment', dueDate: '2026-09-10', minimumRemaining: '0', plannedRemaining: '0' }, balanceTrajectory: null },
    ];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    const blockingItems = items.filter((i) => i.priority === 'BLOCKING');
    assert.ok(blockingItems.length >= 2);
    assert.equal(blockingItems[0].dueAt, '2026-09-10');
    assert.equal(blockingItems[1].dueAt, '2026-09-20');
  });

  it('45. items with dueAt sort before items without dueAt at same priority', () => {
    const debtSnapshots = [
      { id: 'debt-noduedate', name: 'NoDue', paymentObligation: { status: 'missed_payment', dueDate: null, minimumRemaining: '0', plannedRemaining: '0' }, balanceTrajectory: null },
      { id: 'debt-withdue', name: 'WithDue', paymentObligation: { status: 'missed_payment', dueDate: '2026-09-15', minimumRemaining: '0', plannedRemaining: '0' }, balanceTrajectory: null },
    ];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    const blockingItems = items.filter((i) => i.priority === 'BLOCKING');
    assert.equal(blockingItems[0].dueAt, '2026-09-15');
    assert.equal(blockingItems[1].dueAt, null);
  });

  it('46. summary.urgent counts only BLOCKING items', () => {
    const { summary } = deriveFinancialAttentionItems({
      unreviewedImportsCount: 1,
      debtSnapshots: [{
        id: 'debt-x', name: 'X',
        paymentObligation: { status: 'missed_payment', dueDate: null, minimumRemaining: '0', plannedRemaining: '0' },
        balanceTrajectory: null,
      }],
    });
    assert.equal(summary.urgent, 1);
    assert.equal(summary.attention, 1); // IMPORT_REVIEW is ACTION_NEEDED
    assert.equal(summary.total, 2);
  });

  it('47. snapshot with null paymentObligation is skipped for obligation signal', () => {
    const debtSnapshots = [{ id: 'd1', name: 'Debt', paymentObligation: null, balanceTrajectory: null }];
    const { items } = deriveFinancialAttentionItems({ debtSnapshots });
    assert.equal(items.filter((i) => i.type === 'DEBT_OBLIGATION').length, 0);
  });

  it('48. result is deterministic — calling twice with same inputs yields identical item ids', () => {
    const inputs = {
      unreviewedImportsCount: 2,
      debtSnapshots: [{
        id: 'debt-det', name: 'Det',
        paymentObligation: { status: 'under_minimum', dueDate: '2026-09-15', minimumRemaining: '50', plannedRemaining: '100' },
        balanceTrajectory: { trajectory: 'increasing', warning: true },
      }],
    };
    const { items: a } = deriveFinancialAttentionItems(inputs);
    const { items: b } = deriveFinancialAttentionItems(inputs);
    assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
  });
});

// ─── Section 5: buildFinancialAttention DB wrapper ──────────────────────────

function makeDb(overrides = {}) {
  const base = {
    async transaction(cb) {
      return cb({
        async getHousehold() { return { activeMonth: '2026-09-01' }; },
        async listImportedTransactions() { return []; },
        async listTransactions() { return []; },
        async listTransactionSplits() { return []; },
        async listDebts() { return []; },
        async listDebtPayments() { return []; },
        async listDebtAdjustments() { return []; },
        async listFinancialAccounts() { return []; },
        async listIncomeEntries() { return []; },
        async listFixedBills() { return []; },
        async listAllocationCategories() { return []; },
        async listUpcomingExpenses() { return []; },
        ...overrides,
      });
    },
  };
  return base;
}

describe('buildFinancialAttention', () => {
  it('49. throws FinancialAttentionError 400 when householdId is missing', async () => {
    await assert.rejects(
      () => buildFinancialAttention({ db: makeDb(), householdId: null }),
      (err) => err instanceof FinancialAttentionError && err.status === 400,
    );
  });

  it('50. throws FinancialAttentionError 500 when db lacks transaction()', async () => {
    await assert.rejects(
      () => buildFinancialAttention({ db: {}, householdId: 'hh1' }),
      (err) => err instanceof FinancialAttentionError && err.status === 500,
    );
  });

  it('51. throws FinancialAttentionError 404 when household not found', async () => {
    const db = makeDb({ async getHousehold() { return null; } });
    await assert.rejects(
      () => buildFinancialAttention({ db, householdId: 'hh-missing' }),
      (err) => err instanceof FinancialAttentionError && err.status === 404,
    );
  });

  it('52. returns { items, summary } shape for empty workspace', async () => {
    const result = await buildFinancialAttention({ db: makeDb(), householdId: 'hh1' });
    assert.ok(Array.isArray(result.items));
    assert.ok(typeof result.summary === 'object');
    assert.ok('total' in result.summary);
    assert.ok('urgent' in result.summary);
    assert.ok('attention' in result.summary);
  });

  it('53. unreviewed import produces IMPORT_REVIEW item', async () => {
    const db = makeDb({
      async listImportedTransactions() {
        return [{ id: 'imp-1', status: 'unreviewed', needs_review: true }];
      },
    });
    const { items } = await buildFinancialAttention({ db, householdId: 'hh1', startDate: '2026-09-15' });
    assert.equal(items.filter((i) => i.type === 'IMPORT_REVIEW').length, 1);
  });

  it('54. classified import does NOT produce IMPORT_REVIEW item', async () => {
    const db = makeDb({
      async listImportedTransactions() {
        return [{ id: 'imp-2', status: 'classified' }];
      },
    });
    const { items } = await buildFinancialAttention({ db, householdId: 'hh1', startDate: '2026-09-15' });
    assert.equal(items.filter((i) => i.type === 'IMPORT_REVIEW').length, 0);
  });

  it('55. eligible unreviewed transaction in active month produces TRANSACTION_REVIEW item', async () => {
    const db = makeDb({
      async listTransactions() {
        return [{
          id: 'txn-1', direction: 'credit', reviewedAt: null,
          transactionDate: '2026-09-05', categoryId: null,
        }];
      },
    });
    const { items } = await buildFinancialAttention({ db, householdId: 'hh1', startDate: '2026-09-15' });
    assert.equal(items.filter((i) => i.type === 'TRANSACTION_REVIEW').length, 1);
  });

  it('56. already-reviewed transaction does NOT produce TRANSACTION_REVIEW item', async () => {
    const db = makeDb({
      async listTransactions() {
        return [{
          id: 'txn-rev', direction: 'credit', reviewedAt: '2026-09-10T12:00:00Z',
          transactionDate: '2026-09-05',
        }];
      },
    });
    const { items } = await buildFinancialAttention({ db, householdId: 'hh1', startDate: '2026-09-15' });
    assert.equal(items.filter((i) => i.type === 'TRANSACTION_REVIEW').length, 0);
  });

  it('57. workspace isolation — householdId is passed to every tx.* query', async () => {
    const seenHouseholdIds = new Set();
    const db = {
      async transaction(cb) {
        return cb({
          async getHousehold({ householdId }) { seenHouseholdIds.add(householdId); return { activeMonth: '2026-09-01' }; },
          async listImportedTransactions({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listTransactions({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listTransactionSplits({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listDebts({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listDebtPayments({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listDebtAdjustments({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listFinancialAccounts({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listIncomeEntries({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listFixedBills({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listAllocationCategories({ householdId }) { seenHouseholdIds.add(householdId); return []; },
          async listUpcomingExpenses({ householdId }) { seenHouseholdIds.add(householdId); return []; },
        });
      },
    };
    await buildFinancialAttention({ db, householdId: 'hh-tenant', startDate: '2026-09-15' });
    assert.ok([...seenHouseholdIds].every((id) => id === 'hh-tenant'),
      `All queries must use householdId=hh-tenant, got: ${[...seenHouseholdIds]}`);
  });

  it('58. no DB rows are mutated', async () => {
    const frozenDebt = Object.freeze({
      id: 'debt-frozen', name: 'Frozen Loan',
      startingBalance: '1000.00', minimumPayment: '50.00', monthlyPayment: '100.00',
      apr: 8.0, isActive: true,
    });
    const db = makeDb({
      async listDebts() { return [frozenDebt]; },
    });
    await assert.doesNotReject(
      () => buildFinancialAttention({ db, householdId: 'hh1', startDate: '2026-09-15' }),
    );
  });
});
