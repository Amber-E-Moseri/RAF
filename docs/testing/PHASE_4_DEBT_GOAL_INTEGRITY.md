# Phase 4 — Debt & Goal Integrity Testing

**Status:** PHASE 4: READY FOR TRANSACTION INTELLIGENCE TESTING  
**Date:** 2026-09-16  
**DB Engines:** SQLite ✅ | Postgres: NOT_RUN (no connection available)

---

## Core Questions

**Debt:** Can RAF correctly distinguish what a user paid from what happened to the debt balance,
aggregating payments against the correct obligation and preserving the authoritative balance source?

**Goals:** Can RAF correctly track progress through contributions, transaction links, and optional
splits without double-counting money or allowing progress to drift?

**Answer:** Yes on both counts. All 91 adversarial tests pass with zero failures.

---

## Test Execution Summary

| Suite | File | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| Debt Integrity | `tests/adversarialDebtIntegrity.test.js` | 55 | 55 | 0 | 0 |
| Goal Integrity | `tests/adversarialGoalIntegrity.test.js` | 36 | 36 | 0 | 0 |
| **Regression (full)** | `node --test` | 1286 | 1260 | 0 | 26 |

Skipped tests (26) are pre-existing Postgres skips; Postgres is NOT_RUN in this environment.

---

## Debt Integrity Matrix (Steps 1–27)

### Section 1 — Manual Debt Balance Derivation (Steps 1–5)

| Step | Test | Result | Notes |
|---|---|---|---|
| 1.1 | No payments: currentBalance = startingBalance | PASS | 2500.00 → 2500.00 |
| 1.2 | Single payment reduces balance exactly | PASS | 1000 - 250 = 750.00 |
| 1.3 | Multiple payments aggregate correctly | PASS | 3000 - 500 - 500 - 250 = 1750.00 |
| 1.4 | Positive adjustment (interest) increases balance | PASS | 1000 + 50 = 1050.00 |
| 1.5 | Negative correction reduces balance | PASS | 1000 - 200 = 800.00 |

### Section 2 — Cross-Debt Payment Isolation (Steps 6–8)

| Step | Test | Result | Notes |
|---|---|---|---|
| 2.1 | Payment on debtA does not affect debtB | PASS | debtB stays 2000.00 |
| 2.2 | Payment with wrong debtId not counted toward target | PASS | paymentsForA.length = 0 |
| 2.3 | Payments sum per debtId only (grouping invariant) | PASS | 1500 - 450 = 1050.00, totalPaidAllTime = 450.00 |

### Section 3 — Adjustment Types (Steps 9–12)

| Step | Test | Result | Notes |
|---|---|---|---|
| 3.1 | interest adjustment adds to balance | PASS | 1000 + 75 = 1075.00 |
| 3.2 | fee adjustment adds to balance | PASS | 1000 + 30 = 1030.00 |
| 3.3 | late_fee adjustment adds to balance | PASS | 1000 + 39 = 1039.00 |
| 3.4 | negative correction reduces balance | PASS | 1000 - 400 = 600.00 |
| 3.5 | positive reconciliation adds to balance | PASS | 1000 + 100 = 1100.00 |
| 3.6 | payment + adjustment: net balance correct | PASS | 2000 + 80 - 300 = 1780.00 |

### Section 4 — classifyPaymentPace (Steps 13–19)

| Step | Test | Result | Notes |
|---|---|---|---|
| 4.1 | actual=0 → no_payment | PASS | |
| 4.2 | actual > plan + tolerance → above_plan | PASS | 400 > 157.50; amountAbovePlan > 0 |
| 4.3 | actual within 5% tolerance → on_plan | PASS | 200 in [190, 210] |
| 4.4 | actual < plan-tolerance but above minimum → below_plan | PASS | 100 in (25, 190) |
| 4.5 | actual exactly minimum, below lowerBound → minimum_only | PASS | actual=min=50 |
| 4.6 | actual < minimum AND isPaymentDue=true → under_minimum | PASS | 20 < 50 |
| 4.7 | plan=0, actual>0 → above_plan | PASS | any payment when no plan |
| 4.8 | percentOfPlan calculated correctly | PASS | 120/200 = 60% |
| 4.9 | amountAboveMinimum calculated correctly | PASS | 150 - 50 = 10000 cents |

### Section 5 — deriveBalanceTrajectory (Steps 20–22)

| Step | Test | Result | Notes |
|---|---|---|---|
| 5.1 | closing < opening - tolerance → decreasing | PASS | isDecreasing=true, warning=false |
| 5.2 | closing > opening + tolerance → increasing | PASS | isIncreasing=true, warning=true |
| 5.3 | \|change\| <= tolerance → stable | PASS | 100.01 vs 100.00; change=1 cent < tol=100 |
| 5.4 | tolerance floor at 100 cents | PASS | tiny balance 1.50 vs 1.00 = stable |
| 5.5 | absoluteChange and percentageChange correct | PASS | -2000 cents, percentageChange < 0 |

### Section 6 — July 2026 Critical Scenario (Steps 23–25)

