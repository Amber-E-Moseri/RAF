# RAF Canonical 18-Feature Usability + UI Restoration Roadmap

**Created:** 2026-09-15  
**Branch:** fix/ci-baseline-closure → to be followed by Wave A, B, C feature branches  
**Canonical authority:** `origin/main` (6937d2c)  
**Historical design references:** `docs/HISTORICAL_BRANCH_DISPOSITION.md`

---

## Information Architecture (Approved)

Current nav is flat, exposes deferred Scenarios, and buries Plan/Outlook under a mixed group.
The historical DSC branch tested the right IA (d37b01e, b6d1663, e82b568).
This IA is adopted for this program:

```
Home           /dashboard
Transactions   /transactions
Plan           /plan         → tabs: Allocations | Goals | Debts
Outlook        /outlook      → tabs: Forecast | Reports
Monthly Review /monthly-review
Settings       /settings     → tabs: Profile | Household | Appearance | Financial | Import Rules
```

Mobile bottom nav: Home / Transactions / Plan / Outlook / More

**Removed from nav:** Scenarios (deferred), separate Insights route (folded into Outlook), separate Debts/Goals top-level (folded into Plan workspace), separate Profile (folded into Settings).

**Redirects to add:** `/insights` → `/outlook?tab=reports`, `/debts` → `/plan?tab=debts`, `/goals` → `/plan?tab=goals`, `/appearance-settings` → `/settings?tab=appearance`

---

## Known Limitations (Architectural Invariants)

### DEBT_PERIOD_AWARENESS — CURRENT_LIMITATION
Historical debt balances are not period-aware. `currentBalance` reflects today's computed state, not a historical month-end snapshot. Do not present current balance as a historical month-end figure. Display a clear disclosure on Debts page when viewing non-current period.

### FINANCIAL_HEALTH_PERIOD_AWARENESS — CURRENT_LIMITATION
FinancialHealthReport is not fully driven by an explicit period parameter. Architecture required for `FinancialHealth(period)` needs API-level period injection into the health scoring pillars. Deferred to Wave C investigation.

### IMPORT_TRANSACTION_DATE_OWNERSHIP — INTENTIONAL_INVARIANT
Imported transaction period ownership = statement transaction date. The viewed month never rewrites transaction ownership. This is an audit-trail invariant.

### ALLOCATION_SNAPSHOT_REAPPLY — ROADMAP_LATER
Allocation snapshots cannot be reapplied as a new current configuration. Future semantics: "use this snapshot as a new current configuration" (not a database rollback). Deferred.

---

## Deferred Features (Do Not Implement)

- Generic category carry-forward / budget rollover engine
- Payday planning / contractor tax reserve
- Notification preferences / reminder snooze
- Recent activity feed / pinned items / recently viewed
- Keyboard shortcuts
- Home personalization
- Recurring transaction templates
- Full Scenario Modeling (Scenarios page exists but must not be promoted)
- Debt divergence/reconciliation intelligence
- Full immutable Monthly Close (not yet backed by domain)
- Allocation snapshot reapply

---

## Authority Matrix

| Feature | Reads From | Writes Through | Can Mutate Balance |
|---------|-----------|----------------|-------------------|
| Financial Inbox | transactions API | markReviewed / bulkReview | NO |
| Categorization Memory | importReviewRules API | updateImportReviewRule | NO |
| Month Navigation | PeriodProvider | setActiveMonth (local state) | NO |
| Import History | importsApi | none | NO |
| Transaction → Goal | transactions API | updateTransaction (linkedGoalId) | NO (goal progress is transaction-derived) |
| Transaction → Debt | transactions API | updateTransaction (linkedDebtId) | NO (debt balance authority preserved) |
| Transaction Review | transactions API | markReviewed / markUnreviewed / bulkReview | NO |
| Goals | goalsApi + transactions | createGoal / updateGoal | NO direct currentAmount mutation |
| Debts | debtsApi | createDebt / updateDebt | NO direct balance decrement |
| Cash-Flow Outlook | cashFlowForecastApi | createUpcomingExpense only | NO financial state |
| Plan Execution | reportsApi (read only) | none | NO |
| Buffer | allocationCategoriesApi + reportsApi | none (display only) | NO |
| Monthly Review | monthlyReviewApi + surplusAllocationApi | applyMonthlyReview | YES — canonical surplus application pathway |
| Profile + Settings | householdApi, allocationCategoriesApi, importsApi, collaborationApi | updateHouseholdSettings, saveAllocationCategories, updateImportReviewRule | NO financial state |

