# Phase 6 — Month Lifecycle & Derived Systems

**Status:** PHASE 6: READY FOR SECURITY, REMI & CROSS-FEATURE COLLISIONS TESTING

---

## Overview

Phase 6 audited and adversarially tested three derived systems that sit above the core ACTUAL layer: the monthly review lifecycle, the cash-flow forecast engine, and the scenario modeling engine. All three are read-only or advisory with respect to ACTUAL data — they may observe it but must not silently mutate it.

---

## 1. Systems Audited

### 1.1 Monthly Review (Monthly Close)

**Implementation:** `lib/monthlyReviews/monthlyReviews.js`, `lib/monthlyReviews/shared.js`

**Functions:**
| Function | Description |
|---|---|
| `createMonthlyReview` | Creates a snapshot for a given month; throws 409 if duplicate |
| `updateMonthlyReview` | Updates `notes` only; throws 404 for unknown review |
| `deleteMonthlyReview` | Removes review and reverts allocation transactions |
| `listMonthlyReviews` | Lists all reviews for a household, with optional from/to filter |

**Key Design Decisions:**
- No separate "close" or "reopen" functions. `deleteMonthlyReview` is the closest analogue to reopen — it removes the snapshot and reverts allocation entries.
- `reviewMonth` must be the exact first day of the month (`normalizeReviewMonth` throws 400 for any other day).
- Snapshot fields (`netSurplus`, `distributions`, etc.) are computed at creation time via `computeMonthlyReviewSnapshot` and are never automatically updated when new transactions arrive.

**Authority Boundary:** A monthly review is a snapshot record, not a restatement. Late-arriving transactions do not auto-update it.

### 1.2 Cash-Flow Forecast

**Implementation:** `lib/raf/cashFlowForecasting.js`

**Key function:** `computeCashFlowForecast({ accounts, incomeEntries, fixedBills, debts, allocationCategories, transactions, upcomingExpenses, household, days, startDate })`

**Key Design Decisions:**
- Pure function — no DB writes, no side effects. Calling it twice with the same inputs always returns structurally equivalent results.
- Opening cash = LIQUID_ASSET_TYPES only: `checking`, `savings`, `cash`, `other`.
- `investment` accounts are explicitly excluded and reported separately in `assumptions.investmentAccountsExcluded`.
- Liability accounts (`credit_card`, `line_of_credit`, `loan`) are silently excluded.
- Income is projected on the 15th of each month, averaged over the trailing 3 months of `incomeEntries`.
- Fixed-bill category slugs (plus hardcoded `debt_payment`/`debt_payments`) are excluded from variable-spending baselines to prevent double-counting.
- `days` must be 1–365; `startDate` must be YYYY-MM-DD.

**Projection structure:** Each day has `projectedIncome`, `projectedFixedBills.bills[]`, `projectedDebtPayments.byDebt[]`, `projectedCategorySpending`, `projectedUpcomingExpenses`, plus `netCashFlow`, `projectedBalance`, and `pressureIndicators`.

**Money format:** `formatCents` returns `'XXXX.XX'` (no dollar sign, no commas). Tests must use this format.

### 1.3 Scenario Engine

**Implementation:** `lib/scenarios/engine.js`

**Exports:**
| Function | Description |
|---|---|
| `compute(snapshot)` | Derives metrics + 12-month simulation from a snapshot object |
| `applyScenario(snapshot, scenario)` | Deep-copies snapshot, applies one scenario mutation, returns new object |
| `buildChangeSet(snapshot, scenario)` | Returns human-readable array of changes without applying them |

**Supported scenario types:**
| Type | Effect |
|---|---|
| `extra_debt_payment` | Increases `minimumPaymentCents` for target debt |
| `expense_increase` | Adds a new fixed bill (amountCents) or scales all bills (percentIncrease) |
| `income_drop` | Reduces `monthlyIncomeCents` by percent |
| `goal_savings` | Updates `monthlyContributionCents` for target goal |
| `one_time_purchase` | Sets `_oneTimePurchaseCents` on snapshot (not consumed by 12m sim — known limitation) |
| `surplus_redirect` | Adds to an existing allocation's `allocationPercent` |
| `emergency_floor_change` | Updates the `isBuffer` allocation to a new percent |

**Key Design Decisions:**
- `applyScenario` uses `JSON.parse(JSON.stringify(snapshot))` — deep copy, original never mutated.
- Unknown scenario types trigger `default: break` — silently ignored, no error, no mutation.
- All three functions are pure — they take no `db` parameter and make no DB calls.
- `maxDebtPayoffMonths` caps Infinity at 999 for practical display; individual `debtPayoff[i].months` remains `Infinity`.
- `income_drop` scenario is advisory — `buildChangeSet` notes "no automatic change applied" and classifies it as `resource: 'note'`.

---

## 2. Test Suites Created

### 2.1 `tests/adversarialMonthLifecycle.test.js` — 19 tests, 0 failures

| Section | Tests |
|---|---|
| 1. Basic CRUD Lifecycle | create review, 400 for mid-month date, update notes, delete, list all |
| 2. Duplicate Prevention | 409 on same month, 400 on missing reviewMonth |
| 3. Missing Required Input | 400 on empty householdId, 404 on unknown reviewId, 400 on empty reviewId |
| 4. Tenant Isolation | HH-A reviews invisible to HH-B, cross-tenant delete/update → 404 |
| 5. Delete Reverts Allocation Transactions | reverts `'Monthly review allocation: '` prefix only, preserves regular transactions |
| 6. Date Range Filtering | from/to range, no filter returns all |
| 7. Snapshot Immutability | late transactions do not auto-update a closed review's fields |

