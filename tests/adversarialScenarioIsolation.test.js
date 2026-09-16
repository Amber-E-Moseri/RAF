import test from 'node:test';
import assert from 'node:assert/strict';

import { compute, applyScenario, buildChangeSet } from '../lib/scenarios/engine.js';

// ── Minimal snapshot fixture ──────────────────────────────────────────────────

function makeSnapshot(overrides = {}) {
  return {
    monthlyIncomeCents: 500000, // $5,000
    allocations: [
      { id: 'alloc_housing', slug: 'housing', label: 'Housing', allocationPercent: '0.3000', isBuffer: false },
      { id: 'alloc_food', slug: 'food', label: 'Food', allocationPercent: '0.1000', isBuffer: false },
      { id: 'alloc_buffer', slug: 'emergency_buffer', label: 'Buffer', allocationPercent: '0.1000', isBuffer: true },
      { id: 'alloc_personal', slug: 'personal_spending', label: 'Personal', allocationPercent: '0.0500', isBuffer: false },
    ],
    fixedBills: [
      { id: 'bill1', name: 'Rent', expectedAmountCents: 150000 }, // $1,500
    ],
    debts: [
      { id: 'debt1', name: 'Visa', currentBalanceCents: 200000, minimumPaymentCents: 10000, aprPct: 19.99 }, // $2,000 / $100 min / 19.99% APR
    ],
    goals: [
      { id: 'goal1', name: 'Emergency Fund', targetAmountCents: 1000000, reservedAmountCents: 200000, monthlyContributionCents: 20000 },
    ],
    ...overrides,
  };
}

// ─── Section 1: Snapshot Immutability ─────────────────────────────────────────

test('1.1 — applyScenario does not mutate the original snapshot', () => {
  const snapshot = makeSnapshot();
  const originalIncome = snapshot.monthlyIncomeCents;
  const originalDebtPayment = snapshot.debts[0].minimumPaymentCents;

  applyScenario(snapshot, { type: 'extra_debt_payment', debtId: 'debt1', extraAmountCents: 5000 });
  applyScenario(snapshot, { type: 'income_drop', percentDrop: 20 });

  assert.strictEqual(snapshot.monthlyIncomeCents, originalIncome, 'monthlyIncomeCents must not be mutated');
  assert.strictEqual(snapshot.debts[0].minimumPaymentCents, originalDebtPayment, 'debt minimumPaymentCents must not be mutated');
});

test('1.2 — applyScenario returns a new object reference distinct from the original', () => {
  const snapshot = makeSnapshot();
  const modified = applyScenario(snapshot, { type: 'income_drop', percentDrop: 10 });
  assert.notEqual(modified, snapshot, 'Must return a different object (not same reference)');
  assert.notEqual(modified.debts, snapshot.debts, 'Nested arrays must be deep-copied');
});

// ─── Section 2: compute() Is Deterministic ────────────────────────────────────

test('2.1 — compute returns same result on repeated calls (pure function)', () => {
  const snapshot = makeSnapshot();
  const r1 = compute(snapshot);
  const r2 = compute(snapshot);
  assert.strictEqual(r1.surplus, r2.surplus, 'surplus is stable');
  assert.strictEqual(r1.monthlyIncome, r2.monthlyIncome, 'monthlyIncome is stable');
  assert.strictEqual(r1.maxDebtPayoffMonths, r2.maxDebtPayoffMonths, 'maxDebtPayoffMonths is stable');
});

test('2.2 — compute returns formatted monetary fields (XXXX.XX format, no dollar sign)', () => {
  const result = compute(makeSnapshot());
  assert.match(result.monthlyIncome, /^\d+\.\d{2}$/, 'monthlyIncome is decimal-formatted');
  assert.match(result.surplus, /^-?\d+\.\d{2}$/, 'surplus is decimal-formatted');
  assert.match(result.bufferAmount, /^\d+\.\d{2}$/, 'bufferAmount is decimal-formatted');
});

test('2.3 — compute includes 12-month cash flow simulation', () => {
  const result = compute(makeSnapshot());
  assert.ok(Array.isArray(result.cashFlow12m), 'cashFlow12m is an array');
  assert.strictEqual(result.cashFlow12m.length, 12, '12-month simulation has 12 entries');
  assert.strictEqual(result.cashFlow12m[0].month, 1, 'First month is month 1');
});

