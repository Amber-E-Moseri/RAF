# RAF Debt Activity — Audit Reconciliation Gate Report

**Date:** 2026-09-17 — Updated 2026-09-18 (Phase 2C–2E implementation complete)
**Branch:** main
**Scope:** Pre-implementation audit + P0 remediation + Unified Debt Activity implementation phases 1–2E
**Verdict:** PHASE 2 IMPLEMENTATION COMPLETE

> **All P0 blockers resolved. Phases 1–2E shipped. 241 tests pass. Migration applied to live DB.**

---

## CURRENT BALANCE AUTHORITY

Balance authority is correctly implemented and sound.

`resolveDebtBalanceAuthority({ debt, financialAccount })` in `lib/debts/debtBalanceAuthority.js` returns a discriminated record:

| Condition | `source` | `balance` |
|-----------|----------|-----------|
| `debt.financialAccountId` is set and `financialAccount` is provided | `'financial_account'` | `Math.abs(financialAccount.currentBalance)` |
| No linked financial account | `'manual_derived'` | `null` |

Downstream in `lib/raf/debts.js`, `deriveDebtSnapshot()` reads `balanceAuthority.source` to select `currentBalanceCents`:

```js
currentBalanceCents =
  balanceAuthority.source === 'financial_account'
    ? parseMoneyToCents(balanceAuthority.balance)
    : derivedBalanceCents;   // sum from manual ledger
```

**No double-mutation risk.** The two sources are exclusive. Manual ledger balance is a sum-of-adjustments derived value; account-backed balance is a pass-through from `financialAccount.currentBalance`. Neither path writes to the other's source.

**Authority on unlink:** `establishManualAuthorityBoundary()` is called when a debt is unlinked from its financial account. It writes a `reconciliation` adjustment to snapshot the last-known account balance into the manual ledger so continuity is preserved. This logic is architecturally correct and executes without a CHECK violation (confirmed via live DB integration test).

---

## PERSISTENCE PATHS

All debt write operations are **DIRECT_SQL** via `buildDebtsRepository(client, POSTGRES_SCHEMA)`, spread into `buildDirectTransaction` at `lib/server/postgresDb.js:1305`.

### Debt write path classification

| Method | Classification | File | Notes |
|--------|---------------|------|-------|
| `insertDebt` | DIRECT_SQL | `debtsRepository.js` | Via `directTx` proxy |
| `updateDebt` | DIRECT_SQL | `debtsRepository.js` | Via `directTx` proxy |
| `deleteDebt` | DIRECT_SQL | `debtsRepository.js` | Via `directTx` proxy |
| `listDebts` | DIRECT_SQL | `debtsRepository.js` | Read-only |
| `getDebtById` | DIRECT_SQL | `debtsRepository.js` | Read-only |
| `insertDebtAdjustment` | DIRECT_SQL | `debtsRepository.js:99-114` | Writes `row.adjustmentType` directly; CHECK constraint includes `'reconciliation'` |
| `listDebtAdjustments` | DIRECT_SQL | `debtsRepository.js` | Read-only |
| `insertDebtPayment` | DIRECT_SQL | `postgresDb.js:1082` | `ON CONFLICT DO NOTHING` on `(workspace_id, transaction_id)` |
| `listDebtPayments` | DIRECT_SQL | `debtsRepository.js` | Read-only |
| `insertPaymentPaceAcknowledgement` | DIRECT_SQL | `debtsRepository.js` | |
| `getPaymentPaceAcknowledgement` | DIRECT_SQL | `debtsRepository.js` | |
| `countDebtPaymentsForDebt` | DIRECT_SQL | `debtsRepository.js` | Read-only |

### Route → service → persistence chain

**Adjustment creation (public API):**
```
POST /api/v1/debts/[id]/adjustments
  → createDebtAdjustment() [lib/debts/debts.js]
    → Zod: apiAdjustmentTypeSchema = z.enum(['correction', 'interest', 'fee'])
      → db.insertDebtAdjustment(row)
        → buildDebtsRepository → directTx → PostgreSQL
          CHECK constraint: ('interest', 'fee', 'correction', 'reconciliation', 'manual')
```