---

## Feature 1 — Financial Inbox

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | transactions.reviewed/reviewedAt; markReviewed/markUnreviewed/bulkReview endpoints |
| API_READY | YES | /transactions?reviewed=false, /transactions/{id}/review, /transactions/bulk-review, /financial-attention |
| UI_READY | PARTIAL | Review card on Dashboard; FinancialAttentionAggregator on Dashboard; but not a dedicated Inbox route |
| MOBILE_READY | PARTIAL | Dashboard mobile works; inbox not primary mobile destination |
| TESTS_READY | PARTIAL | Review/undo working; some integration tests failing in CI |

**HISTORICAL_REFERENCE:** None needed — current domain implementation is correct.

**DEPENDENCIES:** None.

**GAP:** Financial Inbox is embedded inside Dashboard, not a dedicated route. The attention items (FinancialAttentionAggregator) only show in specific next-step states. The inbox review card only shows when unreviewed transactions exist. This is largely correct behavior — improve the review UX flow and ensure attention items appear reliably, not gated on workflow state.

**AUTHORITY_GATE:** No financial mutation. Review/unreviewed is metadata only.

---

## Feature 2 — Categorization Memory

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | ImportReviewRule: rule_type (suggestion/reusable_rule), auto_apply, match_type (contains/exact) |
| API_READY | YES | suggestion field on ImportedTransaction; ImportClassificationPayload has remember_choice, save_rule_mode, auto_apply_rule |
| UI_READY | PARTIAL | ImportRuleEditor in AppearanceSettings and Transactions; but no prominent suggestion recall UX in transaction edit form |
| MOBILE_READY | MISSING | Rule editor not mobile-optimized |
| TESTS_READY | PARTIAL | Several import classification tests failing (test isolation) |

**HISTORICAL_REFERENCE:** f5d2de1 for learning schema; d683922 for learning API patterns.

**AUTHORITY_GATE:** Weak `user_history` cannot auto-apply. Explicit `reusable_rule` may auto-apply. Corrections disable inappropriate auto-apply. Never infer silently from weak evidence.

---

## Feature 3 — Month Navigation + Period Awareness

**STATUS:** PARTIAL  
**WAVE:** C

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | PeriodProvider wraps app; all APIs accept from/to range |
| API_READY | YES | from/to query params on all period-aware endpoints |
| UI_READY | FUNCTIONAL_BUT_WEAK | Period picker in desktop topbar + mobile header; prev/next arrows; current month shortcut; dropdown with history |
| MOBILE_READY | FUNCTIONAL_BUT_WEAK | Period picker in mobile header works |
| TESTS_READY | PARTIAL | period.test.js fails: ENVIRONMENT (TypeScript not loadable in Node test runner) |

**KNOWN_LIMITATION:**  
- DEBT_PERIOD_AWARENESS: historical debt balances not period-aware — do not fake historical balance on Debts page  
- FINANCIAL_HEALTH_PERIOD_AWARENESS: not fully explicit-period driven; architecture TBD

**DEPENDENCIES:** Debt period awareness requires API-level period injection into debt balance history. Do not implement blindly during Wave A.

---

## Feature 4 — Import History

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | getImportHistory, getImportHistoryDetail in importsApi |
| API_READY | YES | /imports/history endpoints exist |
| UI_READY | PARTIAL | Import history list exists in Transactions page; but buried under active import workflow |
| MOBILE_READY | PARTIAL | History section renders but not optimized |
| TESTS_READY | PARTIAL | Import tests failing (test isolation) |