| Step | Test | Result | Notes |
|---|---|---|---|
| 6.1 | $400 payment (above $150 plan) + $500 interest → above_plan AND increasing | PASS | Both coexist; closing=5100 |
| 6.2 | Pace and trajectory derived from different inputs (independence) | PASS | No shared fields between results |
| 6.3 | on_plan payment that still causes balance increase is valid | PASS | pace=on_plan, trajectory=increasing |

**Critical insight confirmed:** `classifyPaymentPace` and `deriveBalanceTrajectory` are structurally
independent. They take different inputs (payment amounts vs opening/closing balances) and produce
non-overlapping fields. A user who pays above-plan while accruing large interest charges correctly
shows `above_plan + increasing` simultaneously — this is not a contradiction but a feature: RAF
shows both what the user did (pace) and what happened to the debt (trajectory).

### Section 7 — Account-Linked Debt Balance Authority (Steps 26–28)

| Step | Test | Result | Notes |
|---|---|---|---|
| 7.1 | Linked debt currentBalance = abs(account.currentBalance) | PASS | -3500 → 3500.00 |
| 7.2 | Payments do NOT change account-linked debt currentBalance | PASS | Still 3500.00; paymentsThisMonth=500.00 |
| 7.3 | Account balance update changes linked debt balance | PASS | -3000 → 3000.00 |

### Section 8 — Balance Authority Source (Steps 29–31)

| Step | Test | Result | Notes |
|---|---|---|---|
| 8.1 | Manual debt → source=manual_derived, balance=null | PASS | |
| 8.2 | Linked debt + account → source=financial_account, balance=2000.00 | PASS | |
| 8.3 | Linked debt missing account → throws | PASS | "linked debt requires a financial account" |
| 8.4 | Manual debt: currentBalance = startingBalance when no payments | PASS | |

### Section 9 — Payment Obligation (Steps 32–35)

| Step | Test | Result | Notes |
|---|---|---|---|
| 9.1 | No statementDay/paymentDueDay → obligation null | PASS | |
| 9.2 | Obligation pending before due date | PASS | |
| 9.3 | Obligation satisfied after sufficient payment | PASS | |
| 9.4 | Missed payment classified correctly | PASS | |

### Section 10 — Balance Floor at Zero (Step 36)

| Step | Test | Result | Notes |
|---|---|---|---|
| 10.1 | Overpayment: balance floored at 0.00 | PASS | 500 - 600 → 0.00, not negative |

### Section 11 — Cross-Tenant Debt Isolation

| Step | Test | Result | Notes |
|---|---|---|---|
| 11.1 | Debt in household_B not visible in household_A listDebts | PASS | |
| 11.2 | Payment in household_A not counted against household_B debt | PASS | No SECURITY_DEFECT |
| 11.3 | Adjustment in household_A does not affect household_B balance | PASS | |

### Section 12 — Debt Schema Boundary Validation

| Step | Test | Result | Notes |
|---|---|---|---|
| 12.1 | startingBalance negative → 422 | PASS | |
| 12.2 | apr out of range → 422 | PASS | |
| 12.3 | updateDebt startingBalance immutable → 422 | PASS | |
| 12.4 | deleteDebt with payments → 422 | PASS | |
| 12.5 | createDebtAdjustment amount=0 → 422 | PASS | |

---

## Goal Integrity Matrix (Steps 28–51)

### Section 1 — Goal CRUD (Steps 28–33)

| Step | Test | Result | Notes |
|---|---|---|---|
| 1.1 | createGoal with active bucket succeeds | PASS | id, name, target_amount, active=true |
| 1.2 | createGoal with non-existent bucket_id → 422 | PASS | |
| 1.3 | createGoal requires target_amount → 400 | PASS | |
| 1.4 | updateGoal patches name and targetAmount | PASS | active remains true |
| 1.5 | deleteGoal (active) deactivates, not deleted | PASS | active=false in DB |
| 1.6 | deleteGoal (inactive) physically deletes | PASS | getGoalById returns null |

### Section 2 — Goal Progress Authority (Steps 34–38)

| Step | Test | Result | Notes |
|---|---|---|---|
| 2.1 | No linked transactions → progress = 0 | PASS | reserved_amount=0.00, percent=0 |
| 2.2 | Single linked transaction → progress = amount | PASS | 150/500 = 30% |
| 2.3 | Multiple transactions sum correctly | PASS | 200+300+100 = 600/1000 = 60% |
| 2.4 | Debit linked to goal counts as positive progress | PASS | direction irrelevant |
| 2.5 | Credit linked to goal counts as positive progress | PASS | direction irrelevant |
| 2.6 | Transaction with different linkedGoalId not counted | PASS | goalA sees 0 for goalB's tx |
| 2.7 | Unlinked transaction not counted | PASS | linkedGoalId=null → 0 progress |
| 2.8 | Progress clamped at 100% when over target | PASS | reserved_amount not clamped |

### Section 3 — Split Attribution (Steps 39–42)

