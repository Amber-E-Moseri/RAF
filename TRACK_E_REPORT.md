# Track E — Quality, Security & Production Readiness Report

**Branch:** `track-e/quality-security-prod-readiness`
**Base:** `origin/main` @ 6f401bc
**Date:** 2026-09-24
**Test baseline (main):** 1984 tests · 1822 pass · 57 fail · 36 cancelled · 69 skipped
**Test result (this branch):** 1984 tests · 1915 pass · 0 fail · 0 cancelled · 69 skipped
**New failures introduced:** 0

---

## A. TEST INFRASTRUCTURE

### Root Cause

Two distinct server-startup failure patterns caused 57 failures and 36 cancellations:

**Issue 1 — TOCTOU port race in `isolatedSqliteServer.js`**
`getAvailablePort()` opens a socket on port 0, reads the OS-assigned port, then closes the socket. Under the default Node.js 22 test parallelism (up to 12 concurrent files), another test process grabs that port in the window between release and bind. The child process logs `[RAF] persistence: sqlite` then crashes silently at `app.listen()` because `app.listen()` had no error handler — the crash was silent.

11 test files use `startIsolatedSqliteServer`. Parallel load of 11×2 server instances saturated ports consistently.

**Issue 2 — `Math.random()` port in `branchEAdversarialApi.test.js`**
Same TOCTOU race, compounded by Neon Postgres startup latency under high system load from concurrent spawns.

### Fixes Implemented

1. **`tests/helpers/isolatedSqliteServer.js`**: Refactored into a private `startIsolatedSqliteServerOnce` function wrapped by the public `startIsolatedSqliteServer` with up to 3 retries on port-collision startup failures. Each retry allocates a fresh OS port. A 200 ms grace period after killing the previous child gives the OS time to release the port.

2. **`tests/branchEAdversarialApi.test.js`**: Replaced `Math.random()` port with `getAvailablePort()` and added the same retry loop (up to 3 attempts) in the `before()` hook.

3. **`index.js`**: Added an `error` event handler on the `server` object returned by `app.listen()`. Silent EADDRINUSE crashes now emit a structured JSON log and `process.exit(1)`, making the cause visible in test startup logs.

### Verification

- All 11 isolated-server test files now pass reliably in the full parallel suite.
- Tests were run twice consecutively with 0 failures both times.
- No assertions were weakened; no tests were skipped.

### Known Flakiness: None

All prior flaky tests are traced to the port-race root cause and are fixed.

---

## B. E2E COVERAGE MAP

| Flow | Status | Coverage |
|------|--------|----------|
| Signup | COVERED | `tests/liveApi.test.js`, `tests/branchEAdversarialApi.test.js`, `tests/supabaseAuthRoutes.test.js` |
| Login | COVERED | `tests/liveApi.test.js`, `tests/branchEAdversarialApi.test.js`, `tests/supabaseAuthRoutes.test.js` |
| Logout / token revocation | COVERED | `tests/jwtBlacklist.test.js`, `tests/branchEAdversarialApi.test.js` |
| Password recovery | COVERED | `tests/supabaseAuthRoutes.test.js` (forgot-password + reset-password routes) |
| Workspace switching | PARTIAL | Login returns workspace list; `branchEAdversarialApi` tests cross-workspace boundaries. No explicit "switch active workspace" E2E flow. |
| Transaction creation | COVERED | `tests/createTransaction.test.js`, `tests/liveApi.test.js` |
| Statement import | COVERED | `tests/bankStatementImports.test.js`, `tests/importWorkflow.test.js`, `tests/liveApi.test.js` |
| Duplicate import | COVERED | `tests/postgresImportFileHashIdempotency.test.js` |
| Reconciliation | COVERED | `tests/accountReconciliationFreshness.test.js`, `tests/debtPaymentReconciliation.test.js` |
| Debt payment | COVERED | `tests/debtPaymentMatching.test.js`, `tests/debts.test.js`, `tests/debtObligation.test.js` |
| Forecast | COVERED | `tests/cashFlowForecasting.test.js`, `tests/cashFlowForecastReport.test.js`, `tests/adversarialCashFlowForecast.test.js` |
| Monthly review | COVERED | `tests/reportsAndMonthlyReviews.test.js`, `tests/applyMonthlyReview.test.js`, `tests/monthlyReviewFrontendContract.test.js` |
| Monthly close | COVERED | `tests/monthlyClose.test.js`, `tests/adversarialMonthLifecycle.test.js` |

**MISSING:** No explicit E2E test for the workspace-switching flow (a user who owns or is a member of multiple workspaces selecting a different active workspace in the UI). This is covered implicitly by role/isolation tests but has no dedicated test.

---

## C. SECURITY