**HIERARCHY:** Financial Inbox → Import workflow → Import History → Ledger.  
Passive history must not overpower active review.

---

## Feature 5 — Data Freshness + Provenance

**STATUS:** PARTIAL  
**WAVE:** C

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | accounts.balance_as_of; FinancialHealthReport.asOf; transactions have timestamps |
| API_READY | YES | getFinancialAccounts returns balance_as_of; CFI-3 hardened |
| UI_READY | PARTIAL | Dashboard has Data Freshness card; CashFlowForecast MISSING FreshnessPanel and AccountCompositionPanel from 633c7d0 |
| MOBILE_READY | PARTIAL | Freshness card on Dashboard renders on mobile |
| TESTS_READY | PARTIAL | |

**HISTORICAL_REFERENCE:** 633c7d0 FreshnessPanel, AccountCompositionPanel, HeadroomShortfallCard — backend already on main; only UI components missing.

**INVARIANT:** `AGE != FINANCIAL_CORRECTNESS`. No arbitrary stale threshold.

---

## Feature 6 — Transaction → Goal

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | Transaction.linkedGoalId; goal progress is transaction-derived; split-level attribution on main |
| API_READY | YES | TransactionCreateRequest.linkedGoalId; setTransactionSplits supports goal funding |
| UI_READY | PARTIAL | Transactions form has linkedGoalId field; no dedicated "Apply to Goal" action from transaction row |
| MOBILE_READY | MISSING | Goal attribution not mobile-friendly |
| TESTS_READY | PARTIAL | Goal funding tests exist; some failing (test isolation) |

**AUTHORITY_GATE:** Never mutate `goal.currentAmount` directly. Goal progress = sum of linked transactions. Prevent double counting (splits already address this).

**GAP:** No discoverable "Apply to Goal" action from a transaction item in the list. The field exists in the create/edit form but is buried. Wave A should add a quick action.

---

## Feature 7 — Transaction → Debt

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | Transaction.linkedDebtId; debt authority model preserved |
| API_READY | YES | TransactionCreateRequest.linkedDebtId |
| UI_READY | PARTIAL | Transactions form has linkedDebtId field; "debt payments" filter in Transactions page; no dedicated row-level action |
| MOBILE_READY | MISSING | |
| TESTS_READY | PARTIAL | Debt tests failing (mix of STALE_EXPECTATION and test isolation) |

**AUTHORITY_GATE:**  
- Account-backed debt balance: `financial_accounts.current_balance`  
- Manual debt: `startingBalance − payments + adjustments`  
- Do not directly decrement debt balances from transaction link.

---

## Feature 8 — Transaction Review UX

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | markReviewed / markUnreviewed / bulkReview |
| API_READY | YES | |
| UI_READY | PARTIAL | Dashboard has review card with mark/undo/bulk; Transactions page has reviewed filter; but no "Next unreviewed" flow |
| MOBILE_READY | PARTIAL | Dashboard review card works on mobile |
| TESTS_READY | PARTIAL | |

**GAP:** Review UX is spread: review card on Dashboard; reviewed/unreviewed filter on Transactions. No "Next" navigation between unreviewed. Bulk review lacks confirmation nuance (reviews all eligible vs some). Undo is single-level only.

---

## Feature 9 — Smart Categorization / Recall UX

**STATUS:** PARTIAL  
**WAVE:** A

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | ImportReviewSuggestion returned on ImportedTransaction; rule_type + auto_apply discriminated correctly |
| API_READY | YES | suggestion field on ImportedTransaction |
| UI_READY | PARTIAL | Import review flow shows suggestion and offers "Remember this rule"; but not surfaced when editing regular transactions |
| MOBILE_READY | MISSING | |
| TESTS_READY | PARTIAL | |

**AUTHORITY_GATE:** Weak suggestion (user_history) must never auto-apply silently. Explicit reusable_rule with auto_apply=true may apply. Correction clears auto_apply.

---

## Feature 10 — Goals Experience