**Unlink (system reconciliation adjustment):**
```
POST /api/v1/debts/[id]/unlink
  → unlinkDebtFromFinancialAccount() [lib/debts/debts.js]
    → updateDebt() → establishManualAuthorityBoundary()
      → db.insertDebtAdjustment({ adjustmentType: 'reconciliation', ... })
        → CHECK constraint includes 'reconciliation' → SUCCEEDS
```

**Payment creation (only path):**
```
POST /api/v1/transactions (with linkedDebtId)
  → createTransaction() [lib/transactions/createTransaction.js]
    → syncDebtPayment() [line 265-282]
      → db.insertDebtPayment(...)
        → DIRECT_SQL, ON CONFLICT DO NOTHING
```

---

## SCHEMA CONSISTENCY

**RESOLVED — adjustment_type CHECK constraint mismatch fixed by migration `20260917000000_fix_debt_adjustment_type_constraint.sql`.**

### Before (original)

```sql
-- db/migrations/20260903090000_workspace_postgres_persistence.sql:299
adjustment_type text NOT NULL CHECK (adjustment_type IN ('interest', 'fee', 'correction')),
```

DB constraint: **3 values** — missing `'reconciliation'`

### After (migration applied 2026-09-18)

```sql
CHECK (adjustment_type IN ('interest', 'fee', 'correction', 'reconciliation', 'manual'))
```

DB constraint: **5 values** — adds `'reconciliation'` (P0 fix); retains `'manual'` for backward
compatibility with 2 legacy rows; excludes `'late_fee'` (generated-only, never persisted).

### Application definition (updated)

```js
// lib/debts/debts.js
// User-creatable types — the only ones accepted through the public adjustment API
const apiAdjustmentTypeSchema = z.enum(['correction', 'interest', 'fee']);
// 'reconciliation' — system-only, written by establishManualAuthorityBoundary on account unlink
// 'late_fee'       — generated-only (generated: true), never persisted to DB
```

### Persisted/generated boundary (post-remediation)

| Type | Persisted? | Who creates it | DB constraint |
|------|-----------|---------------|---------------|
| `'correction'` | Yes | User via API | Allowed |
| `'interest'` | Yes | User via API | Allowed |
| `'fee'` | Yes | User via API | Allowed |
| `'reconciliation'` | Yes | System (unlink) | Allowed (P0 fix) |
| `'manual'` | Legacy only | No active code path | Allowed (backward compat) |
| `'late_fee'` | **No** | System (generated, `generated: true`) | **Excluded** |

### API exposure (post-remediation)

`POST /api/v1/debts/[id]/adjustments` validates against `apiAdjustmentTypeSchema`. Submitting `late_fee`, `reconciliation`, or `manual` now returns HTTP 400. The production CHECK violation path is closed.

---

## DEDUPLICATION GUARANTEES

### Imported payments (transaction-linked)

`raf.debt_payments` carries a partial unique index:

```sql
UNIQUE (workspace_id, transaction_id) WHERE transaction_id IS NOT NULL
```

`insertDebtPayment` uses `ON CONFLICT DO NOTHING`. Result: idempotent for all import-linked payments.

### Manual payments (no transactionId)

No deduplication guarantee. Manual payments have `transaction_id = NULL`, excluded from the unique index. Two identical manual payments will both insert as distinct rows. This remains a P1 for unified debt activity implementation.

### Idempotency case verdicts (A–G)

| Case | Verdict |
|------|---------|
| A — Import same statement twice | SAFE — `ON CONFLICT DO NOTHING` on `transaction_id` |
| B — Import after manual payment for same period | UNSAFE — no matching/deduplication logic |
| C — Delete transaction with `linkedDebtId` | SAFE — `syncDebtPayment()` handles delete |
| D — Re-link debt to same financial account | SAFE — no payment created on link |
| E — Unlink → re-link → unlink same account | SAFE (constraint fix confirmed by integration test) |
| F — Import after reconciliation adjustment | No interaction — separate tables |
| G — Concurrent import of same statement | SAFE for payments — `ON CONFLICT DO NOTHING` |

---

## CONCURRENCY RISKS

`pg_advisory_xact_lock(hashtext('raf.postgres_compatibility_adapter'))` is a global lock on hybrid transactions. Debt write operations are DIRECT_SQL, so they do not acquire or contend on the advisory lock. No correctness risk for debt-specific operations.

