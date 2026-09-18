# RAF PostgreSQL Architecture Closure — Phase 2 Results

**Commit:** eb197a7  
**Date:** 2026-09-18  
**Branch:** main  

---

## Phase 2A — F1 Lock-Assumption Revalidation

**Finding:** The advisory lock (`pg_advisory_xact_lock(hashtext('raf.postgres_compatibility_adapter'))`) is acquired lazily on the first hybrid method call and held until COMMIT. It is transaction-scoped.

**Why sequential-call ordering is not a safe F1 fix:**  
Sequential call ordering (calling `listMonthCloses` after `getMonthlyReviewByMonth`) would see fresh state under the current hybrid adapter because the advisory lock forces serialization — Transaction B must release the lock (by committing) before Transaction A can acquire it. However, this invariant is adapter-dependent. After the hybrid adapter and advisory lock are removed, there is no application-layer lock, and the TOCTOU race returns. The correct fix is DB-native.

---

## Phase 2B — Monthly Lifecycle Race Fix

**Method added:** `transitionMonthlyReviewToReviewing` in `buildDirectTransaction`.

**Mechanism:**  
1. Try `UPDATE monthly_reviews ... WHERE ... AND NOT EXISTS (SELECT 1 FROM monthly_closes WHERE ... AND status = 'CLOSED')` → returns `{ blocked: false, review }` if 1 row updated.  
2. If 0 rows: check for CLOSED record. If found → `{ blocked: true }`.  
3. If no review and no close: `INSERT INTO monthly_reviews ... SELECT ... WHERE NOT EXISTS (...)` → `{ blocked: true }` on 0 rows (concurrent close committed between check and insert), `{ blocked: false, review }` on 1 row.

**Why this is correct:** The `NOT EXISTS` subquery is evaluated at statement execution time under PostgreSQL READ COMMITTED isolation. It sees all committed data as of that moment — including a `CLOSED` record committed by a concurrent `closeMonth` after the caller's initial read but before this write. No application-layer lock required. Invariant holds after adapter removal.

**`monthlyLifecycle.transitionToReviewing` update:**  
Routes to `transitionMonthlyReviewToReviewing` when present (direct-SQL path); falls back to the existing hybrid path (sequential reads under advisory lock) only when the method is absent.

**`approveImportBatch.js` update (F2):**  
`updateImportBatch` call now passes `expectedStatus: IMPORT_BATCH_STATUS.REVIEW`. The direct-SQL `updateImportBatch` performs a conditional UPDATE (`WHERE status = $7`) and returns `null` if the guard rejects.

---

## Phase 2C — Monthly Review Direct SQL

All 6 methods migrated to `buildDirectTransaction`:

| Method | Notes |
|---|---|
| `getMonthlyReviewByMonth` | SELECT by workspace_id + review_month |
| `getMonthlyReviewById` | SELECT by workspace_id + id |
| `listMonthlyReviews` | Supports optional from/to date range |
| `insertMonthlyReview` | Follows insertMonthClose pattern |
| `updateMonthlyReview` | Read-modify-write with isoNow() |
| `deleteMonthlyReview` | DELETE by workspace_id + id |

---

## Phase 2D — Import P0 Mutations Direct SQL

All 6 methods migrated to `buildDirectTransaction`:

| Method | Notes |
|---|---|
| `getImportBatch` | SELECT by workspace_id + id |
| `updateImportBatch` | Optional `expectedStatus` guard (F2) |
| `getImportedRow` | SELECT from imported_transaction_rows |
| `updateImportedRow` | Read-modify-write, status in explicit column |
| `updateImportedTransaction` | status, classificationType, linkedTransactionId columns |
| `countUnreviewedImportedRows` | COUNT where status = 'pending_review' |

---

## Phase 2E — Active P0 Infrastructure

### DIRECT SQL IMPLEMENT (10 methods)

| Method | Table(s) |
|---|---|
| `getEmailPreferences` | email_preferences |
| `upsertEmailPreferences` | email_preferences (ON CONFLICT workspace_id) |
| `logEmailSend` | email_send_log |
| `createRemiConversation` | remi_conversations |
| `getRemiConversation` | remi_conversations |
| `listRemiConversations` | remi_conversations (non-archived, by userId) |
| `listRemiMessages` | remi_messages (ordered by created_at) |
| `appendRemiMessage` | remi_messages |
| `getPdfImportQuotaStatus` | households + pdf_import_quotas |
| `updateHouseholdPdfQuotaTier` | households |

### DEAD CODE (1 method)

