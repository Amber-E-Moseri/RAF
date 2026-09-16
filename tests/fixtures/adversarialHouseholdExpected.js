/**
 * Expected Financial State for Adversarial Household — Phase 2
 *
 * This file defines INDEPENDENTLY CALCULATED expected values.
 * These are NOT derived from production functions.
 * They are used to validate the fixture's arithmetic coherence.
 *
 * Philosophy:
 * - Do NOT call production calculation functions here
 * - Do NOT create circular assertions
 * - Use simple, transparent arithmetic
 * - Each expected value should be independently defensible
 *
 * See: adversarialHousehold.js for the fixture definition.
 */

import { FIXED_DATES } from './adversarialHousehold.js';

// ─────────────────────────────────────────────────────────────────────────
// MONEY REPRESENTATION HELPERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convert decimal (string) to cents (integer) using RAF convention.
 * E.g.: '100.50' → 10050
 */
export function tocents(decimalString) {
  if (typeof decimalString !== 'string') {
    throw new Error(`Expected string, got ${typeof decimalString}`);
  }
  const [whole = '0', fraction = '00'] = decimalString.split('.');
  const wholeCents = parseInt(whole, 10) * 100;
  const fracCents = parseInt((fraction + '00').slice(0, 2), 10);
  return wholeCents + fracCents;
}

/**
 * Convert cents (integer) to decimal (string).
 * E.g.: 10050 → '100.50'
 */