### C1. RLS / Workspace Isolation
**Status: VERIFIED STRONG**
- RLS is enforced at the Postgres layer via the `raf_app` NOBYPASSRLS role.
- `branchERlsEnforcement.test.js` (skipped in CI — gated behind `RAF_RUN_POSTGRES_RLS_TESTS=true`) directly probes SQL-level tenant isolation.
- `branchEAdversarialApi.test.js`, `tenantIsolation.test.js`, `tenantCrossAccess.test.js`, `postgresRepositoryTenantIsolation.test.js` cover API-level isolation.
- Workspace context is set from trusted headers, not from request bodies.

### C2. `raf.current_workspace_id()` search_path hardening — DEFERRED
**Status: KNOWN, CLASSIFIED**

Migration `20260903090000` defines `raf.current_workspace_id()` with `SET search_path = raf, pg_catalog`.
Migration `20260905010000` redefines it with `LANGUAGE sql STABLE SECURITY DEFINER` but **omits** `SET search_path` — the later migration reverts the hardening.

**Risk:** Without `SET search_path`, a superuser could inject a schema named `raf` in the search path and shadow functions. In practice the `raf_app` role has no `CREATE SCHEMA` privilege, limiting exploitability. Still a hardening gap.

**Recommended fix (scoped migration):**
```sql
CREATE OR REPLACE FUNCTION raf.current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = raf, pg_catalog
AS $$ SELECT NULLIF(current_setting('raf.workspace_id', true), '')::uuid $$;
```

**NOT implemented here** — deferred to a standalone migration + certification pass per Track E constraints.

### C3. `scripts/migrate.js` allowBootstrap shadowing — FIXED
**Status: BUG, FIXED**

Line 361 set `const allowBootstrap = process.argv.includes('--bootstrap')`.
Line 369 (inside the `try` block) re-declared `const allowBootstrap = process.env.RAF_ALLOW_BOOTSTRAP === 'true'`, shadowing the outer variable. This made the `--bootstrap` CLI flag ineffective.

**Fix applied:** Merged both checks at the point of declaration:
```js
const allowBootstrap = process.argv.includes('--bootstrap') || process.env.RAF_ALLOW_BOOTSTRAP === 'true';
```
The inner re-declaration was removed.

### C4. Sensitive Logging
**Status: CLEAN**
- All server-side log calls reviewed. No passwords, tokens, connection strings, or JWTs appear in log output.
- Three non-JSON console calls exist (`lib/imports/bankStatementImports.js`, `lib/server/env.js`) — none expose secrets.
- Sentry integration strips request bodies and Authorization headers before sending.

### C5. CORS Configuration
**Status: ADEQUATE**
- CORS is implemented as an allowlist (localhost + explicit `ALLOWED_ORIGINS`). No wildcard `*` in production.
- `ALLOWED_ORIGINS` is documented in `.env.example` and `render.yaml`.