**STATUS:** PARTIAL  
**WAVE:** B

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | Goals CRUD; GoalProgress from transactions; goalAchievements/milestones in lib; linked contributions via linkedGoalId |
| API_READY | YES | /goals CRUD; goal progress in DashboardReport |
| UI_READY | PARTIAL | Goals page with create/edit/view/progress; achievement badges; but no "fund from transaction" quick action; no archive path; milestones partially surfaced |
| MOBILE_READY | PARTIAL | Goals page renders on mobile but not optimized |
| TESTS_READY | PARTIAL | Test 410 failing (STALE_EXPECTATION: checks /plan?tab=goals route not in current app) |

**DEPENDENCIES:** Feature 6 (Transaction → Goal) for the "fund from transaction" action.

---

## Feature 11 — Debt Experience

**STATUS:** FUNCTIONAL_BUT_WEAK  
**WAVE:** B

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | Full debt model with PaymentPaceInsight, balanceTrajectory, paymentObligation, paceInsight acknowledgement |
| API_READY | YES | /debts with full compute; acknowledgePaceInsight |
| UI_READY | FUNCTIONAL_BUT_WEAK | Debts page with create/edit, pace insight card (PaymentPaceInsight component); but paymentPace vs balanceTrajectory not visually distinguished |
| MOBILE_READY | PARTIAL | |
| TESTS_READY | PARTIAL | 6 debt tests failing (mix: createDebt STALE_EXPECTATION; trajectory tests REAL_PRODUCT_FAILURE) |

**KNOWN_LIMITATION:** Debt period awareness — historical balances not period-aware. Show current balance only. Disclose on non-current-period views.

**CRITICAL DISTINCTION:** `paymentPace != balanceTrajectory`. User can be above_plan AND increasing balance. Do not describe that simply as "paying down."

---

## Feature 12 — Cash-Flow Outlook

**STATUS:** FUNCTIONAL_BUT_WEAK  
**WAVE:** B

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | CFI-3 on main: headroom, shortfall, firstShortfallDate, projectedLowDate, coverage gaps, pending review count, account breakdown |
| API_READY | YES | getCashFlowForecast returns summaryMetrics with headroom/shortfall; assumptions.coverageGaps; assumptions.accountBreakdown |
| UI_READY | PARTIAL | CashFlowForecast page exists with forecast, upcoming expenses; but MISSING HeadroomShortfallCard, FreshnessPanel, AccountCompositionPanel, CoverageGapWarning, PendingReviewWarning |
| MOBILE_READY | MISSING | Forecast page not mobile-optimized |
| TESTS_READY | PARTIAL | |

**HISTORICAL_REFERENCE:** 633c7d0 — all five missing UI components fully implemented in that SHA. Backend is already on main. Only the UI components need to be rebuilt (not cherry-picked wholesale — rewrite using current types).

**HIERARCHY:** Projected position → Headroom/shortfall → Upcoming pressure → Assumptions → Data provenance.

---

## Feature 13 — Plan Execution

**STATUS:** PARTIAL  
**WAVE:** B

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | PARTIAL | PlanEngine in lib/planEngine.ts; monthly_bucket_progress in DashboardReport; AllocationBarChart shows allocated vs used |
| API_READY | PARTIAL | Plan vs actual data in getDashboardAggregateReport (monthly_bucket_progress); no dedicated plan-execution summary endpoint |
| UI_READY | PARTIAL | AllocationBarChart on Dashboard shows per-category progress; AllocationPreferences for setup; PlanWizard for initial config; no dedicated Plan workspace page |
| MOBILE_READY | MISSING | |
| TESTS_READY | PARTIAL | |

**HISTORICAL_REFERENCE:** d37b01e — Plan workspace with Allocations + Goals tabs; b6d1663 — Debts tab added.

**AUTHORITY:** PlanEngine in React is for wizard setup/preview only. Never recalculate allocations outside domain.

**GAP:** No Plan workspace route. AllocationPreferences and Goals are separate routes. Wave B should create `/plan` workspace shell wrapping existing pages (Allocations, Goals, Debts as tabs).

