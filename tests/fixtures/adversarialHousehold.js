/**
 * RAF Adversarial Household Fixture — Phase 2
 *
 * Defines the deterministic 12-month household (2026-01 through 2026-12)
 * used for adversarial financial stress testing.
 *
 * This file defines STRUCTURE only.
 * It does NOT materialize data into the database.
 * It does NOT execute production workflows.
 *
 * See: adversarialHouseholdExpected.js for expected financial state.
 * See: tests/adversarialSeed.test.js for materialization and validation.
 */

// ─────────────────────────────────────────────────────────────────────────
// DETERMINISTIC IDs
// ─────────────────────────────────────────────────────────────────────────

export const FIXED_IDS = {
  // Workspaces
  workspace_a: 'workspace_a_00000000000000000000000001',
  workspace_b: 'workspace_b_00000000000000000000000001',
  workspace_c: 'workspace_c_00000000000000000000000001',

  // Users
  user_alice: 'user_alice_0000000000000000000000001',
  user_bob: 'user_bob_00000000000000000000000001',
  user_charlie: 'user_charlie_000000000000000000001',
  user_diana: 'user_diana_0000000000000000000001',

  // Workspace A — Primary Household
  account_chequing_a: 'account_chequing_a_000000000000001',
  account_savings_a: 'account_savings_a_000000000000001',
  account_goal_resp_a: 'account_goal_resp_a_00000000001',
  account_cc_visa_a: 'account_cc_visa_a_00000000001',
  account_loc_bmo_a: 'account_loc_bmo_a_000000000001',

  debt_visa_a: 'debt_visa_a_00000000000000000001',
  debt_loc_a: 'debt_loc_a_000000000000000001',
  debt_car_a: 'debt_car_a_000000000000000001',

  goal_education_a: 'goal_education_a_0000000000001',
  goal_emergency_a: 'goal_emergency_a_0000000000001',

  // Workspace B — Isolation test
  account_primary_b: 'account_primary_b_000000000001',
  debt_visa_b: 'debt_visa_b_00000000000000001',
  goal_savings_b: 'goal_savings_b_000000000000001',

  // Workspace C — Minimal isolation test
  account_primary_c: 'account_primary_c_000000000001',
};

// ─────────────────────────────────────────────────────────────────────────
// DETERMINISTIC DATES
// ─────────────────────────────────────────────────────────────────────────

export const FIXED_DATES = {
  testNow: '2026-09-16', // Phase 1 baseline date
  year2026Start: '2026-01-01',
  year2026End: '2026-12-31',

  // Month anchors (month-start dates)
  m202601: '2026-01-01',
  m202602: '2026-02-01',
  m202603: '2026-03-01',
  m202604: '2026-04-01',
  m202605: '2026-05-01',
  m202606: '2026-06-01',
  m202607: '2026-07-01',
  m202608: '2026-08-01',
  m202609: '2026-09-01',
  m202610: '2026-10-01',
  m202611: '2026-11-01',
  m202612: '2026-12-01',
};

// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────

export const workspaceA = {
  id: FIXED_IDS.workspace_a,
  ownerUserId: FIXED_IDS.user_alice,
  name: 'Alice and Bob Household',
  type: 'household',
  defaultCurrency: 'CAD',
  timezone: 'America/Toronto',
  country: 'CA',
  activeMonth: FIXED_DATES.m202609, // Current month for testing
};

export const workspaceB = {
  id: FIXED_IDS.workspace_b,
  ownerUserId: FIXED_IDS.user_charlie,
  name: 'Charlie Household',
  type: 'household',
  defaultCurrency: 'CAD',
  timezone: 'America/Toronto',
  country: 'CA',
  activeMonth: FIXED_DATES.m202609,
};

export const workspaceC = {
  id: FIXED_IDS.workspace_c,
  ownerUserId: FIXED_IDS.user_diana,
  name: 'Diana Household',
  type: 'household',
  defaultCurrency: 'CAD',
  timezone: 'America/Toronto',
  country: 'CA',
  activeMonth: FIXED_DATES.m202609,
};

// ─────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────

