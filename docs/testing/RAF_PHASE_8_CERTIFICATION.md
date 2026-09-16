# RAF Phase 8 — Full-Year Final Certification

**Status:** IN PROGRESS — Initial Framework Established

**Date:** 2026-09-16  
**Scope:** Complete integrated lifecycle certification (Jan-Dec 2026)  
**Phases Certified:** 1–7 (subsystems)  
**Phase 8 Goal:** Integrated full-year certification

---

## Executive Summary

Phase 8 is RAF's final integration certification. Phases 1–7 certified individual financial and security subsystems. Phase 8 verifies that all certified subsystems remain financially correct, tenant-safe, deterministic, and internally consistent when operating together over a complete deterministic household year.

**Current Status:** Initial baseline framework established. Phase 8 foundation tests pass. Comprehensive month-by-month lifecycle testing in progress.

---

## Certification Phases Summary

| Phase | Scope | Tests | Result | Status |
|-------|-------|-------|--------|--------|
| Phase 1 | Audit & Architecture | 1042 | 1042 ✓ / 0 ✗ | **CERTIFIED** |
| Phase 2 | Seed Foundation | 1078 | 1078 ✓ / 0 ✗ | **CERTIFIED** |
| Phase 3 | Core Money Integrity | 1149 | 1149 ✓ / 0 ✗ | **CERTIFIED** |
| Phase 4 | Debt & Goal Integrity | 1260 | 1260 ✓ / 0 ✗ | **CERTIFIED** |
| Phase 5 | Transaction Intelligence | 1339 | 1339 ✓ / 0 ✗ | **CERTIFIED** |
| Phase 6 | Month Lifecycle & Derived | 1399 | 1399 ✓ / 0 ✗ | **CERTIFIED** |
| Phase 7 | Security & Remi Collisions | 1513 | 1513 ✓ / 0 ✗ | **CERTIFIED** (with closure patch) |
| Phase 8 | Full-Year Integration | 1541+ | IN PROGRESS | IN PROGRESS |

**Note:** Phase 7 discovered and fixed 1 production defect (Remi current-plan income field mapping). All subsystem invariants preserved.

---

## Phase 8 Baseline Verification

**STEP 1 — Pre-Phase-8 Test Suite Status:**

```
Pre-Phase-8 Reference (Phase 7 closure complete):
- Baseline passing: 1513
- Baseline failing: 0
- Baseline skipped: 26 (RLS environment-gated)
- Baseline total: 1539
```

**Current Status (with Phase 8 initial framework):**

```
Phase 8 Framework Tests (6 baseline tests):
- Baseline: Fixture materializesWithoutError ✓
- January: September snapshot is consistent ✓
- Tenant Isolation: Workspace A ≠ Workspace B ✓
- Tenant Isolation: Same-looking data isolated ✓
- Determinism: Clean replay identical state ✓
- Baseline: All sanity checks pass ✓

Phase 8 passing: 6 / 6
Phase 8 failing: 0
```

---

## Financial Authority Hierarchy (RFC)

RAF maintains this authority hierarchy and certifies it is preserved:

```
AUTHORITATIVE ACTUALS
├── Financial accounts (authoritative ledger)
├── Transactions (recorded economic events)
├── Income entries (received funds)
├── Allocations (planned distributions)
├── Debts (starting balance + payments + interest)
├── Goals (explicit linked transactions)
└── Reconciliations (statement-to-ledger corrections)
        │
        ▼
DERIVED / HISTORICAL
├── Monthly reviews (snapshots of actual state)
├── Reports (computations from actuals)
├── Debt intelligence (payment pace / trajectory)
└── Goal progress (derived from linked activity)
        │
        ▼
PROJECTED
└── Cash-flow forecast (read-only projection)
        │
        ▼
HYPOTHETICAL
└── Scenarios (what-if proposals)
        │
        ▼
ADVISORY
└── Remi (AI financial context reader)
```

**Invariant:** No lower-authority layer may mutate a higher-authority layer.

---

## Phase 7 Closure Patch Summary

During Phase 7 certification, a production defect was discovered in Remi's current-plan handler:

**Defect:** Remi income field returned `"0.00"` for non-zero actual income  
**Classification:** PRODUCT_DEFECT / REMI_FINANCIAL_CONTEXT_CORRECTNESS  
**Root Cause:** Handlers accessed stale property paths (`periodSummary.income?.total`) not matching producer output (`periodSummary.incomeTotal`)

**Fix Applied:**
- Updated `handleGetCurrentPlan` to use `incomeTotal` and `spendingTotal` (flat keys)
- Updated `handleGetAvailableResources` with same corrections
- Updated `propose_allocation_change` with same corrections
- Added 3 regression tests for income mapping correctness

**Regression Tests:**
- 4.6.1: Zero income control case
- 4.6.2: Multiple income entries aggregate correctly
- 4.6.3: Tenant isolation preserved

**Phase 7 Result After Closure:**
- Phase 7 base: 48 passing
- Phase 7 closure: 3 regression passing
- **Phase 7 total: 51 / 51 passing** ✓

---

## Phase 8 Scope & Coverage Plan

**Complete Domain Coverage:**