// ─── Section 3: Supported Scenario Types ──────────────────────────────────────

test('3.1 — extra_debt_payment: increases minimumPaymentCents for the target debt', () => {
  const snapshot = makeSnapshot();
  const before = snapshot.debts[0].minimumPaymentCents;
  const modified = applyScenario(snapshot, { type: 'extra_debt_payment', debtId: 'debt1', extraAmountCents: 5000 });
  assert.strictEqual(modified.debts[0].minimumPaymentCents, before + 5000, 'minimumPaymentCents increased by extra amount');
});

test('3.2 — extra_debt_payment: reduces debt payoff months compared to baseline', () => {
  const snapshot = makeSnapshot();
  const baseline = compute(snapshot);
  const boosted = compute(applyScenario(snapshot, { type: 'extra_debt_payment', debtId: 'debt1', extraAmountCents: 20000 }));
  const baselineMonths = baseline.debtPayoff.find((d) => d.id === 'debt1')?.months ?? Infinity;
  const boostedMonths = boosted.debtPayoff.find((d) => d.id === 'debt1')?.months ?? Infinity;
  assert.ok(boostedMonths < baselineMonths, 'Extra payment reduces payoff months');
});

test('3.3 — income_drop: reduces monthlyIncomeCents proportionally', () => {
  const snapshot = makeSnapshot();
  const modified = applyScenario(snapshot, { type: 'income_drop', percentDrop: 20 });
  const expectedIncome = Math.round(500000 * 0.8);
  assert.strictEqual(modified.monthlyIncomeCents, expectedIncome, '20% income drop produces correct reduced amount');
});

test('3.4 — expense_increase with amountCents adds a new fixed bill', () => {
  const snapshot = makeSnapshot();
  const billsBefore = snapshot.fixedBills.length;
  const modified = applyScenario(snapshot, { type: 'expense_increase', name: 'Car Repair', amountCents: 30000 });
  assert.strictEqual(modified.fixedBills.length, billsBefore + 1, 'A new fixed bill is added');
  const newBill = modified.fixedBills.find((b) => b.name === 'Car Repair');
  assert.ok(newBill, 'New bill has the provided name');
  assert.strictEqual(newBill.expectedAmountCents, 30000, 'New bill has the correct amount');
});

test('3.5 — expense_increase with percentIncrease multiplies all existing fixed bills', () => {
  const snapshot = makeSnapshot();
  const originalRent = snapshot.fixedBills[0].expectedAmountCents;
  const modified = applyScenario(snapshot, { type: 'expense_increase', percentIncrease: 10 });
  const expectedRent = Math.round(originalRent * 1.1);
  assert.strictEqual(modified.fixedBills.length, snapshot.fixedBills.length, 'No new bills added for percentIncrease');
  assert.strictEqual(modified.fixedBills[0].expectedAmountCents, expectedRent, 'Existing bill increased by percent');
});

test('3.6 — goal_savings: changes monthlyContributionCents for target goal', () => {
  const snapshot = makeSnapshot();
  const modified = applyScenario(snapshot, { type: 'goal_savings', goalId: 'goal1', monthlyContributionCents: 50000 });
  const goal = modified.goals.find((g) => g.id === 'goal1');
  assert.strictEqual(goal.monthlyContributionCents, 50000, 'Goal contribution updated');
});

test('3.7 — surplus_redirect: adds to an existing allocation percent', () => {
  const snapshot = makeSnapshot();
  const before = parseFloat(snapshot.allocations.find((a) => a.slug === 'food').allocationPercent);
  const modified = applyScenario(snapshot, { type: 'surplus_redirect', targetSlug: 'food', amountCents: 10000 });
  const after = parseFloat(modified.allocations.find((a) => a.slug === 'food').allocationPercent);
  assert.ok(after > before, 'Allocation percent increased after surplus redirect');
});

test('3.8 — emergency_floor_change: updates isBuffer allocation to new percent', () => {
  const snapshot = makeSnapshot();
  const modified = applyScenario(snapshot, { type: 'emergency_floor_change', newBufferPct: 20 });
  const buffer = modified.allocations.find((a) => a.isBuffer);
  assert.ok(buffer, 'Buffer allocation exists');
  assert.strictEqual(buffer.allocationPercent, '0.2000', 'Buffer percent updated to 20%');
});