**`incrementPdfImportQuota`** — exported from `lib/imports/quotaHelper.js` but `quotaHelper.js` itself is not imported by any other file in the codebase. No production caller. Not implemented.

### DEFERRED (1 method)

**`listAllEmailPreferences`** — Called from `runWeeklyReminders` with no workspace context. Under current RLS, `raf.workspace_id` is not set → `workspace_id = raf.current_workspace_id()` evaluates to `workspace_id = NULL` → 0 rows returned. This is a pre-existing defect in the weekly-reminder background job path. The fix requires a dedicated superuser/admin connection for the reminder job (outside Phase 2 scope). A direct-SQL implementation is included that is correct within a workspace context but will exhibit the same RLS behavior as the hybrid path when called without workspace context.

---

## Phase 2F — RLS / Tenant Isolation

All new methods:
- Use `workspaceIdFromHousehold(householdId)` to normalize the workspace ID.
- Execute under the `raf_app` role (NOBYPASSRLS).
- Rely on `set_config('raf.workspace_id', ..., true)` set by the transaction wrapper.
- RLS policies (`USING (workspace_id = raf.current_workspace_id() AND raf.has_workspace_membership(workspace_id))`) enforce isolation at the database level. No application-layer workspace filter added redundantly.
- `monthly_closes` uses simpler `USING (workspace_id = raf.current_workspace_id())`.

No new cross-workspace reads. No BYPASSRLS. No new admin paths.

---

## Phase 2G — Test Results

| Suite | Tests | Pass | Fail | Skip | Notes |
|---|---|---|---|---|---|
| postgresAdapterHardening | 27 | 27 | 0 | 0 | |
| postgresDispatchVerification | 27 | 27 | 0 | 0 | |
| postgresMigrationSchema | 15 | 15 | 0 | 0 | |
| postgresRepositoryTenantIsolation | 50 | 42 | 0 | 8 | SKIP = environment-gated DB tests |
| debtAdjustmentConstraint | 16 | 16 | 0 | 0 | Phase 1 debt work |
| phase1DebtActivityMigrations | 16 | 16 | 0 | 0 | Phase 1 debt work |
| adversarialDebtIntegrity | 7 | 7 | 0 | 0 | Phase 1 debt work |
| postgresPhase2RaceRegression | 7 | 7 | 0 | 0 | **New — Phase 2B regression** |
| debtPaymentMatching | — | — | 1 | — | **PRE-EXISTING FAILURE**: uses `vitest` which is not installed; untracked file from prior session; unrelated to Phase 2 |

**Total (excluding pre-existing failure):** 105 tests, 97 pass, 0 fail, 8 skipped.

---

## Hard Constraint Verification

| Constraint | Status |
|---|---|
| Do not change RAF financial semantics | ✓ No formula changes |
| Do not change Plan Engine behavior | ✓ Not touched |
| Do not change allocation formulas | ✓ Not touched |
| Do not change monthly-close semantics | ✓ Not touched |
| Do not change debt payoff semantics | ✓ Not touched |
| Do not change goal contribution semantics | ✓ Not touched |
| Do not weaken workspace isolation or PostgreSQL RLS | ✓ All methods workspace-scoped via workspaceIdFromHousehold |
| Do not introduce a second production database | ✓ |
| Do not delete the compatibility adapter | ✓ Adapter preserved |
| Do not blindly migrate P1/P2 methods | ✓ Only P0 methods migrated |
| Do not introduce process-local JS locks as the solution | ✓ NOT EXISTS is the solution |
| Do not rewrite the database layer | ✓ Additive only |
| Do not remove the hybrid adapter | ✓ Adapter preserved |
| Do not remove the advisory lock globally | ✓ Advisory lock preserved |
| Do not perform unrelated refactors | ✓ |
| Do not perform UI work | ✓ |
| Do not modify formulas to satisfy tests | ✓ |
| Do not weaken existing tests | ✓ |
| F1 must remain correct after adapter/lock removal | ✓ NOT EXISTS evaluated atomically at DB level |

---

## Remaining Hybrid Methods (not P0 — not migrated)

Methods still routed through the hybrid adapter. Not migrated per Phase 2 scope.

- `listTransactions`, `insertTransaction`, `updateTransaction`, `deleteTransaction`, `getTransactionById` — P1
- `insertDebtPayment`, `listDebtPayments` — P1  
- `listImportedRows` — P1
- `logAuditEvent` — P1
- All Plan Engine and allocation methods — P1/P2
- `listAllEmailPreferences` — DEFERRED (pre-existing RLS defect in caller)