- [x] A. Baseline verification (Step 1-2)
- [ ] B. Full-year driver framework (Step 3-5)
- [ ] C. January–December month-by-month (Step 6-8)
- [ ] D. January baseline (Step 9)
- [ ] E. February–April normal activity (Step 10-11)
- [ ] F. May authority check (Step 12)
- [ ] G. June monthly review (Step 13-14)
- [ ] H. July debt stress case (Step 15-16)
- [ ] I. August goal check (Step 17-18)
- [ ] J. September integrated state (Step 19-20)
- [ ] K. October import/recall/review (Step 21-23)
- [ ] L. November reconciliation (Step 24-25)
- [ ] M. December year-end (Step 26-32)
- [ ] N. Transfer neutrality (Step 33)
- [ ] O. Refunds/reversals (Step 34)
- [ ] P. Review neutrality (Step 35)
- [ ] Q. Multiple monthly reviews (Step 36-37)
- [ ] R. Forecast testing (Step 38-40)
- [ ] S. Scenarios testing (Step 41-43)
- [ ] T. Remi integration (Step 44-48)
- [ ] U. Tenant collision (Step 49-51)
- [ ] V. Deterministic replay (Step 52-53)
- [ ] W. Independent oracle (Step 54-55)
- [ ] X. Adapter parity (Step 56-60)
- [ ] Y. Security sanity (Step 61)
- [ ] Z. Full regression (Step 62)

---

## Known Limitations Identified (Pre-Phase 8)

| Limitation | Classification | Financial Risk | Launch Blocking? | Status |
|------------|-----------------|-----------------|------------------|--------|
| Duplicate detection workspace-scoped (not account-scoped) | KNOWN LIMITATION | Low | No | Documented in Phase 5 |
| One-time purchase scenario (`_oneTimePurchaseCents` set but not consumed) | DEFERRED FEATURE | Low | No | Noted in Phase 6 |
| Monthly lifecycle has no explicit close/reopen API | ARCHITECTURE | Low | No | Current in Wave C |
| Postgres/RLS may remain environment-gated | TEST_ENVIRONMENT_LIMITATION | None | No | Dependent on environment |

---

## Current Test Infrastructure Status

**Adversarial Household Fixture:**
- ✓ 3 Workspaces (A, B, C) with intentional collision data
- ✓ 12 Months of event metadata (Jan-Dec 2026)
- ✓ Deterministic IDs for all entities
- ✓ Expected financial state calculations (independent oracle)

**Test Adapters:**
- ✓ In-memory database (all tests)
- ✓ SQLite (available, not yet exercised in Phase 8)
- ? Postgres/RLS (environment-gated, see STEP 59)

---

## Phase 8 Checkpoint

This report documents Phase 8 **initial framework establishment**.

**What is Certified:**
- Phases 1–7 subsystems (financial/security invariants)
- Phase 7 Remi income mapping defect fix
- Fixture structure and determinism

**What Requires Certification:**
- Full-year (Jan-Dec 2026) integrated lifecycle
- Month-by-month financial conservation
- Year-end independent reconciliation against oracle
- Cross-domain collision testing
- Deterministic full-year replay
- Final regression suite

**Next Steps:**
1. Build month-by-month lifecycle tests (months 1–12)
2. Implement financial conservation checkpoints
3. Construct independent year-end oracle
4. Validate deterministic replay
5. Execute comprehensive final regression
6. Generate final certification verdict

---

## Certification Gates (From Phase 8 Instructions)

RAF final certification requires:

### Financial Integrity
- [ ] No unexplained account delta
- [ ] No duplicate economic events
- [ ] No allocation double-counting
- [ ] Transfers remain neutral
- [ ] Debts reconcile
- [ ] Goals reconcile
- [ ] Buffer conserves
- [ ] Reconciliation conserves

### Accumulation
- [ ] January–December does not drift
- [ ] Year-end oracle matches production
- [ ] Repeated month transitions preserve authority

### Derived Systems
- [ ] Snapshots remain historical
- [ ] Forecasts remain read-only
- [ ] Scenarios remain hypothetical
- [ ] Remi remains advisory/read-only

### Security
- [ ] Tenant isolation intact
- [ ] Workspace switching no leakage
- [ ] Foreign objects inaccessible
- [ ] Remi tenant-scoped
- [ ] Current-run Postgres status reported truthfully

### Determinism
- [ ] Clean full-year replay produces equivalent state

### Regression
- [ ] Zero unexplained test failures

---

## Final Verdict (Pending)

**Status:** PHASE 8 IN PROGRESS

Final verdict will be one of:

```
RAF FINAL CERTIFICATION: READY
or
RAF FINAL CERTIFICATION: READY WITH DOCUMENTED LIMITATIONS
or
RAF FINAL CERTIFICATION: BLOCKED
```

**Final verdict will be issued after:**
1. Complete month-by-month lifecycle testing
2. Year-end financial reconciliation
3. Full regression execution
4. Comprehensive certification report completion

---

## Document History

- **2026-09-16:** Phase 8 initial framework established (6 baseline tests passing)
- **Phase 7 Closure:** Remi income mapping defect fixed, 51 tests passing
- **Phase 7 Open:** 48 base tests passing
- **Phases 1–6:** All certified with 0 failures

---

*This is the RAF Phase 8 Certification Report. It documents the progression toward final system certification. Phases 1–7 are closed. This is RAF's final integration gate.*