---

## Feature 14 — Buffer Experience

**STATUS:** PARTIAL  
**WAVE:** B

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | PARTIAL | AllocationCategory.isBuffer; buffer percent in PlanEngine; MonthlyBucketProgress tracks buffer bucket |
| API_READY | PARTIAL | Buffer category visible in getAllocationCategories; bucket progress in DashboardReport |
| UI_READY | PARTIAL | Buffer category shows in AllocationBarChart; no dedicated "Buffer: starting / used / remaining" display |
| MOBILE_READY | MISSING | |
| TESTS_READY | PARTIAL | |

**CONSTRAINT:** Do not implement end-of-month rollover disposition until canonical backend support exists (roll forward / toward debt / toward savings all deferred).

---

## Feature 15 — Monthly Review

**STATUS:** FUNCTIONAL_BUT_WEAK  
**WAVE:** C

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | applyMonthlyReview, applyMonthlyReviewsInRange (mass apply), surplus recommendations, saveSurplusAllocationPreferences |
| API_READY | YES | /monthly-reviews endpoints; /surplus-recommendations; /surplus-allocation-preferences |
| UI_READY | FUNCTIONAL_BUT_WEAK | MonthlyReview page with surplus allocation, month close, mass apply; but no guided section-by-section narrative (transactions / income / spending / plan / buffer / goals / debts / result) |
| MOBILE_READY | PARTIAL | |
| TESTS_READY | PARTIAL | Tests 512, 515 failing (TEST_ISOLATION) |

**CONSTRAINT:** Do not pretend full immutable Monthly Close exists if it does not. The close action records a review but does not produce an immutable snapshot.

---

## Feature 16 — Profile + Settings

**STATUS:** PARTIAL  
**WAVE:** C

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | Profile (goal achievements), household settings, appearance preferences, import rules, member management all available |
| API_READY | YES | householdApi, collaborationApi, importsApi, goalAchievements (local) |
| UI_READY | PARTIAL | AppearanceSettings page exists but has 6 TS errors; Profile is a separate read-only achievement page; Members is separate; historical e73845d consolidated all into one tabbed Settings page |
| MOBILE_READY | MISSING | |
| TESTS_READY | PARTIAL | AppearanceSettings TS errors block reliable operation |

**HISTORICAL_REFERENCE:** e73845d — Settings page with tabs: `profile | household | appearance | financial | import_rules`. All data is available on current main.

**GAP:** Settings is fragmented across AppearanceSettings (route: /settings), Profile (/profile), Members (/members). Should consolidate into `/settings?tab=...` workspace.

---

## Feature 17 — Responsive / Mobile RAF

**STATUS:** PARTIAL  
**WAVE:** C (cross-cutting; some work in every wave)

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | N/A | |
| API_READY | N/A | |
| UI_READY | PARTIAL | Dark sidebar hidden on mobile; mobile bottom nav exists; period picker in mobile header; but current mobile tabs (Dashboard/Txns/Remi/Review/More) are weaker than historical (Home/Txns/Plan/Outlook/More) |
| MOBILE_READY | PARTIAL | Bottom nav functional; pages largely render; no overflow certification |
| TESTS_READY | PARTIAL | |

**HISTORICAL_REFERENCE:** b6d1663 — mobile nav: Home / Transactions / Plan / Outlook / More (5 tabs). This is superior to current Remi and Review as primary tabs.

**TARGETS:** 1440×900, 1280×800, 390×844  
**REQUIREMENTS:** No horizontal overflow at body level; tables in overflow-x:auto containers; touch targets ≥ 44px; modals usable; financial hierarchy preserved on small screen.

---

## Feature 18 — Default Home / Action-Oriented Dashboard

**STATUS:** PARTIAL  
**WAVE:** C (certification) — fed by Wave A + B

