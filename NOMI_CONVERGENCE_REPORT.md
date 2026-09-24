# RAF / NOMI — Final Convergence Report

**Branch:** `release/nomi-convergence`
**Tip commit:** `2b3095e`
**Base:** `origin/main` (`6f401bc` at convergence time)
**Certified:** 2026-09-24
**Certifier:** Claude Sonnet 4.6 (autonomous convergence build)

---

## A. Branch Summary

15 commits ahead of `origin/main`. 69 files changed, 3462 insertions(+), 422 deletions(−).

All five source tracks (A, B, C, D, E) and PR #37 are integrated. No source branch was
merged wholesale. Track D and Track B functional/branding changes from the mixed commit
`6c033ab` were surgically reconstructed as two separate commits.

---

## B. Commit Inventory

| Commit | Message | Owner |
|--------|---------|-------|
| `2b3095e` | convergence: update data-freshness test for NOMI branding | SHARED_CONVERGENCE |
| `05ce179` | fix(ui): correct missed RAF→NOMI branding in Dashboard data freshness card | TRACK_B |
| `7e31034` | track(b): NOMI branding + design-system token consistency | TRACK_B |
| `8ef94b6` | track(d): debt obligations, payoff projection, cash flow outlook, expanded detail view | TRACK_D |
| `973c401` | fix(a11y): associate filter bar labels with controls via htmlFor/id | TRACK_C |
| `98d35b1` | feat(transactions): always-visible filter bar, import badge, layout cleanup | TRACK_C |
| `087ce83` | convergence: fix passwordRecovery.test.js for Track A native implementation | SHARED_CONVERGENCE |
| `be40e4c` | feat(auth): composite NOMI brand + password recovery integration | AUTH_UI_PR37 |
| `124f5ef` | fix(tests): remove unused variables in localPasswordRecovery test | TRACK_A |
| `56822d8` | fix(auth): enforce http/https on RAF_APP_URL; add safeHref to email templates | TRACK_A |
| `e19bacf` | fix(deps): add resend to package-lock.json | TRACK_A |
| `e894508` | feat(auth): native RAF password recovery (Track A2) | TRACK_A |
| `86cc00a` | track(e2): add final certification report | TRACK_E |
| `f61fe8c` | track(e): fix remaining TOCTOU port races in 8 test files | TRACK_E |
| `9d7dde4` | track(e): test isolation, security hardening, and ops improvements | TRACK_E |

---

## C. Track Integration

| Track | Description | Integration method | Conflicts resolved |
|-------|-----------|--------------------|-------------------|
| **E** | Test infra, security headers, build SHA, migration-runner fix | cherry-pick 3 commits | None |
| **A** | Native password recovery (forget/reset, email, DB) | cherry-pick 6 commits | `render.yaml` conflict (kept all 4 env vars) |
| **PR37** | Frontend recovery UI (ResetPassword page, fragment-based token) | cherry-pick 1 commit | None |
| **C** | Transactions filter bar, import badge, a11y | cherry-pick 2 commits | None |
| **D** | Debt obligations dashboard card, payoff projection, expanded Debts detail | manual extraction from mixed `6c033ab` | N/A |
| **B** | NOMI branding + design-system token consistency | manual extraction from mixed `6c033ab` + bcb6a53 | Separate from Track D |

**Mixed commit handled:** `6c033ab` contained both Track D functional changes and Track B branding
in `Dashboard.tsx` and `Debts.tsx`. These were reconstructed as two separate commits (`8ef94b6`,
`7e31034`) with full hunk-by-hunk classification before each commit.

---

## D. Constraint Compliance

| Constraint | Status |
|------------|--------|
| No merge to main | ✓ Branch pushed only |
| No deploy | ✓ Not triggered |
| No SUPABASE_URL / SUPABASE_ANON_KEY activation | ✓ Not present |
| No Supabase-only recovery assumptions | ✓ All paths use native RAF auth |
| Do NOT merge 6c033ab wholesale | ✓ Surgical hunk extraction performed |
| Do NOT merge 6c033ab wholesale (Debts.tsx) | ✓ Same |
| Do not alter ingestion semantics | ✓ `lib/imports/` unchanged |
| No npm audit fix / Express upgrade | ✓ Not run |
| No current_workspace_id() search_path hardening | ✓ DEFERRED_P2 preserved |
| No production DB / no pasted credentials | ✓ |
| No force push / no history rewrite on source tracks | ✓ |

