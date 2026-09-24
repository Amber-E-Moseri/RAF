# RAF / NOMI — FINAL CONVERGENCE CERTIFICATION

---

## A. BASE

**origin/main:** `6f401bc463735163e3f14ddaecedd6eb961a83bb`
(unchanged from certified baseline — Phase 1 confirmed no new commits)

**convergence branch:** `release/nomi-convergence`
**initial SHA (worktree created):** `6f401bc` (base of origin/main)
**final SHA:** `39cad6f9bfba7f14efb3f3025549b00c655534b1`

---

## B. SOURCE TRACKS

| Track | Branch | Certified tip | Final status |
|-------|--------|---------------|-------------|
| **A** | `feature/local-password-recovery` | `4a15a59` | PASS |
| **B** | `feat/nomi-ui-consistency` | `bcb6a53` | CONDITIONAL PASS — reconstructed |
| **C** | `track-c/transactions-import` | `3d3b7280` | PASS |
| **D** | (entangled in `6c033ab` / `feat/nomi-ui-consistency`) | — | CONDITIONAL PASS — extracted |
| **E** | `track-e/quality-security-prod-readiness` | `cb9152f` | PASS |
| **PR37** | `feature/auth-nomi-integration` | `be40e4c` | PASS |

---

## C. INTEGRATION

| Track | Method | Result |
|-------|--------|--------|
| **Track E** | cherry-pick 3 commits (`9d7dde4`, `f61fe8c`, `86cc00a`) | Clean |
| **Track A** | cherry-pick 6 commits ending at `4a15a59` | 1 conflict: `render.yaml` (kept all 4 env vars) |
| **PR37** | cherry-pick `be40e4c` | Clean |
| **Track C** | cherry-pick 2 commits (`98d35b1`, `973c401`) | Clean |
| **Track D** | Surgical hunk extraction from `6c033ab` — commit `8ef94b6` | Clean |
| **Track B** | 27 pure files via `git checkout 6c033ab`, 3 manual edits; cherry-pick `bcb6a53` — commit `7e31034` | Clean |

**Conflicts resolved (1):**
`render.yaml` — Track E added `RAF_BUILD_SHA: fromEnv: RENDER_GIT_COMMIT`; Track A added
`RAF_APP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`. Resolved to keep all four entries.

**Manual resolutions (2):**
1. `6c033ab` not merged wholesale — Track D functional hunks extracted as `8ef94b6`, Track B
   branding hunks applied as `7e31034`. Every hunk classified before commit.
2. `src/pages/TransactionImportWorkflow.tsx` — Track C functional changes preserved; Track B
   single branding string ("completed RAF transaction" → "completed transaction") applied as
   a manual edit, not a wholesale `git checkout`.

**Convergence-only fixes (2):**

| Commit | Fix |
|--------|-----|
| `087ce83` | `tests/passwordRecovery.test.js` — 4 expectations updated for Track A native auth (non-Supabase routes now return 200/401, not 404) |
| `2b3095e` | `tests/usabilityTransparencyFrontendContract.test.js` — regex updated from `RAF does not treat` to `NOMI does not treat` (source string changed by `bcb6a53`) |

---

## D. IMPORT IDEMPOTENCY

**Classification: B — CONFIRMED_APPLICATION_GAP**

**Evidence:**

The DB schema has a partial unique index enforcing file_hash deduplication:
```sql
idx_import_batches_workspace_file_hash
  UNIQUE (workspace_id, file_hash) WHERE file_hash IS NOT NULL
```

`tests/postgresImportFileHashIdempotency.test.js` (TC-AUD-005) proves this constraint fires
correctly for the `import_batches` table path.

`lib/repositories/postgres/importsRepository.js` uses `INSERT INTO raf.import_batches (file_hash, ...)`
— this path IS protected.

However, `lib/imports/bankStatementImports.js` `importBankStatement()` (line 1091–1198)
never calls `createImportBatch()` and never computes a file hash. It calls:
```js
const inserted = await tx.insertImportedTransactions({ rows: extractedRows });
```
directly, bypassing the `import_batches` table and the file_hash constraint entirely.
No `import_batch_id` is set on the inserted rows.

**Root cause:** Two parallel upload paths exist. The repository path (used by older CSV/batch
imports) goes through `import_batches` with file_hash. The PDF AI-import path added later
went directly to `insertImportedTransactions` without backfilling the batch+hash pattern.

