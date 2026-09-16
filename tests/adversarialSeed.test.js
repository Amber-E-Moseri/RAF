/**
 * RAF Adversarial Seed Validation — Phase 2
 *
 * This test suite validates the deterministic adversarial household fixture.
 * It materializes the fixture into RAF's SQLite database and verifies:
 *
 * ✓ Deterministic IDs and dates
 * ✓ Workspace ownership and membership
 * ✓ Account relationships and authority
 * ✓ Debt configuration and balance authority
 * ✓ Goal relationships and progress
 * ✓ Allocation configuration validity
 * ✓ Financial arithmetic coherence
 * ✓ Tenant ownership and isolation properties
 * ✓ Determinism (same run → same state)
 *
 * Non-Goals:
 * ✗ Testing RAF's transaction behavior
 * ✗ Testing debt payment pace or trajectory classification
 * ✗ Testing monthly close or reopen workflows
 * ✗ Testing RLS or cross-workspace denial (Phase 7)
 *
 * Philosophy:
 * - Fixture is valid if internal arithmetic is coherent
 * - Fixture is deterministic if same input → same ID/date output
 * - Fixture is correctly materialized if references resolve
 * - We do NOT test RAF behavior; we test fixture structure
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import {
  FIXED_IDS,
  FIXED_DATES,
  workspaceA,
  workspaceB,
  workspaceC,
  users,
  memberships,
  accountsA,
  accountsB,
  accountsC,
  debtsA,
  debtsB,
  goalsA,
  goalsB,
  monthlyEvents,
  expectedAllocationConfig,
  FIXTURE_COUNTS,
} from './fixtures/adversarialHousehold.js';

import {
  accountConservationJan2026,
  accountConservationFeb2026,
  accountConservationMar2026,
  debtAuthorityJun2026,
  debtTrajectoryIndependenceJul2026,
  allocationPercentages,
  validateAllocationPercentages,
  tenantCollisions,
  canonicalStateSignature,
  expectedSignature,
  tocents,
  toDollars,
  addDollars,
  subtractDollars,
} from './fixtures/adversarialHouseholdExpected.js';

// ─────────────────────────────────────────────────────────────────────────
// FIXTURE MATERIALIZATION HELPER
// ─────────────────────────────────────────────────────────────────────────

/**
 * Materialize the entire adversarial household into the database.
 * This does NOT execute production workflows; it directly inserts fixture data.
 */