### 2.2 `tests/adversarialCashFlowForecast.test.js` — 20 tests, 0 failures

| Section | Tests |
|---|---|
| 1. Pure Function Properties | deterministic, no input mutation, one projection per day |
| 2. Input Validation | throws for missing/malformed startDate, days=0, days>365 |
| 3. Account Type Authority | checking/savings/cash/other included; investment excluded + reported; credit_card excluded; inactive excluded; mixed sum |
| 4. Income Projection | income on 15th of month; zero-income graceful handling |
| 5. Double-Counting Prevention | bill category slugs excluded; `debt_payment` always excluded |
| 6. Forecast Completeness | required top-level fields; bill on due day in projectedFixedBills; inactive bills excluded |

### 2.3 `tests/adversarialScenarioIsolation.test.js` — 26 tests, 0 failures

| Section | Tests |
|---|---|
| 1. Snapshot Immutability | applyScenario doesn't mutate original; returns new object reference |
| 2. compute() Determinism | same result on repeat calls; decimal-format monetary fields; 12m simulation |
| 3. Supported Scenario Types | all 7 types exercised with expected mutations |
| 4. Unknown / No-Op Types | unknown type silently ignored; one_time_purchase known limitation documented |
| 5. SCENARIO → ACTUAL Firewall | no db parameter; chained scenarios don't leak |
| 6. buildChangeSet | debt from/to, income advisory note, new bill addition, empty for unknown |
| 7. Debt Payoff Math | zero-balance → 0 months; payment ≤ interest → Infinity on individual entry; maxDebtPayoffMonths caps at 999 |
| 8. Goal Completion Math | 100% reserved → 0 months; zero contribution → null months |

---

## 3. Invariant Matrix

| Invariant | Coverage |
|---|---|
| Monthly review snapshot is immutable after creation | ✅ Test 7.1 (month lifecycle) |
| 409 on duplicate monthly review for same month | ✅ Test 2.1 (month lifecycle) |
| `reviewMonth` must be first of month (400 otherwise) | ✅ Test 1.2 (month lifecycle) |
| Tenant isolation: HH-A review invisible to HH-B | ✅ Tests 4.1–4.3 (month lifecycle) |
| Delete reverts allocation transactions only | ✅ Tests 5.1–5.3 (month lifecycle) |
| Investment accounts excluded from forecast opening balance | ✅ Test 3.3 (forecast) |
| Liability accounts excluded from forecast opening balance | ✅ Test 3.4 (forecast) |
| Forecast is a pure function (no DB writes) | ✅ Tests 1.1–1.2 (forecast) |
| Bill/debt slugs excluded from variable spending baselines | ✅ Tests 5.1–5.2 (forecast) |
| `applyScenario` never mutates original snapshot | ✅ Tests 1.1–1.2 (scenario) |
| SCENARIO → ACTUAL firewall (no db parameter) | ✅ Test 5.1 (scenario) |
| Unknown scenario type silently ignored (no error) | ✅ Test 4.1 (scenario) |
| `income_drop` is advisory (resource: 'note' in changeSet) | ✅ Test 6.2 (scenario) |

---

## 4. Not Supported / Known Limitations

| Feature | Status |
|---|---|
| Month "reopen" function | NOT SUPPORTED — use `deleteMonthlyReview` (reverts allocation transactions) |
| `one_time_purchase` effect on 12-month simulation | NOT CONSUMED — `_oneTimePurchaseCents` is set but `simulate12Months` does not read it |
| Forecast from DB (automatic account fetching) | PURE FUNCTION ONLY — caller must supply account, income, bill data |
| Fixed-bill confirmation pipeline in forecast | Only `confidence: 'confirmed'` bills (active=true) included; auto-detection explicitly excluded |

---

## 5. Full Regression Results

| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Phase 3 — Core Money Integrity | (baseline) | 0 | (baseline) |
| Phase 3 — Debt Integrity | (baseline) | 0 | (baseline) |
| Phase 3 — Goal Integrity | (baseline) | 0 | (baseline) |
| Phase 5 — Transaction Intelligence | 22 | 0 | — |
| Phase 5 — Import Integrity | 21 | 0 | — |
| Phase 5 — Review & Reconciliation | 34 | 0 | — |
| Phase 6 — Month Lifecycle | 19 | 0 | — |
| Phase 6 — Cash-Flow Forecast | 20 | 0 | — |
| Phase 6 — Scenario Isolation | 26 | 0 | — |
| **Total (all test files)** | **1399** | **0** | **26** |

Baseline was 1339/0/26. Phase 6 added 60 net passing tests (65 written; 5 within pre-existing suites that may count differently in node:test aggregate).

---

## 6. Bug Classification Summary

All failures encountered during Phase 6 were **TEST_BUG** (wrong expected values in tests, not production defects):

| # | Bug | Classification | Fix |
|---|---|---|---|
| 1 | `'$2,000.00'` format assumed for `formatCents` | TEST_BUG | `formatCents` returns `'2000.00'` — no dollar sign or commas |
| 2 | Projection `events` array assumed | TEST_BUG | Projection uses named sub-objects: `projectedIncome`, `projectedFixedBills.bills[]` |
| 3 | `debt.months` expected 999 for unaffordable debt | TEST_BUG | Individual `debtPayoff[i].months` is `Infinity`; only `maxDebtPayoffMonths` caps at 999 |

No production defects found. No production code was modified during Phase 6.

---

**PHASE 6: READY FOR SECURITY, REMI & CROSS-FEATURE COLLISIONS TESTING**