| Dimension | Status | Notes |
|-----------|--------|-------|
| DOMAIN_READY | YES | All dashboard data available from getDashboardAggregateReport |
| API_READY | YES | |
| UI_READY | PARTIAL | Dashboard has: net surplus hero, FinancialAttentionAggregator, review card, AllocationBarChart, recent transactions, data freshness; MISSING: plan execution summary, goals/debts requiring action, cash-flow outlook section |
| MOBILE_READY | PARTIAL | Dashboard renders on mobile; hero and metrics cards are responsive |
| TESTS_READY | PARTIAL | |

**HIERARCHY:** 1. What needs attention (FinancialAttention) → 2. Current position (net surplus hero, metrics) → 3. Plan execution (allocation bar chart) → 4. Cash-flow outlook (headroom/shortfall teaser) → 5. Goals/debts requiring action → 6. Provenance/reference (data freshness).

**AUTHORITY:** Dashboard is a CONSUMER. It must never regain surplus execution. No financial writes except via modals that call canonical pathways.

---

## Wave Plan

### WAVE A — Transaction Trust Loop

**Goal:** Transactions becomes RAF's strongest operational workflow.

**Features:** 1, 2, 4, 6, 7, 8, 9

**Precondition:** CI baseline (`fix/ci-baseline-closure`) must pass TypeScript and build before Wave A begins.

**Domain changes:** None expected. All APIs and domain are ready.

**API changes:** None expected.

**UI changes:**
- Improve FinancialAttentionAggregator to always show on Dashboard (not gated on workflow state)
- Add "Apply to Goal" quick-action on transaction rows in Transactions page (calls updateTransaction with linkedGoalId)
- Add "Apply to Debt" quick-action on transaction rows (calls updateTransaction with linkedDebtId)
- Add "Next unreviewed" navigation in review flow
- Surface categorization suggestion prominently when editing a transaction that has an ImportedTransaction suggestion
- Improve Import History hierarchy within Transactions page

**Mobile changes:**
- Ensure transaction quick actions are touch-friendly
- Ensure review flow works single-handed on mobile

**Tests:**
- Transaction → Goal attribution contract
- Transaction → Debt attribution contract
- Categorization suggestion visibility
- Review/undo coverage

**Authority gates:**
- No direct goal currentAmount mutation
- No direct debt balance decrement
- No recalculation of allocations in React

**Expected files:**
- `src/pages/Transactions.tsx` — add quick actions, suggestion UX
- `src/pages/Dashboard.tsx` — un-gate FinancialAttentionAggregator
- `src/components/transactions/TransactionRowActions.tsx` (new) — Apply to Goal / Apply to Debt popover
- `src/api/transactionsApi.ts` — fix TS error (index signature)

---

### WAVE B — Financial Objects + Outlook

**Goal:** Goals, Debts, Cash-Flow, Plan Execution become coherent product surfaces.

**Features:** 10, 11, 12, 13, 14

**Precondition:** Wave A complete and green.

**Key changes:**
- Create `/plan` workspace shell (Plan.tsx) wrapping AllocationPreferences, Goals, Debts as tabs
- Add navigation redirect: `/goals` → `/plan?tab=goals`, `/debts` → `/plan?tab=debts`
- Rebuild missing CashFlowForecast UI components: HeadroomShortfallCard, FreshnessPanel, AccountCompositionPanel, CoverageGapWarning, PendingReviewWarning (from 633c7d0 as reference, rewritten for current types)
- Add Buffer summary card to AllocationBarChart or Dashboard
- Add Plan vs Actual section to Dashboard showing what was planned vs what happened
- Fix debt test failures (STALE_EXPECTATION classification; 6 failing debt tests)
- Fix trajectory REAL_PRODUCT_FAILURE (tests 756, 757)

**Authority gates:**
- Plan workspace is display + setup only; no allocation calculation in React beyond wizard
- CashFlowForecast only writes upcomingExpenses (createUpcomingExpense); no financial state writes
- Debt balance authority preserved (no direct decrement)

---

### WAVE C — Product Coherence

**Goal:** RAF is a coherent, mobile-certified product.

**Features:** 3, 5, 15, 16, 17, 18