### C6. Security Headers — ADDED
**Status: IMPROVED**
Three headers added to all API responses in `index.js`:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`

**Missing (deferred):** `Strict-Transport-Security` and `Content-Security-Policy`. HSTS is best set at the CDN/load-balancer level; CSP for the frontend SPA is a Track B concern.

### C7. Rate Limiting
**Status: COVERED**
`tests/rateLimiting.test.js` verifies login and signup rate limits. `RAF_AUTH_RATE_LIMIT_MAX` is configurable.

### C8. Dependency Vulnerabilities
**Status: 19 VULNERABILITIES (TRIAGED)**

| Package | Severity | Scope | Fix |
|---------|----------|-------|-----|
| `path-to-regexp` | HIGH | Prod (via express) | Requires express v5 upgrade |
| `body-parser` | Moderate | Prod (via express) | Requires express upgrade |
| `qs` | Moderate | Prod (via express) | Requires express upgrade |
| `@remix-run/router` | Moderate | Frontend only | `npm audit fix` |
| `postcss` | HIGH | Dev only | `npm audit fix` |
| `brace-expansion` | HIGH | Dev only | `npm audit fix` |
| `browserslist` | HIGH | Dev only | `npm audit fix` |
| `nanoid` | HIGH | Dev only | `npm audit fix` |
| `picomatch` | HIGH | Dev only | `npm audit fix` |
| `flatted` | HIGH | Dev only | `npm audit fix` |
| `js-yaml` | HIGH | Dev only | `npm audit fix` |
| `path-to-regexp` | HIGH | Prod | Express v5 upgrade |
| `@babel/core` | Moderate | Dev only | `npm audit fix` |
| `esbuild/vite` | Moderate | Dev only | `npm audit fix --force` (Vite 8 breaking) |
| others | Low | Dev only | `npm audit fix` |

**Immediate action recommended:** `npm audit fix` (safe for dev-only deps). The `path-to-regexp` ReDoS in express requires an `express` major version upgrade — out of scope for Track E but should be tracked.

**NOT applied here** — dependency upgrades can introduce regressions and warrant their own certification pass.

### C9. Dangerous DB Privileges
**Status: CORRECTLY RESTRICTED**
- Runtime role (`raf_app`) is `NOSUPERUSER NOBYPASSRLS NOCREATEROLE` — verified at startup by `checkRuntimeRolePrivileges()`.
- `tests/runtimeRoleStartupSecurity.test.js` asserts the runtime role check fails closed.
- `SECURITY DEFINER` functions are narrowly scoped and have `SET search_path` (with the exception noted in C2).

---

## D. PERFORMANCE

**Scope:** Findings only — no changes implemented.

| Area | Observation |
|------|-------------|
| Frontend bundle | Not measured — Vite builds were not profiled in this pass |
| Remi context payload | `remiDataMinimization.test.js` exists; payload size not instrumented |
| Dashboard queries | No `EXPLAIN ANALYZE` profiling done — no Postgres access in CI |
| Route loading | Express router uses `createApiRouter` with file-system discovery — no lazy loading |
| API request duplication | Not observed in test logs |
| Pagination | Transaction list has no explicit pagination cap visible in route handlers |

**Deferred:** Performance measurement requires a live Postgres environment with representative data. Recommend a dedicated profiling pass with `EXPLAIN ANALYZE` on dashboard and transaction-list queries.

---

## E. ACCESSIBILITY

**Scope:** Static code audit. No visual rendering or screen reader testing performed.

| Area | Status | Notes |
|------|--------|-------|
| ARIA labels on interactive elements | PARTIAL | Navigation buttons, modals, and key actions have `aria-label`. Quick-add menu has `role="menu"`. |
| Form labels (`htmlFor` / `<label>`) | PARTIAL | 15 `htmlFor` instances vs 16 unlabeled inputs. Several form inputs lack associated labels. |
| Table header scope | MISSING | `<th>` elements in `PlanExecutionTable` and `PlanExecutionCard` lack `scope="col"`. |
| Loading states | COVERED | `LoadingSpinner` uses `role="status" aria-live="polite"`. |
| Focus management | PARTIAL | 6 keyboard/focus event handlers found; modals have `aria-labelledby` but focus-trap is unverified. |
| Contrast | NOT AUDITED | CSS custom properties used throughout — contrast ratios not measured. |
| Dialog semantics | PARTIAL | `IncomeModal` has `aria-labelledby`; no `role="dialog"` observed. |

**Findings:**
- Table `<th>` elements should add `scope="col"` for screen-reader column association.
- Several inputs appear to lack associated `<label>` elements — these should use `htmlFor`/`id` pairs or `aria-label`.
- Modal focus trapping and initial focus target should be verified.

**Deferred:** Full accessibility audit requires browser-based tooling (axe, Lighthouse). Static scan surfaced gaps for remediation.

---

## F. OPERATIONS

| Item | Status | Notes |
|------|--------|-------|
| Liveness probe | PASS | `GET /health` — static 200, no DB |
| Readiness probe | PASS | `GET /api/v1/health` — pings DB, returns `{ ok, db }` |
| DB readiness check | PASS | `checkReadiness()` is isolated, never exposes connection details |
| Health endpoint auth | PASS | No token required for liveness or readiness |
| Error monitoring (Sentry) | CONFIGURED | `SENTRY_DSN` in `render.yaml`, strips auth headers |
| Structured logs | PARTIAL | Most logs are JSON; 3 non-JSON `console.log/error` calls remain |
| Deployment SHA visibility | ADDED | `RAF_BUILD_SHA` → `GET /health .sha` field; wired to `RENDER_GIT_COMMIT` in `render.yaml` |
| Migration status visibility | PASS | `node scripts/migrate.js --check` exits non-zero if unapplied migrations exist |
| Rollback procedure | NOT DOCUMENTED | No rollback runbook in docs/ |
| Backup/restore documentation | NOT DOCUMENTED | Neon provides PITR; no RAF-specific runbook |

**Additions:**
- `RAF_BUILD_SHA` env var added. When set (e.g. from `$RENDER_GIT_COMMIT` on Render), `GET /health` returns `{ sha }` for deployment attestation without exposing secrets.
- Documented in `.env.example` and wired in `render.yaml`.

---

## G. DOCUMENTATION

| Doc | Status | Notes |
|-----|--------|-------|
| `README.md` | STALE | Claims "1,569 passing · 0 failing · 26 skipped" — actual is **1,915 passing · 0 failing · 69 skipped** after fixes |
| `.env.example` | UPDATED | Added `ANTHROPIC_API_KEY` and `RAF_BUILD_SHA` (both used in production, previously undocumented) |
| `render.yaml` | UPDATED | Added `RAF_BUILD_SHA` wired to `$RENDER_GIT_COMMIT` |
| `docs/testing/RAF_FINAL_CERTIFICATION.md` | STALE | References old test counts; should be re-run after Track E merge |
| `AGENTS.md` | CURRENT | Accurately describes project constraints |
| Architecture docs | NOT AUDITED | Separate architecture-guide branch referenced; not modified per Track E constraints |
| Rollback / backup runbooks | MISSING | No runbook found in `docs/` |

**`README.md` test count is stale** — the suite has grown significantly since the certification was written (1,569 → 1,915 passing tests). The README should be updated after Track E merge.

---

## H. IMPLEMENTED CHANGES

| File | Change |
|------|--------|
| `tests/helpers/isolatedSqliteServer.js` | Refactored into `startIsolatedSqliteServerOnce` + retry wrapper; 200ms grace between retries |
| `tests/branchEAdversarialApi.test.js` | Replaced `Math.random()` port with `getAvailablePort()` + retry loop in `before()` |
| `index.js` | Added `server.on('error')` handler; added security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`); added `RAF_BUILD_SHA` → `GET /health .sha` |
| `scripts/migrate.js` | Fixed `allowBootstrap` variable shadowing — merged CLI flag and env var into a single declaration |
| `.env.example` | Documented `ANTHROPIC_API_KEY` and `RAF_BUILD_SHA` |
| `render.yaml` | Added `RAF_BUILD_SHA` env var wired to `$RENDER_GIT_COMMIT` |