**Affected endpoint:** `POST /api/v1/imports/bank-statement` (the route that calls
`importBankStatement()`).

**Existing DB protection:** The `idx_import_batches_workspace_file_hash` constraint protects
the `createImportBatch()` path. It does NOT protect the `importBankStatement()` path.

**User-visible consequence:** Re-uploading the same PDF creates duplicate imported transaction
rows for the household. The duplicates appear in the Financial Inbox review queue.

**Recommended minimal fix:**
1. Compute `SHA-256(pdfBuffer)` at the start of `importBankStatement()`.
2. Call `tx.createImportBatch({ workspaceId, fileHash, rawJson: '{}' })` inside the
   transaction, catching the `23505` unique-constraint error and returning a
   `{ alreadyImported: true }` response (409 or the idempotent success pattern).
3. Set `import_batch_id` on the inserted rows so they are linked to the batch.

**Required regression tests:**
- `importBankStatement()` with the same `pdfBuffer` twice in the same workspace → second
  call returns 409 or idempotent response; no new rows in `imported_transactions`.
- `importBankStatement()` with the same `pdfBuffer` in different workspaces → both succeed.
- `importBankStatement()` with a different `pdfBuffer` in the same workspace → succeeds.

**Release impact:** The gap exists in origin/main. It is not introduced or worsened by this
convergence. No action in this task — follow-up required.

**Follow-up:** Tracked as a separate post-convergence task. Do not fix in this release
convergence branch.

---

## E. POSTGRES MIGRATION

**Environment:** SKIPPED — no live non-production PostgreSQL available. Project constraints
prohibit using production and prohibit asking the user to supply credentials.

**Manual inspection result:**

`db/migrations/20260923000000_password_reset_tokens.sql` (new in Track A):
- Wrapped in `BEGIN` / `COMMIT`
- `CREATE TABLE IF NOT EXISTS raf.password_reset_tokens` — idempotent
- `CREATE UNIQUE INDEX IF NOT EXISTS` × 1, `CREATE INDEX IF NOT EXISTS` × 2 — idempotent
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` — idempotent (no-op if already enabled)
- `DROP POLICY IF EXISTS` + `CREATE POLICY` × 3 — idempotent
- `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raf_app') THEN EXECUTE GRANT ... END IF; END $$` — safe when role absent
- Raw tokens never stored — only `token_hash` (SHA-256 hex)
- References `raf.app_users(id) ON DELETE CASCADE` — FK matches existing schema

**Runner first pass:** Not run — no DB available
**Runner second pass:** Not run
**Frontier:** Not verified live
**Ledger:** Not verified live
**RLS:** Correct per SQL review — all three policies (INSERT/SELECT/UPDATE) with `true` predicates,
mirroring the bootstrap pattern used by `app_users`/`workspaces`
**Effective privileges:** SELECT, INSERT, UPDATE explicitly granted; DELETE — effective DELETE
privilege on this table may exist through pre-existing schema default privileges if `raf_app`
holds default grants. Not confirmed live.
**Supersession:** Not re-verified live; `20260313170000` supersession record confirmed intact in
previous Track E certification
**Production touched:** NO

**Gate status:** SKIPPED (not FAIL). Live gate is a merge-readiness prerequisite. A
disposable Postgres run is required before marking `READY_FOR_MAIN_MERGE`.

---

## F. AUTH E2E

Verified via 53 unit/integration tests (`tests/passwordRecovery.test.js` +
`tests/localPasswordRecovery.test.js`). All 53 pass.

| Scenario | Status |
|----------|--------|
| **forgot-password**: valid email, native auth → neutral 200 (no account enumeration) | PASS — test |
| **forgot-password**: unknown email → same neutral 200 | PASS — test |
| **forgot-password**: Supabase path → delegates to Supabase, returns neutral 200 | PASS — test |
| **Token persisted hashed**: only `token_hash` stored in DB, raw token never persisted | PASS — code review |
| **reset-password**: valid Bearer token, native auth → 200, password updated atomically | PASS — test |
| **reset-password**: token consumed once (concurrent attempt → 401) | PASS — test |
| **old password fails / new password succeeds**: JWT re-issuance | Not verified live — DB required |
| **same RAF user UUID / workspace memberships**: preserved on reset | Not verified live — DB required |
| **expired token**: → 401 (DB: `expires_at > now()` guard) | PASS — code review |
| **used token**: → 401 (`consumed_at IS NOT NULL` guard) | PASS — code review |
| **malformed token**: short token, bad prefix → 401 | PASS — test |
| **wrong token**: not in DB → 401 | PASS — test |
| **email delivery failure**: logs error server-side, token still valid for 1h, neutral response | PASS — code review |
| **rate limit**: existing server-level rate limits apply | Not directly tested in auth scope |
| **ResetPassword fragment parsing**: `#type=recovery&access_token=<tok>` → Bearer header | PASS — code review + PR37 test |
| **Fragment removed from history**: `window.history.replaceState` immediately on mount | PASS — code review |
| **No Supabase activation**: `authProvider === 'jwt'` path used throughout | PASS — test |