export const users = [
  {
    id: FIXED_IDS.user_alice,
    email: 'alice@example.test',
    passwordHash: null, // Not relevant for adversarial testing
  },
  {
    id: FIXED_IDS.user_bob,
    email: 'bob@example.test',
    passwordHash: null,
  },
  {
    id: FIXED_IDS.user_charlie,
    email: 'charlie@example.test',
    passwordHash: null,
  },
  {
    id: FIXED_IDS.user_diana,
    email: 'diana@example.test',
    passwordHash: null,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE MEMBERSHIPS
// ─────────────────────────────────────────────────────────────────────────

export const memberships = [
  // Workspace A
  { workspaceId: FIXED_IDS.workspace_a, userId: FIXED_IDS.user_alice, role: 'owner', status: 'active' },
  { workspaceId: FIXED_IDS.workspace_a, userId: FIXED_IDS.user_bob, role: 'member', status: 'active' },

  // Workspace B
  { workspaceId: FIXED_IDS.workspace_b, userId: FIXED_IDS.user_charlie, role: 'owner', status: 'active' },

  // Workspace C
  { workspaceId: FIXED_IDS.workspace_c, userId: FIXED_IDS.user_diana, role: 'owner', status: 'active' },
];

// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE A — FINANCIAL ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────

export const accountsA = [
  {
    id: FIXED_IDS.account_chequing_a,
    householdId: FIXED_IDS.workspace_a,
    workspaceId: FIXED_IDS.workspace_a,
    name: 'Primary Checking',
    accountType: 'checking',
    institution: 'BMO',
    currency: 'CAD',
    currentBalance: '4250.00', // As of 2026-09-16
    availableBalance: '4250.00',
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
  {
    id: FIXED_IDS.account_savings_a,
    householdId: FIXED_IDS.workspace_a,
    workspaceId: FIXED_IDS.workspace_a,
    name: 'Emergency Fund',
    accountType: 'savings',
    institution: 'BMO',
    currency: 'CAD',
    currentBalance: '2800.00',
    availableBalance: '2800.00',
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
  {
    id: FIXED_IDS.account_goal_resp_a,
    householdId: FIXED_IDS.workspace_a,
    workspaceId: FIXED_IDS.workspace_a,
    name: 'RESP Education Goal',
    accountType: 'savings',
    institution: 'CIBC',
    currency: 'CAD',
    currentBalance: '550.00',
    availableBalance: '550.00',
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
  {
    id: FIXED_IDS.account_cc_visa_a,
    householdId: FIXED_IDS.workspace_a,
    workspaceId: FIXED_IDS.workspace_a,
    name: 'Visa Card',
    accountType: 'credit_card',
    institution: 'Visa',
    currency: 'CAD',
    currentBalance: '950.00', // Liability (positive = owed)
    availableBalance: null,
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
  {
    id: FIXED_IDS.account_loc_bmo_a,
    householdId: FIXED_IDS.workspace_a,
    workspaceId: FIXED_IDS.workspace_a,
    name: 'Line of Credit',
    accountType: 'line_of_credit',
    institution: 'BMO',
    currency: 'CAD',
    currentBalance: '4850.00', // Liability
    availableBalance: null,
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE A — DEBTS
// ─────────────────────────────────────────────────────────────────────────

export const debtsA = [
  {
    id: FIXED_IDS.debt_visa_a,
    householdId: FIXED_IDS.workspace_a,
    name: 'Visa Card',
    startingBalance: '0.00',
    apr: '19.99',
    minimumPayment: '50.00',
    monthlyPayment: '150.00',
    statementDay: 1,
    paymentDueDay: 20,
    isActive: true,
    financialAccountId: FIXED_IDS.account_cc_visa_a, // LINKED
    sortOrder: 1,
  },
  {
    id: FIXED_IDS.debt_loc_a,
    householdId: FIXED_IDS.workspace_a,
    name: 'Line of Credit',
    startingBalance: '5000.00',
    apr: '7.20',
    minimumPayment: '100.00',
    monthlyPayment: '500.00',
    statementDay: 5,
    paymentDueDay: 25,
    isActive: true,
    financialAccountId: FIXED_IDS.account_loc_bmo_a, // LINKED
    sortOrder: 2,
  },
  {
    id: FIXED_IDS.debt_car_a,
    householdId: FIXED_IDS.workspace_a,
    name: 'Car Loan',
    startingBalance: '15000.00',
    apr: '4.99',
    minimumPayment: '0.00',
    monthlyPayment: '350.00',
    isActive: true,
    financialAccountId: null, // MANUAL (not linked)
    sortOrder: 3,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE A — GOALS
// ─────────────────────────────────────────────────────────────────────────

export const goalsA = [
  {
    id: FIXED_IDS.goal_education_a,
    householdId: FIXED_IDS.workspace_a,
    name: 'Education Fund',
    targetAmount: '2000.00',
    currentProgress: '550.00',
    linkedAccountId: FIXED_IDS.account_goal_resp_a,
    linkedCategorySlug: null,
    type: 'savings',
  },
  {
    id: FIXED_IDS.goal_emergency_a,
    householdId: FIXED_IDS.workspace_a,
    name: 'Emergency Fund',
    targetAmount: '6000.00',
    currentProgress: '2800.00', // Linked to account_savings_a
    linkedAccountId: FIXED_IDS.account_savings_a,
    linkedCategorySlug: null,
    type: 'savings',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE B & C — COLLISION DATA (same names/amounts, different ownership)
// ─────────────────────────────────────────────────────────────────────────

export const accountsB = [
  {
    id: FIXED_IDS.account_primary_b,
    householdId: FIXED_IDS.workspace_b,
    workspaceId: FIXED_IDS.workspace_b,
    name: 'Primary Checking', // SAME NAME as workspace_a
    accountType: 'checking',
    institution: 'BMO',
    currency: 'CAD',
    currentBalance: '3500.00',
    availableBalance: '3500.00',
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
];

export const debtsB = [
  {
    id: FIXED_IDS.debt_visa_b,
    householdId: FIXED_IDS.workspace_b,
    name: 'Visa Card', // SAME NAME as workspace_a
    startingBalance: '0.00',
    apr: '19.99',
    minimumPayment: '50.00',
    monthlyPayment: '150.00',
    isActive: true,
    financialAccountId: null,
    sortOrder: 1,
  },
];

export const goalsB = [
  {
    id: FIXED_IDS.goal_savings_b,
    householdId: FIXED_IDS.workspace_b,
    name: 'Emergency Fund', // SAME NAME as workspace_a
    targetAmount: '5000.00',
    currentProgress: '2000.00',
    linkedAccountId: null,
    linkedCategorySlug: null,
    type: 'savings',
  },
];

export const accountsC = [
  {
    id: FIXED_IDS.account_primary_c,
    householdId: FIXED_IDS.workspace_c,
    workspaceId: FIXED_IDS.workspace_c,
    name: 'Checking Account',
    accountType: 'checking',
    institution: 'CIBC',
    currency: 'CAD',
    currentBalance: '1000.00',
    availableBalance: '1000.00',
    balanceAsOf: FIXED_DATES.testNow,
    isManual: false,
    status: 'active',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 12-MONTH EVENT CATALOG
// ─────────────────────────────────────────────────────────────────────────

/**
 * Each month defines a purpose and expected events.
 * This is STRUCTURAL METADATA ONLY.
 * Individual events are NOT created as separate objects yet.
 * Phase 3 will execute these events through production workflows.
 * Phase 2 only materializes the base fixture.
 */

export const monthlyEvents = {
  '2026-01': {
    purpose: 'Baseline — stable income and allocations',
    expectedSummary: {
      incomeReceived: '3000.00',
      totalSpending: '1195.00',
      allocationsCovered: true,
      deferredToPhase3: [
        'Actual transaction creation',
        'Allocation computation',
        'Buffer behavior',
      ],
    },
  },

  '2026-02': {
    purpose: 'Bonus income and overspending pressure',
    expectedSummary: {
      incomeReceived: '3500.00', // +$500 bonus
      totalSpending: '1720.00', // Overspending in utilities and groceries
      allocationsCovered: false, // Deficit expected
      deferredToPhase3: ['Deficit candidate logic', 'Surplus allocation'],
    },
  },

  '2026-03': {
    purpose: 'Reconciliation after discrepancy',
    expectedSummary: {
      incomeReceived: '3000.00',
      totalSpending: '950.00',
      allocationsCovered: true,
      deferredToPhase3: [
        'Reconciliation workflow',
        'Adjustment transaction creation',
        'Balance authority verification',
      ],
    },
  },

  '2026-04': {
    purpose: 'Import duplicate detection',
    expectedSummary: {
      incomeReceived: '3000.00',
      totalSpending: '1180.00',
      importBatchesExpected: 2,
      duplicateDetectionNeeded: true,
      deferredToPhase3: [
        'Import approval workflow',
        'Duplicate flagging',
        'Transaction creation from import',
      ],
    },
  },

  '2026-05': {
    purpose: 'Late income and allocation catch-up',
    expectedSummary: {
      incomeExpected: '3000.00',
      incomeReceivedDate: '2026-05-20', // Late (expected 2026-05-15)
      totalSpending: '1200.00',
      allocationsCovered: true,
      deferredToPhase3: [
        'Late income allocation',
        'Plan coverage with delayed receipt',
      ],
    },
  },

  '2026-06': {
    purpose: 'Revolving debt balance growth',
    expectedSummary: {
      incomeReceived: '3000.00',
      creditCardCharges: '395.00',
      creditCardPayment: '150.00',
      creditCardEndingBalance: '253.00',
      debtAuthorityTest: 'account-backed',
      deferredToPhase3: [
        'Actual transaction flow to account',
        'Balance authority verification',
      ],
    },
  },

  '2026-07': {
    purpose: 'CRITICAL: Debt trajectory independence test',
    expectedSummary: {
      creditCardOpeningBalance: '253.00',
      creditCardCharges: '400.00',
      creditCardPaymentAmount: '400.00', // ABOVE plan ($150)
      creditCardPaymentPace: 'above_plan',
      interestAccrued: '~35.00',
      creditCardEndingBalance: '296.00', // RISING despite above-plan payment
      balanceTrajectory: 'increasing',
      expectedState:
        'paymentPace=above_plan AND trajectory=increasing must BOTH be true',
      deferredToPhase3: [
        'Verify classifyPaymentPace correctly identifies above_plan',
        'Verify deriveBalanceTrajectory correctly identifies increasing',
        'Verify these are independent (not coupled)',
      ],
    },
  },

  '2026-08': {
    purpose: 'Monthly close and immutability',
    expectedSummary: {
      incomeReceived: '3000.00',
      totalSpending: '1100.00',
      surplusAmount: '1900.00',
      monthClosureExpected: true,
      deferredToPhase3: [
        'Apply monthly review',
        'Verify closed month immutability',
        'Reopen/reclose workflow',
      ],
    },
  },

  '2026-09': {
    purpose: 'Test month — still open (no close yet)',
    expectedSummary: {
      status: 'OPEN',
      reason: 'Current active month; not yet reviewed',
      deferredToPhase3: ['All 2026-09 testing'],
    },
  },

  '2026-10': {
    purpose: 'Forecast projection (read-only)',
    expectedSummary: {
      forecastDays: 30,
      forecastStartDate: '2026-09-16',
      expectedIncome: '3000.00',
      expectedSpending: '~1100.00',
      mutationExpected: false,
      deferredToPhase3: [
        'Forecast computation',
        'Mutation denial test',
      ],
    },
  },

  '2026-11': {
    purpose: 'Goal withdrawal and linked transaction deletion',
    expectedSummary: {
      goalProgressBefore: '550.00',
      withdrawalAmount: '100.00',
      withdrawalTransactionDeleted: true,
      goalProgressAfter: 'should recalculate',
      deferredToPhase3: [
        'Withdrawal transaction',
        'Goal recalculation',
        'Progress integrity verification',
      ],
    },
  },

  '2026-12': {
    purpose: 'Year-end reconciliation and adjustment',
    expectedSummary: {
      statementBalance: '4100.00',
      calculatedBalance: '4050.00',
      discrepancy: '+50.00',
      adjustmentNeeded: true,
      adjustmentDescription: 'Interest credit from bank',
      deferredToPhase3: [
        'Reconciliation workflow',
        'Adjustment transaction',
        'Year-end balance verification',
      ],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// ALLOCATION CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────

/**
 * RAF's inMemoryDb() provides DEFAULT allocation categories and surplus splits.
 * Phase 2 does NOT override them; Phase 2 validates they exist and are coherent.
 *
 * See: lib/server/inMemoryDb.js:defaultAllocationCategories()
 * Provided categories:
 *   - Savings (10%)
 *   - Fixed Bills (30%)
 *   - Personal Spending (15%)
 *   - Investment (10%)
 *   - Debt Payoff (10%)
 *   - Partnership (15%)
 *   - Buffer (10%, isBuffer=true)
 *
 * Total: 100%
 */

export const expectedAllocationConfig = {
  categories: {
    savings: { allocationPercent: '0.1000', isBuffer: false },
    fixed_bills: { allocationPercent: '0.3000', isBuffer: false },
    personal_spending: { allocationPercent: '0.1500', isBuffer: false },
    investment: { allocationPercent: '0.1000', isBuffer: false },
    debt_payoff: { allocationPercent: '0.1000', isBuffer: false },
    partnership: { allocationPercent: '0.1500', isBuffer: false },
    buffer: { allocationPercent: '0.1000', isBuffer: true },
  },
  percentageCheck: {
    sum: '1.0000',
    note: 'Sum must equal exactly 1.0000 (no rounding tolerance)',
  },
  surplusSplits: {
    emergency_fund: { splitPercent: '0.4000' },
    extra_debt_payoff: { splitPercent: '0.4000' },
    investment: { splitPercent: '0.2000' },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// FIXTURE SUMMARY
// ─────────────────────────────────────────────────────────────────────────

export const FIXTURE_COUNTS = {
  workspaces: 3,
  users: 4,
  memberships: 4,
  accounts: {
    workspace_a: 5,
    workspace_b: 1,
    workspace_c: 1,
    total: 7,
  },
  debts: {
    workspace_a: 3,
    workspace_b: 1,
    total: 4,
  },
  goals: {
    workspace_a: 2,
    workspace_b: 1,
    total: 3,
  },
};