**Key changes:**
- Create Settings workspace shell (Settings.tsx from e73845d as reference) with tabs: profile | household | appearance | financial | import_rules
- Create Outlook workspace shell (Outlook.tsx from e82b568 as reference) with tabs: forecast | reports (no scenarios)
- Refactor mobile bottom nav to: Home / Transactions / Plan / Outlook / More
- Finalize Dashboard hierarchy: add goal/debt action teaser, cash-flow outlook summary
- Period awareness audit: verify all surfaces respect activeMonth; add debt period disclosure
- Mobile certification at 390×844: no overflow, usable actions, financial hierarchy preserved
- Fix AppearanceSettings TS errors (6 errors in that file)
- Fix Goals TS errors (3 errors)
- Fix MonthlyReview TS error (1 error)

---

## CI Baseline (Pre-Wave A Required)

**Branch:** `fix/ci-baseline-closure` (current branch)

**TypeScript errors to fix (22 total):**

| File | Errors | Classification |
|------|--------|----------------|
| cashFlowForecastApi.ts:117,127 | Duplicate `accountBreakdown` identifier | REAL — fix duplicate field in interface |
| client.ts:78 | `message` on string\|object union | REAL — add type narrowing |
| transactionsApi.ts:30 | TransactionsQuery missing index signature | REAL — add index signature or cast |
| ImportRuleEditor.tsx:28-35 | Nullable field mismatches | STALE_EXPECTATION — add `?? ""` defaults |
| AppearanceSettings.tsx:358,360 | `privacyMode` should be `privacy_mode` | REAL — property name typo |
| AppearanceSettings.tsx:370-373 | InterfaceScale comparison issues | STALE_EXPECTATION — update scale values |
| AppearanceSettings.tsx:723 | `rulesData.data` possibly null | REAL — add null guard |
| Goals.tsx:247 | `goalsData.data` possibly null | REAL — add null guard |
| Goals.tsx:536 | `milestone_label` not on GoalProgress | STALE_EXPECTATION — remove or use correct field |
| MonthlyReview.tsx:176 | `active` should be `isActive` on Debt | REAL — property name fix |

**Lint failures:** 34 warnings, 0 errors — warnings only, do not block Wave A.

**Test failures (39 total):**

| Tests | Count | Classification |
|-------|-------|----------------|
| Auth/security phases (22,23,60-76) | 18 | ENVIRONMENT (integration tests requiring running server) |
| Debt tests (269,287-293) | 6 | STALE_EXPECTATION (domain calculation evolved) |
| Account/import (330,333,334) | 3 | TEST_ISOLATION |
| Goals frontend route (410) | 1 | STALE_EXPECTATION (route changed) |
| Import classification (447,457,462,504,505) | 5 | TEST_ISOLATION |
| Routes/mass-apply (512,515) | 2 | TEST_ISOLATION |
| Period test (50) | 1 | ENVIRONMENT (TypeScript extension not loadable in Node test runner) |
| Trajectory (756,757) | 2 | REAL_PRODUCT_FAILURE |
| File security (810-812) | 3 | TEST_ISOLATION |

**CI_BASELINE_BLOCKS_WAVE_A:** YES  
TypeScript errors are in files Wave A will touch. Build passes but TypeScript fails. Must fix TS errors before Wave A branches.

**RECOMMENDED_CI_ACTION:**  
On current branch (`fix/ci-baseline-closure`):
1. Fix all 22 TypeScript errors
2. Fix period.test.js (add TypeScript loader or move test assertions to .js)
3. Fix test 410 (stale frontend route expectation — update to `/goals` or omit)
4. Fix debt test stale expectations (6 tests — update expected values to match current domain)
5. Investigate trajectory tests (756, 757 — REAL_PRODUCT_FAILURE)
6. Quarantine remaining ENVIRONMENT/TEST_ISOLATION failures with skip directives and TODO comments
7. Confirm: `npx tsc --noEmit` exits 0, `npm run build` exits 0
8. Then open Wave A feature branch