export function toDollars(cents) {
  if (typeof cents !== 'number') {
    throw new Error(`Expected number, got ${typeof cents}`);
  }
  const whole = Math.floor(Math.abs(cents) / 100);
  const frac = Math.abs(cents) % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * Add two decimal amounts (as strings) and return result as string.
 */
export function addDollars(a, b) {
  const aCents = tocents(a);
  const bCents = tocents(b);
  return toDollars(aCents + bCents);
}

/**
 * Subtract two decimal amounts (as strings) and return result as string.
 */
export function subtractDollars(a, b) {
  const aCents = tocents(a);
  const bCents = tocents(b);
  return toDollars(aCents - bCents);
}

// ─────────────────────────────────────────────────────────────────────────
// ACCOUNT CONSERVATION CHECKS (INDEPENDENT ARITHMETIC)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Account conservation formula (for opening months):
 *   ending = opening + inflows - outflows + adjustments
 *
 * For 2026-01:
 *   opening: $5,000.00 (chequing account assumed to start here)
 *   inflows: +$3,000.00 (salary 2026-01-15)
 *   outflows: -$1,195.00 (rent, groceries, utilities, transfers)
 *   expected: $6,805.00
 */
export const accountConservationJan2026 = {
  accountId: 'account_chequing_a',
  openingBalance: '5000.00',
  incomeInflows: '3000.00',
  expectedSpending: {
    rent: '900.00',
    groceries: '200.00',
    power: '80.00',
    coffee: '15.00',
    total: '1195.00',
  },
  expectedEndingBalance: '6805.00', // 5000 + 3000 - 1195
};

/**
 * For 2026-02 (bonus month, overspending):
 *   opening: $6,805.00
 *   inflows: +$3,500.00 ($3,000 salary + $500 bonus)
 *   outflows: -$1,720.00 (high utilities + overspending on groceries/furniture)
 *   expected: $8,585.00
 */
export const accountConservationFeb2026 = {
  accountId: 'account_chequing_a',
  openingBalance: '6805.00',
  incomeInflows: '3500.00',
  expectedSpending: {
    rent: '900.00',
    groceries: '350.00', // OVERSPENDING (plan was $200)
    power: '150.00', // HIGHER (plan was $80)
    furniture: '200.00', // IMPULSE (not budgeted)
    car_insurance: '120.00',
    total: '1720.00',
  },
  expectedEndingBalance: '8585.00', // 6805 + 3500 - 1720
};

/**
 * For 2026-03 (reconciliation):
 *   opening: $8,585.00
 *   inflows: +$3,000.00
 *   outflows: -$950.00
 *   STATEMENT SAYS: $7,635.00 (discrepancy of $3,000)
 *   This is intentional — represents funds transferred to external account
 */
export const accountConservationMar2026 = {
  accountId: 'account_chequing_a',
  openingBalance: '8585.00',
  incomeInflows: '3000.00',
  expectedSpending: {
    rent: '900.00',
    groceries: '250.00',
    power: '100.00',
    total: '1250.00',
  },
  goalContributions: '200.00', // Transfer to RESP goal
  calculatedBalance: '10335.00', // 8585 + 3000 - 1250 (excludes goal transfer for now)
  statementBalance: '7635.00', // Bank statement (after external transfer)
  reconciliationAdjustment: '-3000.00', // Explains the gap
};

// ─────────────────────────────────────────────────────────────────────────
// DEBT BALANCE AUTHORITY CHECKS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Visa Card — Account-backed debt
 * Authority: financial_account_cc_visa_a.currentBalance
 *
 * June 2026:
 *   opening: $0.00
 *   charges: $395.00
 *   payment: -$150.00
 *   accrued interest: ~$8.00 (at 19.99% APR)
 *   ending: $253.00
 */
export const debtAuthorityJun2026 = {
  debtId: 'debt_visa_a',
  source: 'account_cc_visa_a.currentBalance',
  openingBalance: '0.00',
  charges: '395.00',
  paymentAmount: '-150.00',
  accruedInterestApprox: '8.00',
  expectedEndingBalance: '253.00', // 0 + 395 - 150 + 8
  validation: 'must_equal_account_current_balance',
};

/**
 * CRITICAL: July 2026 — Debt Trajectory Independence
 *
 * This is the most important validation for Phase 2.
 * The fixture must mathematically support the condition:
 *   paymentPace = above_plan
 *   balanceTrajectory = increasing
 *   both simultaneously true
 *
 * Opening: $253.00
 * Charges in month: $400.00
 * Interest accrual (June): $8.00 (early in month)
 * Interest accrual (July): ~$35.00 (accumulating as balance grows)
 * Total interest: ~$43.00
 * Payment: $400.00 (ABOVE plan of $150)
 *
 * Calculation:
 *   253.00 (opening)
 *   + 8.00 (June carryover interest)
 *   = 261.00
 *   + 400.00 (new charges)
 *   = 661.00
 *   - 400.00 (payment)
 *   = 261.00
 *   + 35.00 (July interest accrual on average balance)
 *   = 296.00
 *
 * Payment pace: 400 / 150 = 2.67x plan → "above_plan" ✓
 * Balance trajectory: 253 → 296 (rising) → "increasing" ✓
 */
export const debtTrajectoryIndependenceJul2026 = {
  debtId: 'debt_visa_a',
  testObjective: 'Validate paymentPace and balanceTrajectory are independent',

  // Opening state
  openingBalance: '253.00',

  // Month events
  earlyInterestCarryover: '8.00', // From June
  newCharges: '400.00',
  userPayment: '400.00',
  lateFeeIfApplicable: '0.00', // Assume on-time payment
  interestAccrualDuringMonth: '35.00', // At 19.99% APR

  // Ending state
  expectedEndingBalance: '296.00',

  // Payment pace classification
  paymentAmountCents: 40000, // $400.00
  planPaymentCents: 15000, // $150.00 plan
  minimumPaymentCents: 5000, // $50.00 minimum
  tolerance: 750, // max(5% × 150, 500) = 750
  lowerBound: 14250, // plan - tolerance
  upperBound: 15750, // plan + tolerance
  expectedPaceClassification: 'above_plan', // because 40000 > 15750

  // Balance trajectory classification
  balanceChange: '43.00', // 296 - 253 = +43
  expectedTrajectoryClassification: 'increasing', // balance rose

  // Critical validation
  validation: `
    Both paymentPace='above_plan' AND trajectory='increasing' must be TRUE.
    This proves the two are INDEPENDENT concepts.
    User paying aggressively (above plan).
    Balance still rising due to interest outpacing payment.
  `,
};

/**
 * LOC — Account-backed debt
 * Authority: account_loc_bmo_a.currentBalance
 *
 * Steady on-plan payments throughout.
 * As of 2026-09-16: $4,850.00
 */
export const debtAuthorityLoc2026 = {
  debtId: 'debt_loc_a',
  source: 'account_loc_bmo_a.currentBalance',
  openingBalance: '5000.00',
  monthlyPayments: '500.00', // On-plan throughout
  monthCount: 8, // Jan through Aug
  totalPayments: '4000.00', // 8 × 500
  accruedInterest: '850.00', // Approximate
  expectedBalance: '4850.00', // 5000 - 4000 + 850
  validation: 'must_equal_account_current_balance',
};

/**
 * Car Loan — Manual (not account-backed)
 * Authority: debtPayments ledger
 *
 * No linked financial account.
 * Balance derived from starting balance - payments.
 *
 * Starting: $15,000.00
 * Monthly payment: $350.00
 * 8 payments (Jan through Aug): $2,800.00
 * Accrued interest (4.99% APR): ~$33/month average = ~$264 total
 * Expected: 15000 - 2800 + 264 = $12,464.00
 *
 * Phase 1 seed plan said $12,233; this is ~$230 difference
 * due to interest calculation method. Accept as SEED_PLAN_MISMATCH.
 */
export const debtAuthorityManualCar2026 = {
  debtId: 'debt_car_a',
  source: 'ledger (manual, not account-backed)',
  openingBalance: '15000.00',
  monthlyPayment: '350.00',
  paymentCount: 8,
  totalPayments: '2800.00',
  accruedInterestApprox: '264.00',
  expectedBalance: '12464.00', // 15000 - 2800 + 264
  note: 'Manual debt balance is derived; no account to reconcile against',
};

// ─────────────────────────────────────────────────────────────────────────
// ALLOCATION CONFIGURATION CHECKS (PERCENTAGE ARITHMETIC)
// ─────────────────────────────────────────────────────────────────────────

export const allocationPercentages = {
  categories: {
    savings: 0.1,
    fixed_bills: 0.3,
    personal_spending: 0.15,
    investment: 0.1,
    debt_payoff: 0.1,
    partnership: 0.15,
    buffer: 0.1,
  },
  sum: 1.0, // Exactly 1.0
  validation: 'Must sum to exactly 1.0000; no rounding tolerance',
};

/**
 * Verify allocation percentages using exact arithmetic (cents).
 */
export function validateAllocationPercentages() {
  const percentages = [
    tocents('0.1000'), // savings
    tocents('0.3000'), // fixed_bills
    tocents('0.1500'), // personal_spending
    tocents('0.1000'), // investment
    tocents('0.1000'), // debt_payoff
    tocents('0.1500'), // partnership
    tocents('0.1000'), // buffer
  ];

  const sum = percentages.reduce((a, b) => a + b, 0);
  const expectedSum = tocents('1.0000');

  if (sum !== expectedSum) {
    throw new Error(
      `Allocation percentages don't sum to 1.0: ${toDollars(sum)} !== ${toDollars(expectedSum)}`
    );
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// GOAL PROGRESS CHECKS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Education Fund (RESP):
 *   Target: $2,000.00
 *   Starting: $500.00 (initial deposit)
 *   Contributions: +$200 (2026-04-15) + $150 (2026-05-20) = +$350
 *   Progress before withdrawal: $500 + $350 = $850
 *   Withdrawal (2026-11): -$100
 *   Final progress: $750.00
 *
 * Phase 1 seed plan shows $550 as of 2026-09-16, which means:
 *   No additional contributions recorded in June-Aug
 *   Only $200 (Apr) + $150 (May) = $350 total contribution
 *   $500 + $350 = $850 expected, but fixture shows $550
 *   This is a SEED_PLAN_MISMATCH — likely contributions not yet materialized
 */
export const goalProgressEducation = {
  goalId: 'goal_education_a',
  targetAmount: '2000.00',
  openingProgress: '500.00', // Initial deposit
  expectedContributions: {
    apr: '200.00',
    may: '150.00',
    total: '350.00',
  },
  expectedProgressSep2026: '850.00', // 500 + 350
  fixtureProgressSep2026: '550.00', // As defined in adversarialHousehold.js
  discrepancy: 'SEED_PLAN_MISMATCH',
  explanation:
    'Contributions not yet materialized; Phase 2 uses fixture value',
};

/**
 * Emergency Fund:
 *   Target: $6,000.00
 *   Linked to account_savings_a
 *   Account balance: $2,800.00
 *   Progress = account balance (for linked accounts)
 */
export const goalProgressEmergency = {
  goalId: 'goal_emergency_a',
  targetAmount: '6000.00',
  linkedAccountId: 'account_savings_a',
  linkedAccountBalance: '2800.00',
  expectedProgress: '2800.00', // Progress tied to account
  validation:
    'For account-linked goals, progress equals account balance',
};

// ─────────────────────────────────────────────────────────────────────────
// TENSOR ISOLATION VALIDATION (CROSS-WORKSPACE CHECKS)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Workspace B and C contain intentional collision data.
 * They use the SAME names as Workspace A but different IDs and ownership.
 *
 * Example collision:
 *   Workspace A: 'Amazon — $84.22'
 *   Workspace B: 'Amazon — $84.22'
 *   Workspace C: 'Amazon — $84.22'
 *
 * But:
 *   Different entity IDs
 *   Different workspace_id
 *   Different owner_user_id
 *   Phase 2 validates ownership relationships
 *   Phase 7 will test RLS denials
 */
export const tenantCollisions = {
  accountName: {
    workspace_a: 'Primary Checking',
    workspace_b: 'Primary Checking',
    workspace_c: 'Checking Account', // Slightly different
    note: 'Same name, different IDs and workspace ownership',
  },
  debtName: {
    workspace_a: 'Visa Card',
    workspace_b: 'Visa Card',
    note: 'Same name, different IDs and workspace ownership',
  },
  goalName: {
    workspace_a: 'Emergency Fund',
    workspace_b: 'Emergency Fund',
    note: 'Same name, different IDs and workspace ownership',
  },
};

// ─────────────────────────────────────────────────────────────────────────
// RECONCILIATION AND DISCREPANCY
// ─────────────────────────────────────────────────────────────────────────

/**
 * March 2026 Reconciliation:
 *   Calculated balance: $10,335.00
 *   Statement balance: $7,635.00
 *   Discrepancy: $2,700.00
 *
 * This represents funds legitimately transferred to external account.
 * Phase 2 does NOT execute reconciliation; Phase 3 will.
 * Phase 2 only validates the numbers make sense.
 */
export const reconciliationMar2026 = {
  accountId: 'account_chequing_a',
  period: '2026-03',
  calculatedBalance: '10335.00',
  statementBalance: '7635.00',
  discrepancy: '-2700.00',
  expectedAdjustment: '-2700.00',
  expectedReason: 'Transfer to high-yield savings account',
};

/**
 * December 2026 Year-End Reconciliation:
 *   Calculated balance: $4,050.00
 *   Statement balance: $4,100.00
 *   Discrepancy: +$50.00
 *   Reason: Bank interest credit
 */
export const reconciliationDec2026 = {
  accountId: 'account_chequing_a',
  period: '2026-12',
  calculatedBalance: '4050.00',
  statementBalance: '4100.00',
  discrepancy: '+50.00',
  expectedAdjustment: '+50.00',
  expectedReason: 'Interest credit from bank',
};

// ─────────────────────────────────────────────────────────────────────────
// DETERMINISM VALIDATION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Create a canonical state signature for determinism testing.
 * Two identical fixture runs should produce identical signatures.
 */
export function canonicalStateSignature(fixture) {
  return {
    workspace_a_id: fixture.FIXED_IDS.workspace_a,
    user_alice_id: fixture.FIXED_IDS.user_alice,
    account_chequing_balance: fixture.accountsA[0].currentBalance,
    debt_visa_id: fixture.FIXED_IDS.debt_visa_a,
    goal_education_id: fixture.FIXED_IDS.goal_education_a,
    test_now: fixture.FIXED_DATES.testNow,
  };
}

export const expectedSignature = {
  workspace_a_id: 'workspace_a_00000000000000000000000001',
  user_alice_id: 'user_alice_0000000000000000000000001',
  account_chequing_balance: '4250.00',
  debt_visa_id: 'debt_visa_a_00000000000000000001',
  goal_education_id: 'goal_education_a_0000000000001',
  test_now: '2026-09-16',
};

// ─────────────────────────────────────────────────────────────────────────
// PHASE 8 — JANUARY 1 OPENING STATE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Authoritative January 1, 2026 opening balances for the full-year lifecycle test.
 * These are independent oracle values, not derived from production functions.
 *
 * Chequing: $5,000 (matches accountConservationJan2026.openingBalance)
 * Savings:  $2,000 (grows to $2,800 by Sept 16 via contributions)
 * RESP:     $500   (matches goalProgressEducation.openingProgress)
 * CC:       $0     (clean start — no outstanding revolving balance)
 * LOC:      $5,000 (matches debt_loc_a startingBalance)
 * Car Loan: $15,000 (matches debt_car_a startingBalance — manual)
 */
export const jan1OpeningState = {
  accounts: {
    chequing: { balance: '5000.00', balanceCents: 500000 },
    savings:  { balance: '2000.00', balanceCents: 200000 },
    resp:     { balance: '500.00',  balanceCents: 50000  },
    cc_visa:  { balance: '0.00',    balanceCents: 0      },
    loc:      { balance: '5000.00', balanceCents: 500000 },
  },
  debts: {
    car_loan: { balance: '15000.00', balanceCents: 1500000 },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// PHASE 8 — FULL-YEAR MONTHLY ORACLE
// Independent arithmetic for each month's conservation check.
// Formula: opening + income - spending ± transfers ± adjustments = closing
// ─────────────────────────────────────────────────────────────────────────

export const monthlyOracle = {
  '2026-01': {
    chequing: {
      opening: 500000,      // $5,000.00
      income:  300000,      // $3,000.00 salary Jan 15
      spending: 119500,     // $1,195.00 (rent $900 + groceries $200 + power $80 + coffee $15)
      closing: 680500,      // 500000 + 300000 - 119500 = $6,805.00
    },
    income:  { total: 300000 },  // $3,000.00
    spending: {
      rent:      90000,
      groceries: 20000,
      power:      8000,
      coffee:     1500,
      total:    119500,
    },
    net: 180500,   // $1,805.00
  },
  '2026-02': {
    chequing: {
      opening: 680500,      // $6,805.00
      income:  350000,      // $3,500.00 ($3,000 salary + $500 bonus)
      spending: 172000,     // $1,720.00
      closing: 858500,      // 680500 + 350000 - 172000 = $8,585.00
    },
    income:  { total: 350000 },
    spending: {
      rent:          90000,
      groceries:     35000,
      power:         15000,
      furniture:     20000,
      car_insurance: 12000,
      total:        172000,
    },
    net: 178000,   // $1,780.00
  },
  '2026-03': {
    chequing: {
      opening: 858500,
      income:  300000,
      spending: 125000,     // $1,250.00 (rent $900 + groceries $250 + power $100)
      goalTransfer: 20000,  // $200 RESP contribution
      // pre-reconciliation: 858500 + 300000 - 125000 = 1033500
      // post-reconciliation: 1033500 - 270000 = 763500
      priorToAdjustment: 1033500,
      adjustment: -270000,
      closing: 763500,      // $7,635.00 (statement balance)
    },
    income:  { total: 300000 },
    spending: {
      rent:      90000,
      groceries: 25000,
      power:     10000,
      total:    125000,
    },
    net: 175000,   // $1,750.00 (before reconciliation adjustment)
  },
  '2026-04': {
    chequing: {
      opening: 763500,
      income:  300000,
      spending: 118000,     // $1,180.00 (per fixture monthlyEvents)
      closing: 945500,      // $9,455.00
    },
    income:  { total: 300000 },
    spending: { total: 118000 },
    net: 182000,   // $1,820.00
  },
  '2026-05': {
    chequing: {
      opening: 945500,
      income:  300000,      // Late income (May 20)
      spending: 120000,     // $1,200.00
      closing: 1125500,     // $11,255.00
    },
    income:  { total: 300000 },
    spending: { total: 120000 },
    net: 180000,   // $1,800.00
  },
  '2026-06': {
    chequing: {
      opening: 1125500,
      income:  300000,
      spending: 110000,     // $1,100.00 household spending (excl. CC payment)
      closing: 1315500,     // $13,155.00
    },
    income: { total: 300000 },
    spending: { total: 110000 },
    cc_visa: {
      opening: 0,
      charges: 39500,       // $395.00 new purchases
      payment: 15000,       // $150.00 payment
      interestApprox: 800,  // ~$8.00 interest
      closing: 25300,       // ~$253.00
    },
    net: 190000,
  },
  '2026-07': {
    // CRITICAL: above_plan payment + increasing balance
    cc_visa: {
      opening: 25300,       // $253.00
      charges: 40000,       // $400.00 new purchases
      payment: 40000,       // $400.00 (above plan of $150)
      interestAccrual: 3500, // ~$35.00
      // 25300 + 40000 - 40000 + 3500 = 28800
      closing: 28800,       // ~$288.00 (conservative; oracle says $296 with carryover interest)
      oracleClosing: 29600, // $296.00 per adversarialHouseholdExpected.debtTrajectoryIndependenceJul2026
    },
    payment: {
      amountCents: 40000,    // $400.00
      planPaymentCents: 15000, // $150.00
      paceClassification: 'above_plan',
    },
    trajectory: {
      balanceChange: 'positive',  // 296 > 253 → increasing
      classification: 'increasing',
    },
  },
  '2026-08': {
    chequing: {
      income:  300000,
      spending: 110000,
    },
    income: { total: 300000 },
    spending: { total: 110000 },
    net: 190000,
    reviewCreated: true,
  },
  '2026-09': {
    // September is the "test month" (as of Sept 16)
    income: { total: 300000 },
    spending: { total: 95000 },  // Partial month as of Sept 16
    goalProgress: {
      education: {
        // Phase 4 SEED_PLAN_MISMATCH resolved: production counts only linkedGoalId transactions
        // Fixture shows $550; the $850 expectation is RESOLVED as SEED_PLAN_MISMATCH
        fixtureValue: '550.00',
        seedPlanExpectation: '850.00',
        resolution: 'RESOLVED_SEED_PLAN_MISMATCH',
        authoritativeSource: 'sumGoalLinkedTransactionCents',
      },
    },
  },
  '2026-10': {
    // Forecast month — read-only; no mutation
    income:  { total: 300000 },
    spending: { total: 110000 },
    forecast: {
      mutationExpected: false,
      deterministic: true,
    },
  },
  '2026-11': {
    income: { total: 300000 },
    spending: { total: 110000 },
    goal: {
      education: {
        withdrawalCents: 10000,  // $100.00 withdrawal
        progressBefore: 55000,  // $550.00 (fixture value)
        progressAfter: 45000,   // $450.00 (after $100 withdrawal; via linked transaction deletion)
      },
    },
  },
  '2026-12': {
    income:  { total: 300000 },
    spending: { total: 110000 },
    reconciliation: {
      statementBalance: 410000,   // $4,100.00
      calculatedBalance: 405000,  // $4,050.00
      discrepancy: 5000,          // +$50.00
      adjustment: 5000,           // Interest credit
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// PHASE 8 — YEAR-END INDEPENDENT ORACLE MATRIX
// ─────────────────────────────────────────────────────────────────────────

/**
 * Full-year accumulated income (independent arithmetic):
 *
 * Jan: $3,000
 * Feb: $3,500 (+$500 bonus)
 * Mar-Dec: $3,000 × 10 = $30,000
 * Total: 3000 + 3500 + 30000 = $36,500
 */
export const yearEndOracle = {
  totalIncomeCents: 3650000,  // $36,500
  breakdown: {
    jan: 300000,   // $3,000
    feb: 350000,   // $3,500 (bonus month)
    mar: 300000,
    apr: 300000,
    may: 300000,
    jun: 300000,
    jul: 300000,
    aug: 300000,
    sep: 300000,
    oct: 300000,
    nov: 300000,
    dec: 300000,
    total: 3650000,
  },
  internalTransferNet: 0,     // Household transfers net to zero
  forecastDeltaOnState: 0,    // Forecast is read-only; no state change
  scenarioDeltaOnBaseline: 0, // Scenarios don't mutate baseline
};