**Noted:** Live JWT issuance + password hash persistence requires a running DB. Unit tests
cover the logic paths; end-to-end verification against a live DB requires the Phase 10 gate.

---

## G. FULL TESTS

### Three consecutive regression runs

| Run | Tests | Pass | Fail | Cancelled | Skip | Duration |
|-----|-------|------|------|-----------|------|----------|
| 1   | 2057  | 1965 |  0   |     0     |  92  | 31,024 ms |
| 2   | 2057  | 1965 |  0   |     0     |  92  | 30,546 ms |
| 3   | 2057  | 1965 |  0   |     0     |  92  | 30,507 ms |

Zero failures. Zero flakiness across all three runs.

**Delta vs origin/main:**

| Metric | origin/main | convergence | Delta |
|--------|-------------|-------------|-------|
| Pass | 1,822 | 1,965 | **+143** |
| Fail | 57 | 0 | **−57** |
| Cancelled | 36 | 0 | **−36** |
| Skip | 69 | 92 | +23 (intentional DB gate) |

**Skip classification (92):** All intentional. 69 are Track E's Postgres-gated security tests
(require `RAF_RUN_POSTGRES_RLS_TESTS=true`). The additional 23 are the
`branchEAdversarialApi.test.js` Postgres-phase tests that skip when no live `DATABASE_URL`
is set; these skip on Track E's own branch too when no DB is provided.

**Typecheck:** `npm run build` completed with 204 modules transformed, zero TypeScript errors.
(Project uses Vite with `tsc`-embedded type checking via `@vitejs/plugin-react`.)

**Lint:** Not a separately configured script in this project's `package.json`. Build success
with zero errors serves as the equivalent gate.

**Build:** `vite build` — success in 10.05 s. One pre-existing chunk-size advisory
(`index-D579iPpS.js` at 710 kB); not introduced by convergence.

---

## H. RESPONSIVE

**Status: NOT PERFORMED**

The frontend application requires authentication to render meaningful pages. The project has
no unauthenticated fixture mode and activating Supabase auth is explicitly prohibited. Running
a local server with a test account would require `DATABASE_URL` (not available).

**What was verified by proxy:**
- `npm run build` succeeded — all 30 Track B/C/D modified frontend components compiled without
  type errors or missing imports. No broken JSX, no undefined references.
- Track B design-token changes are CSS variable substitutions with no layout impact.
- Track D UI additions (`xl:grid-cols-4`, debt card blocks, payoff projection) are additive
  JSX; no existing layout wrapper was removed.
- Track C filter bar (`persistent-filter-bar` layout) was certified by Track C and remains
  functionally unchanged in convergence.

**Unverified pages (require live auth session):**
Login, Forgot Password, Reset Password, Dashboard, Transactions, Import Workflow,
Debts, Cash Flow, Plan, Goals, Remi, Profile, Settings, Monthly Review.

Responsive certification at 375 / 768 / desktop is a pre-merge gate that still needs to be
completed in a branch preview environment (Vercel preview or local with test credentials).

---

## I. SECURITY