| Step | Test | Result | Notes |
|---|---|---|---|
| 3.1 | Split with linkedGoalId: parent.linkedGoalId ignored | PASS | 100 from split, not 300 from parent |
| 3.2 | Parent ignored when splits present (no double-count) | PASS | 300 from splits, not 600 |
| 3.3 | Partial split attribution: only matching splits contribute | PASS | goalA=100, goalB=200 |
| 3.4 | Split for different goal does not bleed | PASS | goal sees 0 from other's splits |

### Section 4 — Income Allocations Do NOT Count (Steps 43–45)

| Step | Test | Result | Notes |
|---|---|---|---|
| 4.1 | Income allocated to savings bucket → goal progress = 0 | PASS | SEED_PLAN_MISMATCH confirmed |
| 4.2 | PHASE_2_MISMATCH classified as SEED_PLAN_MISMATCH | PASS | Documented (see below) |
| 4.3 | bucket_balance reported separately from reserved_amount | PASS | Two distinct fields |

### Section 5 — Goal Isolation (Steps 46–47)

| Step | Test | Result | Notes |
|---|---|---|---|
| 5.1 | Transaction linked to goalA does not appear in goalB | PASS | goalB reserved=0 |
| 5.2 | Household A goals not visible in household B | PASS | progressB.length=0 |
| 5.3 | Cross-household isolation: household A tx does not affect household B goal | PASS | No SECURITY_DEFECT |

### Section 6 — Inactive Goal Exclusion (Steps 48–49)

| Step | Test | Result | Notes |
|---|---|---|---|
| 6.1 | Inactive goal not in listGoalProgress | PASS | Deactivated → excluded |
| 6.2 | setTransactionSplits with inactive goal → 422 | PASS | "inactive goal" error |
| 6.3 | Active and inactive in same household: only active shown | PASS | progress.length=1 |

### Section 7 — listGoalFundingHistory (Steps 50–51)

| Step | Test | Result | Notes |
|---|---|---|---|
| 7.1 | Returns transactions linked to goal | PASS | 2 linked; unlinked excluded |
| 7.2 | Returns splits linked to goal (not parent) | PASS | type='split', amount=100 |
| 7.3 | Unknown goal → 404 | PASS | |
| 7.4 | History sorted newest-first | PASS | 90→75→50 |

### Section 8 — Goal Schema Boundary Validation

| Step | Test | Result | Notes |
|---|---|---|---|
| 8.1 | createGoal without bucket_id → 400 | PASS | |
| 8.2 | createGoal with targetAmount=0 → 400 | PASS | |
| 8.3 | updateGoal with no fields → 400 | PASS | |
| 8.4 | updateGoal for non-existent goal → 404 | PASS | |
| 8.5 | listGoalProgress with missing householdId → 400 | PASS | |

---

## PHASE_2_MISMATCH Resolution

**Classification:** `SEED_PLAN_MISMATCH`

**Observed discrepancy:** Phase 2 fixture expected `$850` in goal progress; production returned
`$550` (or the sum of only explicit `linkedGoalId` transactions).

**Root cause:** The Phase 2 seed plan incorrectly assumed that income allocations landing in the
savings bucket would contribute to goal `reserved_amount`. The authoritative production function
`sumGoalLinkedTransactionCents` (in `lib/goals/goals.js`) counts **only** transactions and splits
with an explicit `linkedGoalId` match. Income allocation flow (`createIncome`) populates
`bucket_balance` but does not create `linkedGoalId` transaction links.

**Resolution:** Trust the production implementation. The $850 expected value was wrong.
`bucket_balance` and `reserved_amount` are separate fields representing different calculations:
- `reserved_amount` / `current_amount`: sum of direct `linkedGoalId` transaction links only
- `bucket_balance`: the total available in the allocation bucket (includes income allocations)

**Action taken:** Phase 4 test 4.2 documents and formally classifies this as `SEED_PLAN_MISMATCH`.
No production code was changed.

---

## Security Observations

No `SECURITY_DEFECT` events triggered. Cross-tenant isolation held in all tested scenarios:
- Debt payments in household A did not affect household B debts
- Goal transactions in household A did not appear in household B progress
- `listGoalProgress` with household B returned empty (not household A's goals)

---

## Implementation Notes

**`linkedGoalId` requires `categoryId`:** `lib/transactions/createTransaction.js:100` enforces that
when `linkedGoalId` is set, `categoryId` (the goal's bucket_id) is also required. Test harness uses
a `makeGoalTransaction` helper that automatically passes `categoryId: goal.bucket_id`.

**`inMemoryDb` category seeding:** `createInMemoryDb()` pre-seeds allocation categories only for
`household_1`. Any test household that calls `createGoal` through the API must use `household_1` or
explicitly insert categories. Cross-tenant isolation tests for `household_p4_goal_b` bypass
`createGoal` via `tx.insertGoal()` directly.

**`resolveActiveMonth()`:** In inMemoryDb context, `tx.getHousehold()` returns `undefined` because
inMemoryDb has no `getHousehold` implementation. Debt tests that require a specific active month
call `deriveDebtSnapshot()` directly with an explicit `activeMonth` parameter.

---

## Postgres

NOT_RUN — no Postgres connection available in this environment. The 26 skipped tests in the full
regression suite correspond to pre-existing Postgres-gated tests.