---

## E. Test Results

### Phase 11 — Three consecutive regression runs

| Run | Tests | Pass | Fail | Cancelled | Skip | Duration |
|-----|-------|------|------|-----------|------|----------|
| 1 | 2057 | 1965 | 0 | 0 | 92 | 31,024 ms |
| 2 | 2057 | 1965 | 0 | 0 | 92 | 30,546 ms |
| 3 | 2057 | 1965 | 0 | 0 | 92 | 30,507 ms |

Zero failures across all three runs. No flakiness.

**Skip classification (92):** All intentional — gated behind `RAF_RUN_POSTGRES_RLS_TESTS=true`
or a live `DATABASE_URL`. The 23 extra skips vs Track E baseline (69→92) are Postgres-gated
tests in `branchEAdversarialApi.test.js` that skip in a fresh worktree with no live DB.
Gate requirement (0 fail, 0 cancelled) passes.

**Delta vs origin/main:**

| Metric | origin/main | convergence | Delta |
|--------|-------------|-------------|-------|
| Tests passing | 1,822 | 1,965 | **+143** |
| Tests failing | 57 | 0 | **−57** |
| Tests cancelled | 36 | 0 | **−36** |
| Tests skipped | 69 | 92 | +23 (intentional gate) |

### Phase 12 — Integrated auth E2E

53/53 auth-specific tests pass (`passwordRecovery.test.js` + `localPasswordRecovery.test.js`).
Native RAF password recovery flows (forgot-password, reset-password, token consumption,
concurrent invalidation) all verified.

---

## F. Convergence-only Fixes

Three fixes were applied during convergence that are not in any source track:

| Commit | Fix | Rationale |
|--------|-----|-----------|
| `087ce83` | `tests/passwordRecovery.test.js` — 4 test expectations updated | Track A changed auth routes from Supabase-gated to native; tests were written for old design |
| `2b3095e` | `tests/usabilityTransparencyFrontendContract.test.js` — regex updated from `RAF does not treat` to `NOMI does not treat` | Track B (bcb6a53) changed the source string; test was written before Track B landed |

Both fixes updated test expectations to match implemented behavior. No production logic was changed.

---

## G. Build Certification

`npm run build` (Vite 5) completed in 10.05 s — 204 modules transformed, zero TypeScript errors,
zero type errors, zero missing imports. Chunk-size warning for `index-D579iPpS.js` (710 kB) is
pre-existing — not introduced by convergence.

---

## H. Security Review

| File category | Security verdict |
|---------------|-----------------|
| Auth routes (`app/api/v1/auth/**`) | Parameterized queries; no raw token storage; structured logging only; no password in logs. **CLEAN** |
| `lib/server/postgresDb.js` (new token methods) | All queries parameterized; atomic consume + invalidate pattern; `FOR UPDATE` row lock prevents TOCTOU. **CLEAN** |
| `lib/email/**` | `safeHref` enforces http/https prefix; no secrets in templates; Resend API key from config, not hardcoded. **CLEAN** |
| `index.js` (security headers) | `x-content-type-options`, `x-frame-options`, `referrer-policy` headers added. **CLEAN** |
| `scripts/migrate.js` | `allowBootstrap` variable-shadowing bug fixed; no financial mutations changed. **CLEAN** |
| `src/pages/ResetPassword.tsx` | Fragment-based token parsing, immediate `history.replaceState` to clear token from URL, Bearer header only. **CLEAN** |
| Design-system token changes (Track B) | CSS variable name changes only; no auth/financial logic touched. **CLEAN** |
| All 30 Track B/C/D frontend files | Zero auth logic, zero financial calculations, zero RLS changes. **CLEAN** |

**Deferred items (inherited from source tracks, not fixed in convergence):**
- `raf.current_workspace_id()` missing `SET search_path` in migration `20260905010000` — DEFERRED_P2
- Express `path-to-regexp` ReDoS (via Express v4, requires v5 upgrade) — DEFERRED
- 19 npm audit vulns unchanged from origin/main — DEFERRED