---

## I. DEFERRED CHANGES

| Item | Risk | Reason Deferred |
|------|------|-----------------|
| `raf.current_workspace_id()` search_path hardening | Medium | Requires standalone migration + certification pass; do not implement opportunistically |
| `npm audit fix` (dev deps) | Low | Vite 8 is a breaking change; all others are dev-only; warrant their own pass |
| `express` v5 upgrade (fixes path-to-regexp ReDoS) | Medium | Major version bump; requires integration testing |
| `Content-Security-Policy` header | Low | Frontend SPA concern; Track B scope |
| `Strict-Transport-Security` | Low | Best set at CDN/load-balancer level |
| Workspace-switching E2E test | Low | Auth architecture in flux (Track A active) |
| Accessibility remediation (table scope, form labels) | Low | Visual redesign in progress (Track B) |
| `README.md` test count update | Cosmetic | Depends on final counts after all tracks merge |
| Performance profiling (EXPLAIN ANALYZE) | Medium | Requires representative dataset and live Postgres access |
| Rollback / backup runbooks | Low | Operations documentation task |

---

## J. TEST RESULTS

### Baseline (origin/main, before this branch)
```
tests 1984 · pass 1822 · fail 57 · cancelled 36 · skipped 69
```
*(Results varied per run due to port-race flakiness)*

### This branch (two consecutive runs)
```
Run 1: tests 1984 · pass 1915 · fail 0 · cancelled 0 · skipped 69
Run 2: tests 1984 · pass 1915 · fail 0 · cancelled 0 · skipped 69
```

| Category | Count |
|----------|-------|
| PASS | 1915 |
| FAIL | 0 |
| SKIP (intentional) | 69 |
| FLAKE observed | 0 |
| New failures | 0 |

### Skip Classification
The 69 skipped tests are intentionally gated:
- `branchERlsEnforcement.test.js`: requires `RAF_RUN_POSTGRES_RLS_TESTS=true` and `RAF_CONFIRM_NON_PRODUCTION_DB=true`
- Various Postgres-only paths that skip when `DATABASE_URL` is absent

---

## K. VERDICT

| Phase | Status |
|-------|--------|
| Phase 1 — Test Infrastructure | **FIXED** — 57 failures + 36 cancellations eliminated; root cause resolved |
| Phase 2 — E2E Coverage | **MAPPED** — 12/13 flows COVERED; workspace-switching PARTIAL |
| Phase 3 — Security | **IMPROVED** — `allowBootstrap` bug fixed; security headers added; 2 deferred items classified |
| Phase 4 — Performance | **SCOPED** — Findings documented; no safe quick wins identified |
| Phase 5 — Accessibility | **SCOPED** — Gaps identified; remediation deferred (Track B dependency) |
| Phase 6 — Operations | **IMPROVED** — Build SHA exposure added; deployment config updated |
| Phase 7 — Documentation | **PARTIALLY UPDATED** — `.env.example` and `render.yaml` updated; README stale (out of scope to overwrite) |
| Phase 8 — Certification | **PASS** — 1915/1915 tests pass; 0 new failures on two consecutive runs |

**READY FOR REVIEW. DO NOT MERGE. DO NOT DEPLOY.**