---

## HYBRID ADAPTER DEPENDENCIES

Debt operations are **not hybrid-adapter-dependent**. All methods in `buildDebtsRepository` are in `directTx` and always take the DIRECT_SQL path.

---

## TEST COVERAGE

### PostgreSQL readiness closure results (2026-09-18)

| Suite | Total | Pass | Fail | Skip |
|-------|-------|------|------|------|
| All 10 targeted suites combined | 186 | 186 | 0 | 0 |
| `tests/debts.test.js` | 33 | 33 | 0 | 0 |
| `tests/debtFinancialAccountLink.test.js` | 29 | 29 | 0 | 0 |
| `tests/adversarialDebtIntegrity.test.js` | 55 | 55 | 0 | 0 |
| `tests/debtLargePaymentIntelligence.test.js` | 20 | 20 | 0 | 0 |
| `tests/adversarialScenarioIsolation.test.js` | 22 | 22 | 0 | 0 |
| `tests/debtBalanceTrajectoryPayoff.test.js` | 13 | 13 | 0 | 0 |
| `tests/debtAdjustmentConstraint.test.js` | 1 | 1 | 0 | 0 (live DB) |
| `tests/postgresMigrationSchema.test.js` | } | } | 0 | |
| `tests/postgresAdapterHardening.test.js` | } 13 combined | 13 | 0 | 0 |
| `tests/postgresDispatchVerification.test.js` | } | } | 0 | |

`debtAdjustmentConstraint.test.js` ran against the live non-production Neon database
(ep-odd-darkness-axasf0nl-pooler.c-4.us-east-2.aws.neon.tech) with `SKIP = 0`.

### What the integration test proves

- **Cases A–D**: `'correction'`, `'interest'`, `'fee'`, `'reconciliation'` all persist via real PostgreSQL path
- **Case E**: `'payment'` and `'late_fee'` are rejected by the DB CHECK constraint (SAVEPOINT pattern)
- **Phase 5 (unlink regression)**: `unlinkDebtFromFinancialAccount()` via real PostgreSQL:
  - Creates exactly one `'reconciliation'` adjustment of `-200.00` (1800 confirmed − 2000 ledger)
  - Financial account balance unchanged at 1600.00 (no mutation of account)
  - No payment record created during unlink
  - Debt transitions from account-backed to manual authority

### Adversarial test updates (3.3, 3.5)

Tests 3.3 and 3.5 in `adversarialDebtIntegrity.test.js` were updated to verify that `late_fee` and `reconciliation` are **rejected with HTTP 400** by `createDebtAdjustment`. Previous behavior (accepting via the public service) was incorrect.

---

## BLOCKERS

### P0 blockers — RESOLVED

| Blocker | Status | Resolution |
|---------|--------|-----------|
| `adjustment_type` CHECK constraint mismatch | RESOLVED | Migration `20260917000000_fix_debt_adjustment_type_constraint.sql` applied 2026-09-18 |
| No PostgreSQL integration test for constraint enforcement | RESOLVED | `tests/debtAdjustmentConstraint.test.js` — 1 pass, 0 fail against live DB |

### Remaining items (P1 — for unified debt activity feature, not P0 blockers)

| Item | Impact |
|------|--------|
| No manual payment entry endpoint | `POST /api/v1/debts/[id]/payments` required for unified activity |
| Manual payment deduplication undefined | No fingerprint; identical manual payments insert twice |
| Full suite parallel execution conflicts | Server-spawning tests conflict in parallel mode; each passes individually |

---

## SAFE IMPLEMENTATION SURFACE