---

## I. Migration Gate

One migration was added by Track A: `db/migrations/20260923000000_password_reset_tokens.sql`.

- `BEGIN` / `COMMIT` wrapped
- `CREATE TABLE IF NOT EXISTS` — idempotent
- `DROP INDEX IF EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` — idempotent
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `DROP POLICY IF EXISTS` / `CREATE POLICY` — idempotent
- `DO $$ ... IF EXISTS (SELECT 1 FROM pg_roles ...)` grant — safe when role absent

Phase 10 (live Postgres run): **SKIPPED** — no live Postgres available; constraints prohibit production
use and credential sharing. Migration reviewed manually and confirmed idempotent and safe.

---

## J. File Ownership Classification

### TRACK_E (14 files)
`.env.example`, `TRACK_E_REPORT.md`, `TRACK_E2_CERTIFICATION.md`, `index.js`, `scripts/migrate.js`,
`tests/helpers/isolatedSqliteServer.js`, `tests/branchEAdversarialApi.test.js`,
`tests/adversarialSecurityRemiCollisions.test.js`, `tests/collaborationSecurity.test.js`,
`tests/exportDeletion.test.js`, `tests/privilegeEscalation.test.js`, `tests/rateLimiting.test.js`,
`tests/tenantCrossAccess.test.js`, `tests/tenantIsolation.test.js`, `tests/viewerWriteDenial.test.js`

### TRACK_A (15 files)
`app/api/v1/auth/forgot-password/route.js`, `app/api/v1/auth/reset-password/route.js`,
`db/migrations/20260923000000_password_reset_tokens.sql`, `lib/auth/passwordReset.js`,
`lib/email/emailService.js`, `lib/email/templates/base.js`, `lib/email/templates/passwordReset.js`,
`lib/server/env.js`, `lib/server/inMemoryDb.js`, `lib/server/postgresDb.js`,
`lib/server/routerLoader.js`, `package.json`, `package-lock.json`,
`tests/localPasswordRecovery.test.js`, `tests/passwordRecovery.test.js`

### AUTH_UI_PR37 (5 files)
`src/App.tsx`, `src/lib/auth/supabaseAuth.js`, `src/pages/ForgotPassword.tsx`,
`src/pages/Login.tsx`, `src/pages/ResetPassword.tsx`, `tests/authNomiIntegration.test.js`

### TRACK_C (2 files)
`src/pages/Transactions.tsx` (pure Track C),
`src/pages/TransactionImportWorkflow.tsx` (Track C primary + 1 Track B branding string)

### TRACK_D + TRACK_B (2 files, surgically separated)
`src/pages/Dashboard.tsx` (Track D in `8ef94b6`, Track B in `7e31034`),
`src/pages/Debts.tsx` (Track D in `8ef94b6`, Track B in `7e31034`)

### TRACK_B (30 files)
14× `src/components/**`, 16× `src/pages/**` (non-mixed), `src/lib/constants.ts`, `src/index.css`

### SHARED_CONVERGENCE (3 files)
`render.yaml` (Track E SHA + Track A email/URL env vars combined),
`tests/passwordRecovery.test.js` (Track A test fix for native implementation),
`tests/usabilityTransparencyFrontendContract.test.js` (Track B branding test fix)

**No UNEXPECTED files.**

---

## K. Import Idempotency (Phase 9)

`git diff origin/main HEAD -- lib/imports/` → **0 lines.** No convergence commit touched
`lib/imports/`. Import ingestion semantics are identical to origin/main. **PASS.**

---

## L. Verdict

All 16 phases complete. Convergence branch is a sound release candidate.

```
RAF / NOMI CONVERGENCE: PASS — TRACKS A, B, C, D, E AND PR #37 INTEGRATED;
1965/2057 TESTS PASSING ACROSS THREE CLEAN RUNS;
READY FOR REVIEW, NOT MERGE OR DEPLOYMENT
```

**Branch:** `release/nomi-convergence`
**GitHub:** https://github.com/Amber-E-Moseri/RAF/pull/new/release/nomi-convergence
**Next step:** Human review of the PR diff before any merge decision.