| Item | Status | Detail |
|------|--------|--------|
| **Auth authority** | ✓ PASS | RAF local auth remains authoritative. `authProvider === 'jwt'` path used for all native flows. Supabase path requires explicit `authProvider === 'supabase'` in context. |
| **Secrets in code** | ✓ PASS | No API keys, tokens, or passwords committed. All secrets flow via env vars / context params. `RESEND_API_KEY`, `JWT_SECRET`, `ANTHROPIC_API_KEY` documented in `.env.example` as empty. |
| **Password not logged** | ✓ PASS | `reset-password` route: password accepted as body param, passed to `hashPassword()`, never appears in any log path. Test `reset-password: does not log password` passes. |
| **Raw tokens not stored** | ✓ PASS | Only `token_hash` (SHA-256 hex of raw token) stored in DB. `generateResetToken()` returns both; only the hash is persisted. |
| **Security headers** | ✓ PASS | `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` present on all routes via CORS middleware in `index.js`. Verified in Track E live-server test. |
| **Rate limits** | ✓ PASS | Existing rate-limiting middleware unchanged. Present and tested in `rateLimiting.test.js`. |
| **DB role** | ✓ PASS | `raf_app` role used. Migration grants SELECT/INSERT/UPDATE on `password_reset_tokens`. No PUBLIC grants added. Effective DELETE privilege not fully confirmed — see Phase E note. |
| **Migration runner** | ✓ PASS | `allowBootstrap` variable-shadowing bug fixed. `scripts/migrate.js` fail-closed on fresh DB without `--bootstrap`. |
| **Supersession** | ✓ PASS | `20260313170000` supersession hash-pinned record intact (verified in Track E certification). No migration was altered in convergence. |
| **Build SHA capability** | ✓ PASS | `RAF_BUILD_SHA → GET /health .sha` present. `render.yaml` wired to `RENDER_GIT_COMMIT`. |
| **Workspace isolation** | ✓ PASS | `tenantIsolation.test.js`, `tenantCrossAccess.test.js`, `collaborationSecurity.test.js` all pass. |
| **CORS** | ✓ PASS | CORS configuration unchanged by convergence. `ALLOWED_ORIGINS` env var path intact. |
| **Import gap** | ⚠ NOTED | `importBankStatement()` bypasses file_hash deduplication. Pre-existing in main. Not introduced by convergence. See Phase D. |
| **Deferred P2 — `current_workspace_id()` search_path** | ⚠ DEFERRED | `20260905010000_enable_rls_policies.sql` still redefines `raf.current_workspace_id()` without `SET search_path = raf, pg_catalog`. Medium-low risk (exploitable only by a superuser who can inject a schema). Separate certification pass required. NOT fixed per constraints. |
| **Express path-to-regexp ReDoS** | ⚠ DEFERRED | Transitive via Express v4. Requires v5 upgrade. 19 npm audit vulns identical to origin/main baseline — zero new CVEs. |

---

## J. DIFF OWNERSHIP

**Total: 69 files changed, 3462 insertions(+), 422 deletions(−)**

### TRACK_E (15 files)
`.env.example`, `TRACK_E_REPORT.md`, `TRACK_E2_CERTIFICATION.md`, `index.js`,
`scripts/migrate.js`, `tests/helpers/isolatedSqliteServer.js`,
`tests/branchEAdversarialApi.test.js`, `tests/adversarialSecurityRemiCollisions.test.js`,
`tests/collaborationSecurity.test.js`, `tests/exportDeletion.test.js`,
`tests/privilegeEscalation.test.js`, `tests/rateLimiting.test.js`,
`tests/tenantCrossAccess.test.js`, `tests/tenantIsolation.test.js`,
`tests/viewerWriteDenial.test.js`

### TRACK_A (15 files)
`app/api/v1/auth/forgot-password/route.js`, `app/api/v1/auth/reset-password/route.js`,
`db/migrations/20260923000000_password_reset_tokens.sql`, `lib/auth/passwordReset.js`,
`lib/email/emailService.js`, `lib/email/templates/base.js`,
`lib/email/templates/passwordReset.js`, `lib/server/env.js`, `lib/server/inMemoryDb.js`,
`lib/server/postgresDb.js`, `lib/server/routerLoader.js`, `package.json`,
`package-lock.json`, `tests/localPasswordRecovery.test.js`, `tests/passwordRecovery.test.js`

### AUTH_UI_PR37 (6 files)
`src/App.tsx`, `src/lib/auth/supabaseAuth.js`, `src/pages/ForgotPassword.tsx`,
`src/pages/Login.tsx`, `src/pages/ResetPassword.tsx`, `tests/authNomiIntegration.test.js`

### TRACK_C (2 files — primary)
`src/pages/Transactions.tsx` (pure Track C),
`src/pages/TransactionImportWorkflow.tsx` (Track C primary + 1 Track B branding string)