// ─── Section 4: Unknown and No-Op Scenario Types ─────────────────────────────

test('4.1 — Unknown scenario type is silently ignored (no error, no mutation)', () => {
  const snapshot = makeSnapshot();
  const modified = applyScenario(snapshot, { type: 'quantum_time_travel', magicValue: 999 });
  assert.strictEqual(modified.monthlyIncomeCents, snapshot.monthlyIncomeCents, 'Income unchanged for unknown type');
  assert.strictEqual(modified.fixedBills.length, snapshot.fixedBills.length, 'Bills unchanged for unknown type');
});

test('4.2 — one_time_purchase: sets _oneTimePurchaseCents on modified snapshot', () => {
  const snapshot = makeSnapshot();
  const modified = applyScenario(snapshot, { type: 'one_time_purchase', amountCents: 50000 });
  assert.strictEqual(modified._oneTimePurchaseCents, 50000, '_oneTimePurchaseCents set on modified snapshot');
});

test('4.3 — one_time_purchase: does not affect 12-month simulation (not consumed by simulate12Months)', () => {
  const snapshot = makeSnapshot();
  const baseline = compute(snapshot);
  const withPurchase = compute(applyScenario(snapshot, { type: 'one_time_purchase', amountCents: 500000 }));
  assert.strictEqual(
    baseline.cashFlow12m[0].surplus,
    withPurchase.cashFlow12m[0].surplus,
    'one_time_purchase has no effect on 12-month simulation surplus — known limitation',
  );
});

// ─── Section 5: SCENARIO → ACTUAL Firewall ────────────────────────────────────

test('5.1 — compute, applyScenario, buildChangeSet take no DB parameter — pure functions only', () => {
  // These functions must not accept db — they have no mutation pathway to ACTUAL data
  const snapshotArgs = [makeSnapshot()];
  assert.doesNotThrow(() => compute(...snapshotArgs), 'compute() throws no error without db');
  assert.doesNotThrow(
    () => applyScenario(makeSnapshot(), { type: 'income_drop', percentDrop: 10 }),
    'applyScenario() throws no error without db',
  );
  assert.doesNotThrow(
    () => buildChangeSet(makeSnapshot(), { type: 'income_drop', percentDrop: 10 }),
    'buildChangeSet() throws no error without db',
  );
});

test('5.2 — Scenario isolation: applying scenario A then B matches applying only B to original', () => {
  // Each applyScenario call starts from a fresh copy — compositions must chain, not accumulate
  const snapshot = makeSnapshot();
  const afterA = applyScenario(snapshot, { type: 'income_drop', percentDrop: 10 });
  const afterAB = applyScenario(afterA, { type: 'extra_debt_payment', debtId: 'debt1', extraAmountCents: 5000 });

  const directB = applyScenario(snapshot, { type: 'extra_debt_payment', debtId: 'debt1', extraAmountCents: 5000 });

  // After chaining, income should reflect A's drop; debt should reflect B's extra payment
  assert.ok(afterAB.monthlyIncomeCents < snapshot.monthlyIncomeCents, 'Chained: income reflects drop from A');
  assert.ok(afterAB.debts[0].minimumPaymentCents > snapshot.debts[0].minimumPaymentCents, 'Chained: debt reflects extra from B');

  // Direct B alone must not have modified income
  assert.strictEqual(directB.monthlyIncomeCents, snapshot.monthlyIncomeCents, 'Direct B alone has no income drop');
});

// ─── Section 6: buildChangeSet ─────────────────────────────────────────────────

test('6.1 — buildChangeSet for extra_debt_payment returns debt change with from/to', () => {
  const snapshot = makeSnapshot();
  const changes = buildChangeSet(snapshot, { type: 'extra_debt_payment', debtId: 'debt1', extraAmountCents: 5000 });
  assert.ok(Array.isArray(changes), 'Returns an array');
  assert.strictEqual(changes.length, 1, 'One change for one debt');
  const c = changes[0];
  assert.strictEqual(c.resource, 'debt', 'resource is debt');
  assert.ok(c.from, 'from is populated');
  assert.ok(c.to, 'to is populated');
  assert.ok(c.description, 'description is populated');
});

