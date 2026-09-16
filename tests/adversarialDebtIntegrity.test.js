/**
 * Phase 4 — Debt Integrity
 *
 * Core question: Can RAF correctly distinguish what a user paid from what
 * happened to the debt balance, aggregating payments against the correct
 * obligation and preserving the authoritative balance source?
 *
 * Steps 1–27 per the Phase 4 adversarial specification.
 * No import workflow, Remi, Postgres RLS, or new product behavior under test.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { createDebt, listDebts, updateDebt, deleteDebt, createDebtAdjustment } from '../lib/debts/debts.js';
import {
  deriveDebtSnapshot,
  classifyPaymentPace,
  deriveBalanceTrajectory,
  derivePaymentObligation,
} from '../lib/raf/debts.js';
import { resolveDebtBalanceAuthority } from '../lib/debts/debtBalanceAuthority.js';
import { parseMoneyToCents } from '../lib/raf/reporting.js';

const HOUSEHOLD_ID = 'household_p4_debt';
const HOUSEHOLD_B = 'household_p4_debt_b';
const USER_ID = 'test_user_p4_debt';

function tocents(s) {
  return parseMoneyToCents(typeof s === 'number' ? s.toFixed(2) : String(s));
}

async function insertPayment(db, { householdId, debtId, amount, paymentDate }) {
  return db.transaction(async (tx) =>
    tx.insertDebtPayment({ householdId, debtId, amount, paymentDate }),
  );
}

async function makeDebt(db, householdId, overrides = {}) {
  const { name, startingBalance, apr, minimumPayment, monthlyPayment, statementDay, paymentDueDay, ...rest } = overrides;
  return createDebt({
    db,
    householdId,
    userId: USER_ID,
    input: {
      name: name ?? 'Test Debt',
      startingBalance: startingBalance ?? '1000.00',
      apr: apr ?? 0,
      minimumPayment: minimumPayment ?? '25.00',
      monthlyPayment: monthlyPayment ?? '100.00',
      ...(statementDay != null ? { statementDay } : {}),
      ...(paymentDueDay != null ? { paymentDueDay } : {}),
      ...rest,
    },
  });
}

// ---------------------------------------------------------------------------
// Section 1: Manual Debt Balance Derivation (Steps 1–5)
// ---------------------------------------------------------------------------
describe('1. Manual debt balance derivation', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  test('1.1 — No payments: currentBalance equals startingBalance', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '2500.00' });
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      [],
      [],
      '2026-01-01',
    );
    assert.equal(snap.currentBalance, '2500.00');
  });

  test('1.2 — Single payment reduces balance exactly', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00' });
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      [{ id: 'p1', debtId: debt.id, amount: '250.00', paymentDate: '2026-01-10' }],
      [],
      '2026-02-01',
    );
    assert.equal(snap.currentBalance, '750.00', 'balance must drop by exactly the payment amount');
  });

  test('1.3 — Multiple payments aggregate correctly', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '3000.00' });
    const payments = [
      { id: 'p1', debtId: debt.id, amount: '500.00', paymentDate: '2026-01-05' },
      { id: 'p2', debtId: debt.id, amount: '500.00', paymentDate: '2026-02-05' },
      { id: 'p3', debtId: debt.id, amount: '250.00', paymentDate: '2026-03-05' },
    ];
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      payments,
      [],
      '2026-04-01',
    );
    // 3000 - 500 - 500 - 250 = 1750
    assert.equal(snap.currentBalance, '1750.00', 'sum of all payments must be subtracted');
  });

  test('1.4 — Positive adjustment (interest) increases balance', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00' });
    const adjustments = [
      { id: 'a1', debtId: debt.id, amount: '50.00', adjustmentType: 'interest', effectiveDate: '2026-01-15' },
    ];
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      [],
      adjustments,
      '2026-02-01',
    );
    // 1000 + 50 = 1050
    assert.equal(snap.currentBalance, '1050.00', 'interest adjustment must add to balance');
  });

  test('1.5 — Negative correction adjustment decreases balance', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00' });
    const adjustments = [
      { id: 'a1', debtId: debt.id, amount: '-200.00', adjustmentType: 'correction', effectiveDate: '2026-01-20' },
    ];
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      [],
      adjustments,
      '2026-02-01',
    );
    // 1000 - 200 = 800
    assert.equal(snap.currentBalance, '800.00', 'negative correction must reduce balance');
  });
});

// ---------------------------------------------------------------------------
// Section 2: Cross-Debt Payment Isolation (Steps 6–8)
// ---------------------------------------------------------------------------
describe('2. Cross-debt payment isolation', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  test('2.1 — Payment applied to debtA does not affect debtB', async () => {
    const debtA = await makeDebt(db, HOUSEHOLD_ID, { name: 'Debt A', startingBalance: '1000.00' });
    const debtB = await makeDebt(db, HOUSEHOLD_ID, { name: 'Debt B', startingBalance: '2000.00' });

    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debtA.id, amount: '500.00', paymentDate: '2026-01-10' });

    const [paymentsA, paymentsB] = await Promise.all([
      db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_ID, debtId: debtA.id })),
      db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_ID, debtId: debtB.id })),
    ]);

    const snapA = deriveDebtSnapshot(
      { ...debtA, balanceAuthority: resolveDebtBalanceAuthority({ debt: debtA }) },
      paymentsA, [], '2026-02-01',
    );
    const snapB = deriveDebtSnapshot(
      { ...debtB, balanceAuthority: resolveDebtBalanceAuthority({ debt: debtB }) },
      paymentsB, [], '2026-02-01',
    );

    assert.equal(snapA.currentBalance, '500.00', 'debtA balance reduced by payment');
    assert.equal(snapB.currentBalance, '2000.00', 'ISOLATION FAILURE — debtB balance must be unchanged');
  });

  test('2.2 — Payment with wrong debtId not counted toward correct debt', async () => {
    const debtA = await makeDebt(db, HOUSEHOLD_ID, { name: 'Target Debt', startingBalance: '1000.00' });
    const debtB = await makeDebt(db, HOUSEHOLD_ID, { name: 'Other Debt', startingBalance: '500.00' });

    // Insert payment pointing to debtB only
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debtB.id, amount: '500.00', paymentDate: '2026-01-10' });

    const paymentsForA = await db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_ID, debtId: debtA.id }));

    assert.equal(paymentsForA.length, 0, 'debtA must have zero payments when payment is linked to debtB');
  });

  test('2.3 — Payments sum per debtId only (grouping invariant)', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1500.00' });
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debt.id, amount: '100.00', paymentDate: '2026-01-05' });
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debt.id, amount: '200.00', paymentDate: '2026-01-20' });
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debt.id, amount: '150.00', paymentDate: '2026-02-05' });

    const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_ID, debtId: debt.id }));
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      payments, [], '2026-03-01',
    );
    // 1500 - 100 - 200 - 150 = 1050
    assert.equal(snap.currentBalance, '1050.00');
    assert.equal(snap.totalPaidAllTime, '450.00');
  });
});

// ---------------------------------------------------------------------------
// Section 3: Adjustment Types (Steps 9–12)
// ---------------------------------------------------------------------------
describe('3. Adjustment types all handled correctly', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  async function snapWithAdj(db, amount, adjustmentType) {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00', apr: 0 });
    const adj = await createDebtAdjustment({
      db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID,
      input: { amount, adjustmentType, effectiveDate: '2026-01-15', note: 'test' },
    });
    const adjustments = await db.transaction((tx) => tx.listDebtAdjustments({ householdId: HOUSEHOLD_ID, debtId: debt.id }));
    return deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      [], adjustments, '2026-02-01',
    );
  }

  test('3.1 — interest adjustment adds to balance', async () => {
    const snap = await snapWithAdj(db, '75.00', 'interest');
    assert.equal(snap.currentBalance, '1075.00');
  });

  test('3.2 — fee adjustment adds to balance', async () => {
    const snap = await snapWithAdj(db, '30.00', 'fee');
    assert.equal(snap.currentBalance, '1030.00');
  });

  test('3.3 — late_fee adjustment adds to balance', async () => {
    const snap = await snapWithAdj(db, '39.00', 'late_fee');
    assert.equal(snap.currentBalance, '1039.00');
  });

  test('3.4 — negative correction reduces balance', async () => {
    const snap = await snapWithAdj(db, '-400.00', 'correction');
    assert.equal(snap.currentBalance, '600.00');
  });

  test('3.5 — positive reconciliation adds to balance', async () => {
    const snap = await snapWithAdj(db, '100.00', 'reconciliation');
    assert.equal(snap.currentBalance, '1100.00');
  });

  test('3.6 — payment + adjustment: net balance correct', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '2000.00' });
    await createDebtAdjustment({
      db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID,
      input: { amount: '80.00', adjustmentType: 'interest', effectiveDate: '2026-01-15', note: 'Jan interest' },
    });
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debt.id, amount: '300.00', paymentDate: '2026-01-25' });

    const [payments, adjustments] = await Promise.all([
      db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_ID, debtId: debt.id })),
      db.transaction((tx) => tx.listDebtAdjustments({ householdId: HOUSEHOLD_ID, debtId: debt.id })),
    ]);
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      payments, adjustments, '2026-02-01',
    );
    // 2000 + 80 - 300 = 1780
    assert.equal(snap.currentBalance, '1780.00');
  });
});

// ---------------------------------------------------------------------------
// Section 4: classifyPaymentPace (Steps 13–19)
// ---------------------------------------------------------------------------
describe('4. classifyPaymentPace — all states', () => {
  function pace(actual, planned, minimum, isPaymentDue = false) {
    return classifyPaymentPace({
      actualPaymentCents: tocents(actual),
      monthlyPaymentCents: tocents(planned),
      minimumPaymentCents: tocents(minimum),
      isPaymentDue,
    });
  }

  test('4.1 — actual=0 → no_payment', () => {
    assert.equal(pace('0.00', '150.00', '25.00').pace, 'no_payment');
  });

  test('4.2 — actual > plan + tolerance → above_plan', () => {
    // plan=150, tolerance=max(7.50,5)=7.50, upperBound=157.50, actual=400
    const result = pace('400.00', '150.00', '25.00');
    assert.equal(result.pace, 'above_plan');
    assert.ok(result.amountAbovePlan > 0, 'amountAbovePlan must be positive');
  });

  test('4.3 — actual within 5% tolerance → on_plan', () => {
    // plan=200, tolerance=max(10,5)=10, range=[190,210], actual=200
    assert.equal(pace('200.00', '200.00', '50.00').pace, 'on_plan');
  });

  test('4.4 — actual < plan-tolerance but above minimum → below_plan', () => {
    // plan=200, tolerance=10, lowerBound=190, actual=100 (above min=25)
    assert.equal(pace('100.00', '200.00', '25.00').pace, 'below_plan');
  });

  test('4.5 — actual exactly minimum, below lowerBound → minimum_only', () => {
    // plan=200, min=50, actual=50, lowerBound=190
    assert.equal(pace('50.00', '200.00', '50.00').pace, 'minimum_only');
  });

  test('4.6 — actual < minimum AND isPaymentDue=true → under_minimum', () => {
    // plan=200, min=50, actual=20, isPaymentDue=true
    assert.equal(pace('20.00', '200.00', '50.00', true).pace, 'under_minimum');
  });

  test('4.7 — plan=0, actual>0 → above_plan', () => {
    // When no plan, any payment counts as above plan
    assert.equal(pace('50.00', '0.00', '0.00').pace, 'above_plan');
  });

  test('4.8 — percentOfPlan calculated correctly', () => {
    const result = pace('120.00', '200.00', '50.00');
    assert.equal(result.percentOfPlan, 60, 'percentOfPlan must be 60.0 for 120/200');
  });

  test('4.9 — amountAboveMinimum calculated correctly', () => {
    const result = pace('150.00', '200.00', '50.00');
    assert.equal(result.amountAboveMinimum, tocents('100.00'), 'amountAboveMinimum = actual - minimum');
  });
});

// ---------------------------------------------------------------------------
// Section 5: deriveBalanceTrajectory (Steps 20–22)
// ---------------------------------------------------------------------------
describe('5. deriveBalanceTrajectory — all states', () => {
  function traj(opening, closing) {
    return deriveBalanceTrajectory({
      openingBalanceCents: tocents(opening),
      closingBalanceCents: tocents(closing),
    });
  }

  test('5.1 — closing < opening - tolerance → decreasing', () => {
    // opening=10000, closing=9000 (change=-1000, tolerance=max(9,100)=100)
    const result = traj('100.00', '90.00');
    assert.equal(result.trajectory, 'decreasing');
    assert.equal(result.isDecreasing, true);
    assert.equal(result.warning, false);
  });

  test('5.2 — closing > opening + tolerance → increasing (warning)', () => {
    // opening=5000 ($50), closing=10000 ($100), well above tolerance
    const result = traj('50.00', '100.00');
    assert.equal(result.trajectory, 'increasing');
    assert.equal(result.isIncreasing, true);
    assert.equal(result.warning, true, 'increasing balance must set warning=true');
  });

  test('5.3 — |change| <= tolerance → stable', () => {
    // opening=10000, closing=10001 (change=1, tolerance=max(10,100)=100)
    const result = traj('100.00', '100.01');
    assert.equal(result.trajectory, 'stable');
    assert.equal(result.isStable, true);
    assert.equal(result.warning, false);
  });

  test('5.4 — tolerance is at least 100 cents', () => {
    // Even tiny balances have minimum 100-cent tolerance
    const result = traj('1.00', '1.50');
    // change=50 cents; tolerance=max(round(150*0.001),100)=max(0,100)=100; 50<100 → stable
    assert.equal(result.trajectory, 'stable', 'small-balance tolerance floor must be 100 cents');
  });

  test('5.5 — absoluteChange and percentageChange reported correctly', () => {
    const result = traj('200.00', '180.00');
    // change = 18000 - 20000 = -2000 cents
    assert.equal(result.absoluteChange, -2000);
    assert.ok(result.percentageChange < 0, 'percentageChange must be negative when decreasing');
  });
});

// ---------------------------------------------------------------------------
// Section 6: July 2026 Critical Scenario — above_plan AND increasing (Steps 23–25)
// ---------------------------------------------------------------------------
describe('6. July 2026 critical scenario: above_plan + increasing coexist', () => {
  test('6.1 — Paying $400 (above $150 plan) while $500 interest inflates balance', () => {
    const debt = {
      id: 'debt_july2026',
      householdId: HOUSEHOLD_ID,
      startingBalance: '5000.00',
      apr: 0,
      minimumPayment: '100.00',
      monthlyPayment: '150.00',
      isActive: true,
    };
    const balanceAuthority = resolveDebtBalanceAuthority({ debt });

    // Large interest adjustment charges $500 in July (before payment)
    // Payment of $400 in July — above plan of $150, but insufficient to offset interest
    const adjustments = [
      { id: 'a1', debtId: debt.id, amount: '500.00', adjustmentType: 'interest', effectiveDate: '2026-07-05' },
    ];
    const payments = [
      { id: 'p1', debtId: debt.id, amount: '400.00', paymentDate: '2026-07-15' },
    ];

    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority },
      payments,
      adjustments,
      '2026-07-01',
    );

    // Payment pace: 400 > 150+7.50 → above_plan
    assert.equal(snap.paymentPace.pace, 'above_plan',
      'Payment of $400 against $150 plan must be above_plan');

    // Balance trajectory: opening=$5000, closing=$5000+$500-$400=$5100 → increasing
    assert.equal(snap.balanceTrajectory.trajectory, 'increasing',
      'Balance must be INCREASING because interest ($500) > payment ($400)');

    // The two dimensions must coexist without contradiction
    assert.equal(snap.paymentPace.pace, 'above_plan');
    assert.equal(snap.balanceTrajectory.trajectory, 'increasing');
  });

  test('6.2 — Pace and trajectory are derived from different inputs (independence)', () => {
    // classifyPaymentPace only takes: actual, minimum, planned, isPaymentDue
    // deriveBalanceTrajectory only takes: openingBalanceCents, closingBalanceCents
    // They share NO inputs → they are structurally independent

    const paceResult = classifyPaymentPace({
      actualPaymentCents: tocents('400.00'),
      monthlyPaymentCents: tocents('150.00'),
      minimumPaymentCents: tocents('100.00'),
      isPaymentDue: false,
    });
    assert.equal(paceResult.pace, 'above_plan');

    const trajResult = deriveBalanceTrajectory({
      openingBalanceCents: tocents('5000.00'),
      closingBalanceCents: tocents('5100.00'),
    });
    assert.equal(trajResult.trajectory, 'increasing');

    // Verify pace result has no balance fields
    assert.ok(!Object.prototype.hasOwnProperty.call(paceResult, 'trajectory'),
      'pace result must not contain trajectory');
    // Verify trajectory result has no payment fields
    assert.ok(!Object.prototype.hasOwnProperty.call(trajResult, 'pace'),
      'trajectory result must not contain pace');
  });

  test('6.3 — on_plan payment that still causes balance to increase is valid', () => {
    // Planned=$200, paid=$200 (on_plan), but $300 interest → balance increases
    const debt = {
      id: 'debt_onplan_inc',
      householdId: HOUSEHOLD_ID,
      startingBalance: '10000.00',
      apr: 0,
      minimumPayment: '100.00',
      monthlyPayment: '200.00',
      isActive: true,
    };
    const adjustments = [
      { id: 'a1', debtId: debt.id, amount: '300.00', adjustmentType: 'interest', effectiveDate: '2026-07-05' },
    ];
    const payments = [
      { id: 'p1', debtId: debt.id, amount: '200.00', paymentDate: '2026-07-15' },
    ];
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      payments, adjustments, '2026-07-01',
    );
    assert.equal(snap.paymentPace.pace, 'on_plan');
    assert.equal(snap.balanceTrajectory.trajectory, 'increasing');
  });
});

// ---------------------------------------------------------------------------
// Section 7: Account-Linked Debt Balance Authority (Steps 26–28)
// ---------------------------------------------------------------------------
describe('7. Account-linked debt balance authority', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  async function makeLinkedDebt(db, accountBalance) {
    const account = await db.transaction(async (tx) =>
      tx.insertFinancialAccount({
        householdId: HOUSEHOLD_ID,
        name: 'Test Credit Card',
        accountType: 'credit_card',
        currentBalance: accountBalance,
        balanceAsOf: '2026-09-01',
        status: 'active',
      }),
    );
    const debt = await makeDebt(db, HOUSEHOLD_ID, {
      startingBalance: '5000.00',
      financialAccountId: account.id,
    });
    return { debt, account };
  }

  test('7.1 — Linked debt currentBalance = abs(account.currentBalance)', async () => {
    const { debt } = await makeLinkedDebt(db, '-3500.00');
    // The debt response from createDebt already has the account-linked balance
    assert.equal(debt.currentBalance, '3500.00',
      'linked debt balance must be abs of account balance, not startingBalance');
    assert.equal(debt.balanceAuthority.source, 'financial_account');
  });

  test('7.2 — Payments do not change account-linked debt currentBalance', async () => {
    const { debt, account } = await makeLinkedDebt(db, '-3500.00');
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debt.id, amount: '500.00', paymentDate: '2026-09-05' });

    const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_ID, debtId: debt.id }));
    const snap = deriveDebtSnapshot(
      {
        ...debt,
        balanceAuthority: resolveDebtBalanceAuthority({ debt, financialAccount: account }),
      },
      payments, [], '2026-09-01',
    );
    assert.equal(snap.currentBalance, '3500.00',
      'AUTHORITY VIOLATION — linked debt balance must come from account, not payments');
    assert.equal(snap.paymentsThisMonth, '500.00', 'payment is still tracked');
  });

  test('7.3 — Account balance update changes linked debt currentBalance', async () => {
    const { debt, account } = await makeLinkedDebt(db, '-3500.00');
    // Simulate account balance update (e.g., after a sync)
    const updatedAccount = await db.transaction((tx) =>
      tx.updateFinancialAccount({ householdId: HOUSEHOLD_ID, accountId: account.id, patch: { currentBalance: '-3000.00' } }),
    );
    const snap = deriveDebtSnapshot(
      {
        ...debt,
        balanceAuthority: resolveDebtBalanceAuthority({ debt, financialAccount: updatedAccount }),
      },
      [], [], '2026-09-01',
    );
    assert.equal(snap.currentBalance, '3000.00', 'balance must reflect updated account balance');
  });
});

// ---------------------------------------------------------------------------
// Section 8: Balance Authority Source (Steps 29–31)
// ---------------------------------------------------------------------------
describe('8. Balance authority source identity', () => {
  test('8.1 — Manual debt has source=manual_derived', () => {
    const debt = { id: 'debt_manual', financialAccountId: null };
    const authority = resolveDebtBalanceAuthority({ debt });
    assert.equal(authority.source, 'manual_derived');
    assert.equal(authority.balance, null);
    assert.equal(authority.financialAccountId, null);
  });

  test('8.2 — Linked debt (with account) has source=financial_account', () => {
    const debt = { id: 'debt_linked', financialAccountId: 'acct_123' };
    const account = { id: 'acct_123', currentBalance: '-2000.00', balanceAsOf: '2026-09-01' };
    const authority = resolveDebtBalanceAuthority({ debt, financialAccount: account });
    assert.equal(authority.source, 'financial_account');
    assert.equal(authority.balance, '2000.00');
    assert.equal(authority.financialAccountId, 'acct_123');
  });

  test('8.3 — Linked debt missing financial account throws', () => {
    const debt = { id: 'debt_linked', financialAccountId: 'acct_missing' };
    assert.throws(
      () => resolveDebtBalanceAuthority({ debt, financialAccount: null }),
      /linked debt requires a financial account/i,
    );
  });

  test('8.4 — Manual debt: currentBalance derived from startingBalance-payments+adjustments', () => {
    const debt = {
      id: 'debt_manual2',
      householdId: HOUSEHOLD_ID,
      startingBalance: '2000.00',
      apr: 0,
      monthlyPayment: '100.00',
      minimumPayment: '50.00',
      isActive: true,
    };
    const authority = resolveDebtBalanceAuthority({ debt });
    const snap = deriveDebtSnapshot({ ...debt, balanceAuthority: authority }, [], [], '2026-01-01');
    assert.equal(snap.balanceAuthority.source, 'manual_derived');
    assert.equal(snap.currentBalance, debt.startingBalance,
      'manual debt with no payments must show startingBalance');
  });
});

// ---------------------------------------------------------------------------
// Section 9: Payment Obligation (Steps 32–35)
// ---------------------------------------------------------------------------
describe('9. Payment obligation status', () => {
  const baseDebt = {
    id: 'debt_obligation',
    householdId: HOUSEHOLD_ID,
    startingBalance: '5000.00',
    apr: 0,
    minimumPayment: '100.00',
    monthlyPayment: '200.00',
    statementDay: 1,
    paymentDueDay: 15,
    isActive: true,
  };

  test('9.1 — No statementDay/paymentDueDay → obligation = null', () => {
    const debt = { ...baseDebt, statementDay: null, paymentDueDay: null };
    const obligation = derivePaymentObligation({ debt, payments: [], obligationMonth: '2026-09', asOfDate: '2026-09-16' });
    assert.equal(obligation, null, 'obligation requires statementDay AND paymentDueDay');
  });

  test('9.2 — Paid >= plan → status = satisfied', () => {
    const payments = [
      { id: 'p1', debtId: baseDebt.id, amount: '200.00', paymentDate: '2026-09-10' },
    ];
    const obligation = derivePaymentObligation({ debt: baseDebt, payments, obligationMonth: '2026-09', asOfDate: '2026-09-16' });
    assert.equal(obligation.status, 'satisfied');
    assert.equal(obligation.planSatisfied, true);
  });

  test('9.3 — Zero paid, before due date → status = pending', () => {
    const obligation = derivePaymentObligation({ debt: baseDebt, payments: [], obligationMonth: '2026-09', asOfDate: '2026-09-10' });
    assert.equal(obligation.status, 'pending', 'no payment before due date must be pending, not missed');
  });

  test('9.4 — Partial paid, before due date → status = in_progress', () => {
    const payments = [
      { id: 'p1', debtId: baseDebt.id, amount: '50.00', paymentDate: '2026-09-10' },
    ];
    const obligation = derivePaymentObligation({ debt: baseDebt, payments, obligationMonth: '2026-09', asOfDate: '2026-09-10' });
    assert.equal(obligation.status, 'in_progress', 'partial payment before due date must be in_progress');
    assert.equal(obligation.minimumSatisfied, false);
    assert.equal(obligation.planSatisfied, false);
  });

  test('9.5 — Partial paid >= minimum → minimumSatisfied = true', () => {
    const payments = [
      { id: 'p1', debtId: baseDebt.id, amount: '100.00', paymentDate: '2026-09-10' },
    ];
    const obligation = derivePaymentObligation({ debt: baseDebt, payments, obligationMonth: '2026-09', asOfDate: '2026-09-10' });
    assert.equal(obligation.minimumSatisfied, true);
    assert.equal(obligation.planSatisfied, false, 'paying minimum only does not satisfy plan');
  });
});

// ---------------------------------------------------------------------------
// Section 10: Cross-Tenant Isolation (Steps 36–38)
// ---------------------------------------------------------------------------
describe('10. Cross-tenant debt isolation', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  test('10.1 — Household A debt not visible to household B listDebts', async () => {
    await makeDebt(db, HOUSEHOLD_ID, { name: 'House A Debt', startingBalance: '1000.00' });

    const result = await listDebts({ db, householdId: HOUSEHOLD_B });
    assert.equal(result.items.length, 0,
      'SECURITY_DEFECT — household B must not see household A debts');
  });

  test('10.2 — Payment in household A not counted in household B debt', async () => {
    const debtA = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '2000.00' });
    const debtB = await makeDebt(db, HOUSEHOLD_B, { startingBalance: '3000.00' });

    // Insert payment against household A / debtA
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debtA.id, amount: '1000.00', paymentDate: '2026-09-01' });

    // debtB should have zero payments
    const paymentsB = await db.transaction((tx) => tx.listDebtPayments({ householdId: HOUSEHOLD_B, debtId: debtB.id }));
    assert.equal(paymentsB.length, 0,
      'SECURITY_DEFECT — household B payment list must be empty');

    const snapB = deriveDebtSnapshot(
      { ...debtB, balanceAuthority: resolveDebtBalanceAuthority({ debt: debtB }) },
      paymentsB, [], '2026-10-01',
    );
    assert.equal(snapB.currentBalance, '3000.00',
      'SECURITY_DEFECT — household B balance must be unchanged by household A payment');
  });

  test('10.3 — createDebt for household B does not appear in household A query', async () => {
    await makeDebt(db, HOUSEHOLD_B, { name: 'B-only Debt', startingBalance: '500.00' });
    const resultA = await listDebts({ db, householdId: HOUSEHOLD_ID });
    assert.equal(resultA.items.length, 0,
      'SECURITY_DEFECT — household A must not see household B debts');
  });
});

// ---------------------------------------------------------------------------
// Section 11: Deactivation and Deletion (Steps 39–42)
// ---------------------------------------------------------------------------
describe('11. Debt deactivation and deletion behavior', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  test('11.1 — isActive=false debt has paymentPace=null and paymentObligation=null', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, {
      startingBalance: '5000.00',
      monthlyPayment: '150.00',
      statementDay: 1,
      paymentDueDay: 15,
    });
    await updateDebt({
      db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID,
      input: { isActive: false },
    });

    const result = await listDebts({ db, householdId: HOUSEHOLD_ID });
    const item = result.items[0];
    assert.equal(item.isActive, false);
    assert.equal(item.paymentPace, null, 'inactive debt must not have payment pace');
    assert.equal(item.paymentObligation, null, 'inactive debt must not have payment obligation');
  });

  test('11.2 — Zero or sub-cent balance → status = paid_off', () => {
    const debt = {
      id: 'debt_paidoff',
      householdId: HOUSEHOLD_ID,
      startingBalance: '500.00',
      apr: 0,
      monthlyPayment: '100.00',
      minimumPayment: '50.00',
      isActive: true,
    };
    const payments = [
      { id: 'p1', debtId: debt.id, amount: '500.00', paymentDate: '2026-01-15' },
    ];
    const snap = deriveDebtSnapshot(
      { ...debt, balanceAuthority: resolveDebtBalanceAuthority({ debt }) },
      payments, [], '2026-02-01',
    );
    assert.equal(snap.status, 'paid_off');
    assert.equal(snap.currentBalance, '0.00');
  });

  test('11.3 — Delete debt with no payments succeeds', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '100.00' });
    await deleteDebt({ db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID });
    const result = await listDebts({ db, householdId: HOUSEHOLD_ID });
    assert.equal(result.items.length, 0, 'debt must be gone after delete');
  });

  test('11.4 — Delete debt with payments → 422 error', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00' });
    await insertPayment(db, { householdId: HOUSEHOLD_ID, debtId: debt.id, amount: '100.00', paymentDate: '2026-01-10' });
    await assert.rejects(
      () => deleteDebt({ db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID }),
      (err) => {
        assert.equal(err.status, 422);
        assert.ok(/linked payments/i.test(err.message));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Section 12: Schema Boundary Validation (Steps 43–45)
// ---------------------------------------------------------------------------
describe('12. Debt schema boundary validation', () => {
  let db;
  beforeEach(() => { db = createInMemoryDb(); });

  test('12.1 — Missing name → 400', async () => {
    await assert.rejects(
      () => createDebt({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { startingBalance: '100.00', apr: 0, minimumPayment: '10.00', monthlyPayment: '50.00' } }),
      (err) => { assert.equal(err.status, 400); return true; },
    );
  });

  test('12.2 — startingBalance=0 → 400 (must be positive)', async () => {
    await assert.rejects(
      () => createDebt({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { name: 'Debt', startingBalance: '0.00', apr: 0, minimumPayment: '10.00', monthlyPayment: '50.00' } }),
      (err) => { assert.equal(err.status, 400); return true; },
    );
  });

  test('12.3 — apr > 100 → 400', async () => {
    await assert.rejects(
      () => createDebt({ db, householdId: HOUSEHOLD_ID, userId: USER_ID, input: { name: 'Debt', startingBalance: '100.00', apr: 150, minimumPayment: '10.00', monthlyPayment: '50.00' } }),
      (err) => { assert.equal(err.status, 400); return true; },
    );
  });

  test('12.4 — updateDebt with startingBalance → 422 (immutable field)', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00' });
    await assert.rejects(
      () => updateDebt({ db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID, input: { startingBalance: '2000.00' } }),
      (err) => { assert.equal(err.status, 422); return true; },
    );
  });

  test('12.5 — Zero-adjustment amount → 400', async () => {
    const debt = await makeDebt(db, HOUSEHOLD_ID, { startingBalance: '1000.00' });
    await assert.rejects(
      () => createDebtAdjustment({ db, householdId: HOUSEHOLD_ID, debtId: debt.id, userId: USER_ID, input: { amount: '0.00', adjustmentType: 'correction', effectiveDate: '2026-01-01', note: 'zero' } }),
      (err) => { assert.equal(err.status, 400); return true; },
    );
  });
});