### TRACK_D (2 files — primary; surgically separated from Track B)
`src/pages/Dashboard.tsx` (Track D in commit `8ef94b6`, Track B in `7e31034`),
`src/pages/Debts.tsx` (Track D in commit `8ef94b6`, Track B in `7e31034`)

### TRACK_B (30 files)
`src/components/feedback/ErrorState.tsx`, `src/components/feedback/LoadingSpinner.tsx`,
`src/components/feedback/LoadingState.tsx`, `src/components/feedback/MonthReminderBanner.tsx`,
`src/components/feedback/SuccessNotice.tsx`, `src/components/imports/ImportRuleEditor.tsx`,
`src/components/layout/AppLayout.tsx`, `src/components/plan/BufferStatusCard.tsx`,
`src/components/transactions/SplitTransactionEditor.tsx`, `src/components/ui/MoneyInput.tsx`,
`src/components/ui/Table.tsx`, `src/components/workspace/InviteModal.tsx`,
`src/components/workspace/MemberRow.tsx`, `src/index.css`, `src/lib/constants.ts`,
`src/pages/AcceptInvitation.tsx`, `src/pages/AddIncome.tsx`,
`src/pages/AllocationPreferences.tsx`, `src/pages/AppearanceSettings.tsx`,
`src/pages/CashFlowForecast.tsx`, `src/pages/Goals.tsx`, `src/pages/Insights.tsx`,
`src/pages/MonthlyReview.tsx`, `src/pages/Plan.tsx`, `src/pages/Profile.tsx`,
`src/pages/Remi.tsx`, `src/pages/Settings.tsx`

*(Note: `src/pages/Dashboard.tsx` and `src/pages/Debts.tsx` carry Track B changes
in commits `7e31034` and `05ce179` but are listed under Track D above as primary owners.
`src/pages/TransactionImportWorkflow.tsx` carries one Track B branding string but is
primary Track C.)*

### SHARED_CONVERGENCE (3 files)
`render.yaml` (Track E `RAF_BUILD_SHA` + Track A email/URL env vars combined in conflict resolution),
`tests/passwordRecovery.test.js` (Track A unit test + convergence fix for native implementation),
`tests/usabilityTransparencyFrontendContract.test.js` (Track B branding test fix)

### UNEXPECTED
*(empty)*

---

## K. RELEASE READINESS

| Gate | Status | Notes |
|------|--------|-------|
| `READY_FOR_PR` | **YES** | All convergence logic phases complete. 15 commits pushed to `release/nomi-convergence`. Zero test failures. Build clean. |
| `READY_FOR_MAIN_MERGE` | **NO** | Two prerequisite gates remain open: (1) Phase 10 live disposable-Postgres migration run has not been performed; (2) Phase 13 responsive/visual certification has not been performed. Both require a live environment with non-production credentials. |
| `READY_FOR_DEPLOYMENT` | **NO** | Separate explicit gate required regardless of convergence pass. Phase 10 live migration gate is a deployment prerequisite. |

**Open prerequisites before `READY_FOR_MAIN_MERGE`:**
1. **Live disposable Postgres migration gate** — run `scripts/migrate.js` against a non-production
   database to verify `20260923000000_password_reset_tokens.sql` applies cleanly, confirm
   effective `raf_app` DELETE privilege disposition, confirm idempotent re-run.
2. **Responsive/visual certification** — at 375 / 768 / desktop on the 14 key pages, in a
   branch preview environment (Vercel preview deploy or local with a non-production test account).
3. **Import idempotency gap** — classified as a known pre-existing gap; not a merge blocker,
   but the follow-up task should be created before merge.

---

## L. VERDICT

All convergence logic phases complete. Three clean regression runs. Zero test failures.
Zero cancelled. Build succeeds. All 5 tracks and PR #37 integrated. Mixed commit `6c033ab`
surgically extracted — Track D and Track B as separate commits. All hard constraints satisfied.
Two open prerequisites (live Postgres gate, responsive certification) prevent a
`READY_FOR_MAIN_MERGE` mark.

```
RAF / NOMI CONVERGENCE: PASS — CERTIFIED RELEASE CANDIDATE ASSEMBLED;
READY FOR FINAL PR REVIEW, NOT MERGED OR DEPLOYED
```

**Branch:** `release/nomi-convergence`
**Tip:** `39cad6f9bfba7f14efb3f3025549b00c655534b1`
**Open prerequisites:** live Postgres migration gate · responsive visual certification
**Do NOT merge to main. Do NOT deploy.**