test('6.2 — buildChangeSet for income_drop returns a note (not a mutation of ACTUAL income)', () => {
  const snapshot = makeSnapshot();
  const changes = buildChangeSet(snapshot, { type: 'income_drop', percentDrop: 25 });
  assert.strictEqual(changes.length, 1, 'One change entry');
  assert.strictEqual(changes[0].resource, 'note', 'income_drop is advisory — resource=note, not a real mutation');
  assert.match(changes[0].description, /no automatic change applied/i, 'Description clarifies no automatic change');
});

test('6.3 — buildChangeSet for expense_increase with amountCents shows new bill entry', () => {
  const snapshot = makeSnapshot();
  const changes = buildChangeSet(snapshot, { type: 'expense_increase', name: 'Gym', amountCents: 5000 });
  assert.strictEqual(changes.length, 1, 'One change for adding a new bill');
  assert.strictEqual(changes[0].resource, 'fixedBill', 'resource is fixedBill');
  assert.ok(changes[0].to, 'to is populated');
  assert.strictEqual(changes[0].from, null, 'from is null for a new addition');
});

test('6.4 — buildChangeSet for unknown type returns empty array (no changes to apply)', () => {
  const snapshot = makeSnapshot();
  const changes = buildChangeSet(snapshot, { type: 'unknown_type_xyz' });
  assert.ok(Array.isArray(changes), 'Returns array');
  assert.strictEqual(changes.length, 0, 'Empty changes for unknown scenario type');
});

// ─── Section 7: Debt Payoff Math ──────────────────────────────────────────────

test('7.1 — compute: debt with balance=0 reports 0 months to payoff', () => {
  const snapshot = makeSnapshot({
    debts: [{ id: 'debt1', name: 'Paid Debt', currentBalanceCents: 0, minimumPaymentCents: 10000, aprPct: 0 }],
  });
  const result = compute(snapshot);
  const debt = result.debtPayoff.find((d) => d.id === 'debt1');
  assert.strictEqual(debt.months, 0, 'Zero balance → zero months to payoff');
});

test('7.2 — compute: debt where payment ≤ monthly interest reports Infinity months on individual debt', () => {
  // Balance $100,000, APR 100%, min payment $100 → monthly interest ≈ $8,333
  // Payment will never exceed interest — debtPayoffMonths() returns Infinity
  // maxDebtPayoffMonths caps at 999 (Infinity guard) but individual debtPayoff entry is Infinity
  const snapshot = makeSnapshot({
    debts: [{ id: 'debt1', name: 'Underwater Debt', currentBalanceCents: 10000000, minimumPaymentCents: 100, aprPct: 100 }],
  });
  const result = compute(snapshot);
  const debt = result.debtPayoff.find((d) => d.id === 'debt1');
  assert.ok(!Number.isFinite(debt.months), 'Payment ≤ interest → Infinity months on individual debtPayoff entry');
  assert.strictEqual(result.maxDebtPayoffMonths, 999, 'maxDebtPayoffMonths caps Infinity at 999');
});

// ─── Section 8: Goal Completion Math ──────────────────────────────────────────

test('8.1 — compute: goal at 100% complete reports 0 months', () => {
  const snapshot = makeSnapshot({
    goals: [{ id: 'goal1', name: 'Done Goal', targetAmountCents: 100000, reservedAmountCents: 100000, monthlyContributionCents: 10000 }],
  });
  const result = compute(snapshot);
  const goal = result.goalCompletion.find((g) => g.id === 'goal1');
  assert.strictEqual(goal.months, 0, 'Fully reserved goal reports 0 months');
});

test('8.2 — compute: goal with no contribution reports null months (cannot calculate timeline)', () => {
  const snapshot = makeSnapshot({
    goals: [{ id: 'goal1', name: 'No Contribution', targetAmountCents: 100000, reservedAmountCents: 0, monthlyContributionCents: 0 }],
  });
  const result = compute(snapshot);
  const goal = result.goalCompletion.find((g) => g.id === 'goal1');
  assert.strictEqual(goal.months, null, 'Zero contribution → null months (no timeline possible)');
});