| Area | Status |
|------|--------|
| Balance authority logic | SAFE — `resolveDebtBalanceAuthority` is correct |
| Balance trajectory | SAFE — `deriveBalanceTrajectory()` and `explainBalanceChange()` exist |
| Payoff projection | SAFE — uses planned monthly payment, not actual payment |
| Payment pace classification | SAFE — `classifyPaymentPace()` and `buildDebtPaymentInsight()` tested |
| Monthly activity derivation | SAFE — `deriveDebtMonthlyActivity()` correct |
| `insertDebtPayment` | SAFE — DIRECT_SQL, idempotent for transaction-linked |
| `insertDebtAdjustment` (all 4 user/system types) | SAFE — constraint enforced and tested against live DB |
| `unlinkDebtFromFinancialAccount` | SAFE — `reconciliation` type confirmed via integration test |
| `raf.debt_payments` table | SAFE to extend — has `raw_json` for metadata |
| Generated adjustments (`generated: true`) | SAFE — never persisted, confirmed by negative constraint test |
| Public adjustment API | SAFE — restricted to `['correction', 'interest', 'fee']` via Zod |

---

## IMPLEMENTATION SUMMARY — PHASES 1–2E

### Phase 1: PostgreSQL Readiness Gate (2026-09-18)
- Migration `20260917000000_fix_debt_adjustment_type_constraint.sql` applied — adds `'reconciliation'` to CHECK constraint, retains `'manual'` for backward compat
- `apiAdjustmentTypeSchema` restricted to `['correction', 'interest', 'fee']`
- Integration test 1 pass, 0 fail against live Neon DB

### Phase 2A: Activity Read Model
- `lib/debts/debtActivity.js` — pure normalization functions over existing authoritative records
- `normalizeDebtPayment`, `normalizeDebtAdjustment`, `deriveDebtActivity`
- `deriveEconomicDebtActivity`, `deriveDebtMonthlyActivitySummary`, `deriveEconomicMonthlyActivitySummary`

### Phase 2B: Payment Matching & Reconciliation Persistence
- `lib/debts/debtPaymentMatching.js` — EXACT_MATCH / POSSIBLE_MATCH / UNMATCHED
- `lib/debts/debtPaymentReconciliation.js` — confirm/reject/list with idempotency, workspace isolation, self-reconciliation guard
- `lib/server/inMemoryDb.js` — in-memory reconciliation store
- `app/api/v1/debts/[id]/payment-reconciliations/route.js` — GET + POST (confirm/reject)

### Phase 2C–2D: Activity API + PostgreSQL Reconciliation Repository
- `app/api/v1/debts/[id]/activity/route.js` — GET with `?view=economic|raw&month=YYYY-MM-DD`
- `listDebtActivity()` in `lib/debts/debts.js` — pure read, no balance mutations
- `lib/repositories/postgres/debtsRepository.js` — adds `insertDebtPaymentReconciliation`, `getDebtPaymentReconciliation`, `listDebtPaymentReconciliations`
- Migration `20260918000000_debt_payment_reconciliations.sql` applied to live DB — `raf.debt_payment_reconciliations` table with RLS, unordered-pair unique index

### Phase 2E: Test Matrix
| Suite | Tests | Pass |
|-------|-------|------|
| `tests/debtActivity.test.js` | 28 | 28 |
| `tests/debtPaymentMatching.test.js` | 26 | 26 |
| `tests/debtPaymentReconciliation.test.js` | 18 | 18 |
| `tests/debtActivityTenancy.test.js` | 4 | 4 |
| `tests/debtActivityInvariant.test.js` | 6 | 6 |
| `tests/phase2cCertification.test.js` | 16 | 16 |
| All pre-existing debt suites | 143 | 143 |
| **Total** | **241** | **241** |

---

## FINAL VERDICT

**PHASE 2 IMPLEMENTATION COMPLETE**

All P0 blockers are resolved. Unified Debt Activity is implemented as a normalized READ MODEL over existing authoritative records with no second financial ledger. 241 tests pass.

1. **Constraint migration applied** — `'reconciliation'` in CHECK constraint, `'manual'` retained for backward compat, `'late_fee'` intentionally excluded (generated-only)

2. **Application validation tightened** — public API restricted to `['correction', 'interest', 'fee']`; `late_fee` and `reconciliation` return HTTP 400

3. **PostgreSQL integration test** (`tests/debtAdjustmentConstraint.test.js`) — 1 pass against live Neon DB

4. **Reconciliation table** (`raf.debt_payment_reconciliations`) — applied to live DB with RLS, unordered-pair UNIQUE constraint, workspace-scoped policy

5. **241 tests pass** — normalization, matching, reconciliation, tenancy isolation, financial invariants, gate parity