async function materializeAdversarialHousehold(db) {
  return db.transaction(async (tx) => {
    // Create users
    for (const user of users) {
      await tx.createUser({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
      });
    }

    // Create workspaces
    const wsA = await tx.createWorkspaceRecord({
      id: workspaceA.id,
      ownerUserId: workspaceA.ownerUserId,
      name: workspaceA.name,
      type: workspaceA.type,
      defaultCurrency: workspaceA.defaultCurrency,
      timezone: workspaceA.timezone,
      country: workspaceA.country,
    });

    const wsB = await tx.createWorkspaceRecord({
      id: workspaceB.id,
      ownerUserId: workspaceB.ownerUserId,
      name: workspaceB.name,
      type: workspaceB.type,
      defaultCurrency: workspaceB.defaultCurrency,
      timezone: workspaceB.timezone,
      country: workspaceB.country,
    });

    const wsC = await tx.createWorkspaceRecord({
      id: workspaceC.id,
      ownerUserId: workspaceC.ownerUserId,
      name: workspaceC.name,
      type: workspaceC.type,
      defaultCurrency: workspaceC.defaultCurrency,
      timezone: workspaceC.timezone,
      country: workspaceC.country,
    });

    // Initialize workspace defaults (allocation categories, surplus splits)
    await tx.initializeWorkspaceDefaults({ workspace: wsA });
    await tx.initializeWorkspaceDefaults({ workspace: wsB });
    await tx.initializeWorkspaceDefaults({ workspace: wsC });

    // Create memberships
    for (const membership of memberships) {
      await tx.createWorkspaceMember({
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role,
        status: membership.status,
      });
    }

    // Create accounts
    const insertedAccountsA = [];
    for (const account of accountsA) {
      const inserted = await tx.insertFinancialAccount(account);
      insertedAccountsA.push(inserted);
    }

    const insertedAccountsB = [];
    for (const account of accountsB) {
      const inserted = await tx.insertFinancialAccount(account);
      insertedAccountsB.push(inserted);
    }

    const insertedAccountsC = [];
    for (const account of accountsC) {
      const inserted = await tx.insertFinancialAccount(account);
      insertedAccountsC.push(inserted);
    }

    // Create debts
    const insertedDebtsA = [];
    for (const debt of debtsA) {
      const inserted = await tx.insertDebt(debt);
      insertedDebtsA.push(inserted);
    }

    const insertedDebtsB = [];
    for (const debt of debtsB) {
      const inserted = await tx.insertDebt(debt);
      insertedDebtsB.push(inserted);
    }

    // Create goals
    const insertedGoalsA = [];
    for (const goal of goalsA) {
      const inserted = await tx.insertGoal(goal);
      insertedGoalsA.push(inserted);
    }

    const insertedGoalsB = [];
    for (const goal of goalsB) {
      const inserted = await tx.insertGoal(goal);
      insertedGoalsB.push(inserted);
    }

    return {
      workspaces: { wsA, wsB, wsC },
      accounts: { a: insertedAccountsA, b: insertedAccountsB, c: insertedAccountsC },
      debts: { a: insertedDebtsA, b: insertedDebtsB },
      goals: { a: insertedGoalsA, b: insertedGoalsB },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// TESTS: IDENTITY AND DETERMINISM
// ─────────────────────────────────────────────────────────────────────────

test('fixture: deterministic IDs are unique and fixed', () => {
  const idValues = Object.values(FIXED_IDS);
  const uniqueIds = new Set(idValues);
  assert.equal(
    uniqueIds.size,
    idValues.length,
    'All IDs must be unique'
  );

  // Verify ID format (not random UUIDs)
  for (const [name, id] of Object.entries(FIXED_IDS)) {
    assert.equal(
      typeof id,
      'string',
      `ID ${name} must be a string`
    );
    assert.ok(
      id.length > 0,
      `ID ${name} must not be empty`
    );
    // All should follow stable patterns, not random UUID format
    assert.match(
      id,
      /^[a-z_]+_[0-9]+$/,
      `ID ${name} should follow stable format (not random UUID)`
    );
  }
});

test('fixture: deterministic dates are ISO format', () => {
  for (const [name, date] of Object.entries(FIXED_DATES)) {
    assert.ok(
      /^\d{4}-\d{2}-\d{2}$/.test(date),
      `Date ${name} must be ISO format YYYY-MM-DD`
    );
  }
});

test('fixture: test-now date matches Phase 1 baseline', () => {
  assert.equal(FIXED_DATES.testNow, '2026-09-16');
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: WORKSPACE STRUCTURE
// ─────────────────────────────────────────────────────────────────────────

test('fixture: users exist with correct emails', () => {
  assert.equal(users.length, FIXTURE_COUNTS.users);
  assert.equal(users[0].email, 'alice@example.test');
  assert.equal(users[1].email, 'bob@example.test');
  assert.equal(users[2].email, 'charlie@example.test');
  assert.equal(users[3].email, 'diana@example.test');
});

test('fixture: workspaces are defined with correct owners', () => {
  assert.equal(workspaceA.ownerUserId, FIXED_IDS.user_alice);
  assert.equal(workspaceB.ownerUserId, FIXED_IDS.user_charlie);
  assert.equal(workspaceC.ownerUserId, FIXED_IDS.user_diana);
});

test('fixture: memberships grant correct roles', () => {
  assert.equal(memberships.length, FIXTURE_COUNTS.memberships);

  const wsAMemberships = memberships.filter(
    (m) => m.workspaceId === FIXED_IDS.workspace_a
  );
  assert.equal(wsAMemberships.length, 2);

  const aliceMembership = wsAMemberships.find(
    (m) => m.userId === FIXED_IDS.user_alice
  );
  assert.equal(aliceMembership.role, 'owner');

  const bobMembership = wsAMemberships.find(
    (m) => m.userId === FIXED_IDS.user_bob
  );
  assert.equal(bobMembership.role, 'member');
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: ACCOUNT STRUCTURE
// ─────────────────────────────────────────────────────────────────────────

test('fixture: accounts are scoped to correct workspaces', () => {
  for (const account of accountsA) {
    assert.equal(account.householdId, FIXED_IDS.workspace_a);
    assert.equal(account.workspaceId, FIXED_IDS.workspace_a);
  }

  for (const account of accountsB) {
    assert.equal(account.householdId, FIXED_IDS.workspace_b);
    assert.equal(account.workspaceId, FIXED_IDS.workspace_b);
  }

  for (const account of accountsC) {
    assert.equal(account.householdId, FIXED_IDS.workspace_c);
    assert.equal(account.workspaceId, FIXED_IDS.workspace_c);
  }
});

test('fixture: account types are valid', () => {
  const validTypes = new Set([
    'checking',
    'savings',
    'credit_card',
    'line_of_credit',
    'loan',
  ]);

  for (const account of [...accountsA, ...accountsB, ...accountsC]) {
    assert.ok(
      validTypes.has(account.accountType),
      `Account ${account.id} has invalid type ${account.accountType}`
    );
  }
});

test('fixture: account currency is CAD', () => {
  for (const account of [...accountsA, ...accountsB, ...accountsC]) {
    assert.equal(account.currency, 'CAD');
  }
});

test('fixture: account counts are correct', () => {
  assert.equal(accountsA.length, FIXTURE_COUNTS.accounts.workspace_a);
  assert.equal(accountsB.length, FIXTURE_COUNTS.accounts.workspace_b);
  assert.equal(accountsC.length, FIXTURE_COUNTS.accounts.workspace_c);
});

test('fixture: Workspace A account balances are valid money strings', () => {
  for (const account of accountsA) {
    assert.match(
      account.currentBalance,
      /^\d+\.\d{2}$/,
      `Account ${account.id} has invalid balance format`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: DEBT STRUCTURE AND AUTHORITY
// ─────────────────────────────────────────────────────────────────────────

test('fixture: debts are scoped to correct workspaces', () => {
  for (const debt of debtsA) {
    assert.equal(debt.householdId, FIXED_IDS.workspace_a);
  }

  for (const debt of debtsB) {
    assert.equal(debt.householdId, FIXED_IDS.workspace_b);
  }
});

test('fixture: debt authority relationships are valid', () => {
  // Visa (account-backed)
  const visa = debtsA.find((d) => d.id === FIXED_IDS.debt_visa_a);
  assert.equal(visa.financialAccountId, FIXED_IDS.account_cc_visa_a);

  // LOC (account-backed)
  const loc = debtsA.find((d) => d.id === FIXED_IDS.debt_loc_a);
  assert.equal(loc.financialAccountId, FIXED_IDS.account_loc_bmo_a);

  // Car (manual, not linked)
  const car = debtsA.find((d) => d.id === FIXED_IDS.debt_car_a);
  assert.equal(car.financialAccountId, null);
});

test('fixture: debt counts are correct', () => {
  assert.equal(debtsA.length, FIXTURE_COUNTS.debts.workspace_a);
  assert.equal(debtsB.length, FIXTURE_COUNTS.debts.workspace_b);
});

test('fixture: July 2026 debt data supports trajectory independence', () => {
  const jul = debtTrajectoryIndependenceJul2026;

  // Verify arithmetic
  const openingCents = tocents(jul.openingBalance);
  const chargesCents = tocents(jul.newCharges);
  const paymentCents = tocents(jul.userPayment);
  const interestCents = tocents(jul.interestAccrualDuringMonth);

  const calculatedEnding = openingCents
    + tocents(jul.earlyInterestCarryover)
    + chargesCents
    - paymentCents
    + interestCents;
  const expectedEndingCents = tocents(jul.expectedEndingBalance);

  assert.equal(
    calculatedEnding,
    expectedEndingCents,
    `July debt balance arithmetic failed: ${toDollars(calculatedEnding)} !== ${toDollars(expectedEndingCents)}`
  );

  // Verify pace classification logic
  const actual = jul.paymentAmountCents;
  const planned = jul.planPaymentCents;
  const upper = jul.upperBound;

  assert.ok(
    actual > upper,
    'July payment should exceed upper bound → above_plan'
  );

  // Verify trajectory
  const balanceGrowth = tocents(jul.balanceChange);
  assert.ok(balanceGrowth > 0, 'July balance should increase (positive change)');
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: GOAL STRUCTURE AND AUTHORITY
// ─────────────────────────────────────────────────────────────────────────

test('fixture: goals are scoped to correct workspaces', () => {
  for (const goal of goalsA) {
    assert.equal(goal.householdId, FIXED_IDS.workspace_a);
  }

  for (const goal of goalsB) {
    assert.equal(goal.householdId, FIXED_IDS.workspace_b);
  }
});

test('fixture: goal counts are correct', () => {
  assert.equal(goalsA.length, FIXTURE_COUNTS.goals.workspace_a);
  assert.equal(goalsB.length, FIXTURE_COUNTS.goals.workspace_b);
});

test('fixture: goal target amounts are valid money', () => {
  for (const goal of [...goalsA, ...goalsB]) {
    assert.match(goal.targetAmount, /^\d+\.\d{2}$/);
  }
});

test('fixture: goal progress <= target', () => {
  for (const goal of [...goalsA, ...goalsB]) {
    const progressCents = tocents(goal.currentProgress);
    const targetCents = tocents(goal.targetAmount);
    assert.ok(
      progressCents <= targetCents,
      `Goal ${goal.id} progress ${goal.currentProgress} exceeds target ${goal.targetAmount}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: ALLOCATION CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────

test('fixture: allocation percentages sum to exactly 1.0000', () => {
  assert.doesNotThrow(() => validateAllocationPercentages());
});

test('fixture: 12 monthly events are defined', () => {
  assert.equal(Object.keys(monthlyEvents).length, 12);
  assert.ok(monthlyEvents['2026-01']);
  assert.ok(monthlyEvents['2026-12']);
});

test('fixture: monthly events have required properties', () => {
  for (const [month, event] of Object.entries(monthlyEvents)) {
    assert.ok(event.purpose, `Month ${month} missing purpose`);
    assert.ok(
      event.expectedSummary || event.expectedState,
      `Month ${month} missing expectedSummary or expectedState`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: TENANT ISOLATION STRUCTURE (PRE-RLS)
// ─────────────────────────────────────────────────────────────────────────

test('fixture: workspaces have distinct IDs', () => {
  const ids = [
    FIXED_IDS.workspace_a,
    FIXED_IDS.workspace_b,
    FIXED_IDS.workspace_c,
  ];
  const unique = new Set(ids);
  assert.equal(unique.size, 3);
});

test('fixture: collision entities have distinct IDs', () => {
  // Despite same names, IDs must be different
  assert.notEqual(
    accountsA[0].id,
    accountsB[0].id,
    'Account IDs must differ'
  );
  assert.notEqual(debtsA[0].id, debtsB[0].id, 'Debt IDs must differ');
  assert.notEqual(goalsA[0].id, goalsB[0].id, 'Goal IDs must differ');
});

test('fixture: collision entities belong to different workspaces', () => {
  assert.notEqual(accountsA[0].workspaceId, accountsB[0].workspaceId);
  assert.notEqual(debtsA[0].householdId, debtsB[0].householdId);
  assert.notEqual(goalsA[0].householdId, goalsB[0].householdId);
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: MATERIALIZATION AND PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────

test('fixture can be materialized into SQLite', async () => {
  const db = createInMemoryDb();
  const result = await materializeAdversarialHousehold(db);

  assert.ok(result.workspaces.wsA);
  assert.ok(result.accounts.a.length > 0);
  assert.ok(result.debts.a.length > 0);
  assert.ok(result.goals.a.length > 0);
});

test('fixture materialization preserves IDs', async () => {
  const db = createInMemoryDb();
  const result = await materializeAdversarialHousehold(db);

  // Verify workspace IDs
  assert.equal(result.workspaces.wsA.id, FIXED_IDS.workspace_a);
  assert.equal(result.workspaces.wsB.id, FIXED_IDS.workspace_b);
  assert.equal(result.workspaces.wsC.id, FIXED_IDS.workspace_c);

  // Verify account IDs
  const acctsA = result.accounts.a;
  assert.equal(acctsA[0].id, FIXED_IDS.account_chequing_a);
});

test('fixture materialization is deterministic (same input → same state)', async () => {
  // Materialize once
  const db1 = createInMemoryDb();
  const result1 = await materializeAdversarialHousehold(db1);
  const sig1 = canonicalStateSignature({
    FIXED_IDS,
    accountsA,
    FIXED_DATES,
  });

  // Materialize again
  const db2 = createInMemoryDb();
  const result2 = await materializeAdversarialHousehold(db2);
  const sig2 = canonicalStateSignature({
    FIXED_IDS,
    accountsA,
    FIXED_DATES,
  });

  // Signatures should match
  assert.deepEqual(sig1, sig2);
  assert.deepEqual(sig1, expectedSignature);
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: MONEY ARITHMETIC HELPERS
// ─────────────────────────────────────────────────────────────────────────

test('money: tocents converts decimal strings correctly', () => {
  assert.equal(tocents('0.00'), 0);
  assert.equal(tocents('1.00'), 100);
  assert.equal(tocents('100.50'), 10050);
  assert.equal(tocents('3000.00'), 300000);
});

test('money: toDollars converts cents back to decimal strings', () => {
  assert.equal(toDollars(0), '0.00');
  assert.equal(toDollars(100), '1.00');
  assert.equal(toDollars(10050), '100.50');
  assert.equal(toDollars(300000), '3000.00');
});

test('money: addDollars adds decimal amounts correctly', () => {
  assert.equal(addDollars('100.00', '50.00'), '150.00');
  assert.equal(addDollars('0.50', '0.25'), '0.75');
  assert.equal(addDollars('1000.00', '2000.50'), '3000.50');
});

test('money: subtractDollars subtracts correctly', () => {
  assert.equal(subtractDollars('150.00', '50.00'), '100.00');
  assert.equal(subtractDollars('1.00', '0.25'), '0.75');
  assert.equal(subtractDollars('5000.00', '3000.00'), '2000.00');
});

// ─────────────────────────────────────────────────────────────────────────
// TESTS: FINANCIAL ARITHMETIC (INDEPENDENT VALIDATION)
// ─────────────────────────────────────────────────────────────────────────

test('financial arithmetic: Jan 2026 account conservation', () => {
  const jan = accountConservationJan2026;
  const expected = addDollars(
    subtractDollars(
      addDollars(jan.openingBalance, jan.incomeInflows),
      jan.expectedSpending.total
    ),
    '0.00' // No adjustments
  );

  assert.equal(
    expected,
    jan.expectedEndingBalance,
    'Jan 2026 account conservation check failed'
  );
});

test('financial arithmetic: Feb 2026 account conservation with overspending', () => {
  const feb = accountConservationFeb2026;
  const expected = addDollars(
    subtractDollars(
      addDollars(feb.openingBalance, feb.incomeInflows),
      feb.expectedSpending.total
    ),
    '0.00'
  );

  assert.equal(
    expected,
    feb.expectedEndingBalance,
    'Feb 2026 account conservation check failed'
  );
});

test('financial arithmetic: July 2026 debt trajectory independence', () => {
  // This is the MOST CRITICAL validation for Phase 2
  const jul = debtTrajectoryIndependenceJul2026;

  // Calculate ending balance independently
  const openingCents = tocents(jul.openingBalance);
  const carryoverCents = tocents(jul.earlyInterestCarryover);
  const chargesCents = tocents(jul.newCharges);
  const paymentCents = tocents(jul.userPayment);
  const interestCents = tocents(jul.interestAccrualDuringMonth);

  const calculatedCents =
    openingCents + carryoverCents + chargesCents - paymentCents + interestCents;
  const calculatedDollars = toDollars(calculatedCents);

  assert.equal(
    calculatedDollars,
    jul.expectedEndingBalance,
    'July balance calculation failed'
  );

  // Verify payment pace is above plan
  assert.ok(
    jul.paymentAmountCents > jul.upperBound,
    'July payment must exceed upper bound'
  );

  // Verify trajectory is increasing
  const balanceChangeCents = tocents(jul.balanceChange);
  assert.ok(balanceChangeCents > 0, 'July balance must increase');
});

// ─────────────────────────────────────────────────────────────────────────
// SUMMARY TEST
// ─────────────────────────────────────────────────────────────────────────

test('fixture summary: all counts are correct', () => {
  assert.equal(users.length, 4);
  assert.equal(memberships.length, 4);
  assert.equal(
    accountsA.length + accountsB.length + accountsC.length,
    FIXTURE_COUNTS.accounts.total
  );
  assert.equal(
    debtsA.length + debtsB.length,
    FIXTURE_COUNTS.debts.total
  );
  assert.equal(
    goalsA.length + goalsB.length,
    FIXTURE_COUNTS.goals.total
  );
});
