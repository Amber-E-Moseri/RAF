# Track E2 — Final Certification Report

**Branch:** `track-e/quality-security-prod-readiness`
**Base commit:** `6f401bc` (origin/main at certification time)
**Track E commits:**
- `90d7622` — track(e): test isolation, security hardening, and ops improvements
- `263c1de` — track(e): fix remaining TOCTOU port races in 8 test files (Phase 15)
**Certified:** 2026-09-24
**Certifier:** Claude Sonnet 4.6 (Track E2 autonomous certification pass)

---

## A. Branch State

Two commits ahead of `origin/main`. Fifteen files changed:

| File | Type |
|------|------|
| `tests/helpers/isolatedSqliteServer.js` | Test infrastructure |
| `tests/branchEAdversarialApi.test.js` | Test fix |
| `tests/adversarialSecurityRemiCollisions.test.js` | Test fix (Phase 15) |
| `tests/collaborationSecurity.test.js` | Test fix (Phase 15) |
| `tests/exportDeletion.test.js` | Test fix (Phase 15) |
| `tests/privilegeEscalation.test.js` | Test fix (Phase 15) |
| `tests/rateLimiting.test.js` | Test fix (Phase 15) |
| `tests/tenantCrossAccess.test.js` | Test fix (Phase 15) |
| `tests/tenantIsolation.test.js` | Test fix (Phase 15) |
| `tests/viewerWriteDenial.test.js` | Test fix (Phase 15) |
| `index.js` | Server hardening |
| `scripts/migrate.js` | Bug fix |
| `.env.example` | Documentation |
| `render.yaml` | Deployment config |
| `TRACK_E_REPORT.md` | Certification record |

**Zero changes** to `db/`, `lib/`, `app/`, `src/`, any migration SQL files, or auth code.

---

## B. Cross-Worktree Contamination Audit

`git diff origin/main..HEAD -- db/ lib/ app/ src/` → **0 lines**. No financial logic, route handlers, repositories, or migration history was modified. Changes are confined to the test tree, `index.js` (server plumbing), `scripts/migrate.js` (runner bug fix), and deployment/documentation files.

---

## C. Retry Mechanism Deep Inspection

`tests/helpers/isolatedSqliteServer.js` — public entry point `startIsolatedSqliteServer`:

**Architecture:**
- Private `startIsolatedSqliteServerOnce`: spawns one server child, runs health-poll loop
- Public `startIsolatedSqliteServer`: allocates a fresh OS port per attempt, retries up to `MAX_RETRIES = 5` times
- When `port` is passed explicitly: bypasses retry — calls `assertPortAvailable` then `startIsolatedSqliteServerOnce` directly

**Fast-fail mechanism (Phase 15 addition):**
```js
let childClosed = false;
child.once('close', () => { childClosed = true; });
// ... health poll loop ...
await wait(startupIntervalMs);
if (childClosed) throw new Error('Server process exited before health check passed');
```
`close` is used (not `exit`) because `close` fires only after all stdio streams are fully drained to parent handlers — guaranteeing `startupLog` is complete before the check.

**Retry classification:** `err.message.includes('[RAF] persistence: sqlite')` — true iff the child logged persistence confirmation before dying. This correctly distinguishes:
- Port collision (EADDRINUSE): server logged persistence, then died → retry
- Configuration error: server died before persistence log → no retry (abort)
- Slow startup timeout: server still running, health poll expired → log includes persistence → retry with fresh port

**Default timeouts:**
- `startupAttempts = 100` (20 seconds at 200 ms intervals)
- `startupIntervalMs = 200`
- `MAX_RETRIES = 5`

**Correctness:** The 8 test files fixed in Phase 15 previously passed an explicit `port` (from `Math.random()`), bypassing the retry path. After the fix they pass no port, so `startIsolatedSqliteServer` allocates via `getAvailablePort()` and the full retry logic applies. `baseUrl` is now always assigned from `serverProcess.baseUrl` (the return value), never from a pre-computed string.

---

## D. Three Consecutive Test Runs

All three runs on `track-e/quality-security-prod-readiness` with `npm ci`:

| Run | Tests | Pass | Fail | Cancelled | Skip | Duration |
|-----|-------|------|------|-----------|------|----------|
| 1 | 1984 | 1915 | 0 | 0 | 69 | 92,596 ms |
| 2 | 1984 | 1915 | 0 | 0 | 69 | 97,456 ms |
| 3 | 1984 | 1915 | 0 | 0 | 69 | 95,357 ms |

Zero failures across three runs. No flakiness observed.

**Skip classification (69):** All intentional — gated behind `RAF_RUN_POSTGRES_RLS_TESTS=true` or a live `DATABASE_URL`. No tests were weakened or newly skipped.

---

## E. allowBootstrap Semantics

`scripts/migrate.js` line 363:
```js
const allowBootstrap = process.argv.includes('--bootstrap') || process.env.RAF_ALLOW_BOOTSTRAP === 'true';
```

**6-combination truth table:**

| CLI `--bootstrap` | Env `RAF_ALLOW_BOOTSTRAP` | `allowBootstrap` | Behavior |
|-------------------|--------------------------|------------------|----------|
| present | any | `true` | Bootstrap allowed |
| absent | `'true'` | `true` | Bootstrap allowed |
| present | `'true'` | `true` | Bootstrap allowed |
| absent | absent/other | `false` | Error on fresh DB |
| absent | absent/other | `false` | Proceeds on non-empty DB |
| any | any | computed | `--check` reads `checkMode` separately; `allowBootstrap` value unused in check flow |

**Bug that was fixed:** A `const allowBootstrap` re-declaration inside the `try` block (line ~369) shadowed the outer declaration — the env var was used but the CLI flag was silently ignored. The inner declaration has been removed; the single outer declaration ORs both sources.

**No regression tests needed:** The fix is a pure boolean OR merge of two flag reads. `applyMigrations` consumes `allowBootstrap` by reference; the call site at line 376 is unchanged. The shadowing bug had no test coverage on `--bootstrap` (flag path was broken), and no new test is required to certify the fix — the logic is trivially correct.

---

## F. Security Headers

Live server started on port 19877 with `RFC_BUILD_SHA=test-sha-abc123`. Headers verified on `/health` and on an authenticated API route (`/api/v1/transactions`):

| Header | Value | Route(s) |
|--------|-------|----------|
| `x-content-type-options` | `nosniff` | `/health`, API routes |
| `x-frame-options` | `DENY` | `/health`, API routes |
| `referrer-policy` | `no-referrer` | `/health`, API routes |

Headers are applied in the CORS middleware at `index.js` lines 62–65, which runs on every request before route handlers. Confirmed present on both the liveness endpoint and data endpoints.

**Deferred:** `Strict-Transport-Security` (CDN/load-balancer concern), `Content-Security-Policy` (frontend SPA concern, Track B scope).

---

## G. Build SHA Attestation

**With `RAF_BUILD_SHA=test-sha-abc123`:**
```json
{"status":"ok","service":"raf-api","sha":"test-sha-abc123"}
```

**Without `RAF_BUILD_SHA`:**
```json
{"status":"ok","service":"raf-api"}
```

The `sha` field is absent (not `null`) when `RAF_BUILD_SHA` is unset — correct behavior for an optional observability field. Wired in `render.yaml` as `fromEnv: RENDER_GIT_COMMIT` so deploy pipelines populate it automatically.

---

## H. Environment Documentation

`.env.example` lines 57–66:

```
# ── Observability ────────────────────────────────────────────────────────────

# Anthropic API key — required for AI-assisted PDF bank-statement import.
# Obtain from: https://console.anthropic.com/settings/api-keys
ANTHROPIC_API_KEY=

# Git SHA of the deployed commit, exposed on GET /health as `sha`.
# Set by the deploy pipeline (e.g. RENDER_GIT_COMMIT on Render).
# Omit for local development — the field is absent when unset.
RAF_BUILD_SHA=
```

Both variables have empty default values (`=`). No secrets. Both are used in production (`ANTHROPIC_API_KEY` by the PDF import feature, `RAF_BUILD_SHA` by the health endpoint). Previously undocumented. **PASS.**

---

## I. Deferred Security Items

### I1. `raf.current_workspace_id()` search_path hardening — DEFERRED_P2

Migration `20260903090000` defined the function **with** `SET search_path = raf, pg_catalog` (line 489).

Migration `20260905010000_enable_rls_policies.sql` redefines it (lines 18–21) **without** `SET search_path`:
```sql
create or replace function raf.current_workspace_id() returns uuid
  language sql stable security definer as $$
  select nullif(current_setting('raf.workspace_id', true), '')::uuid
$$;
```

Status: confirmed still present, not touched by Track E. Classified DEFERRED_P2. Risk is medium-low (exploitable only by a superuser who can inject a schema, and `raf_app` role has no `CREATE SCHEMA`).

**NOT fixed per Track E constraints.** A standalone migration + certification pass is required.

### I2. Express path-to-regexp ReDoS — DEFERRED

Tracked in Section J. Requires Express v5 major upgrade; out of scope.

---

## J. Dependency Vulnerabilities

`npm audit` result: **19 vulnerabilities** (3 low, 7 moderate, 9 high).

**Baseline (origin/main):** also 19 vulnerabilities. **Zero new vulnerabilities introduced by Track E.**

Classification:

| Severity | Package | Scope | Path |
|----------|---------|-------|------|
| HIGH | `path-to-regexp` | Prod runtime | transitive via express |
| LOW | `body-parser` | Prod runtime | transitive via express |
| Moderate | `qs` | Prod runtime | transitive via express |
| Moderate | `react-router-dom` | Frontend only | direct dependency |
| Moderate | `@remix-run/router` | Frontend only | transitive via react-router |
| Moderate | `react-router` | Frontend only | transitive |
| Moderate | `baseline-browser-mapping` | Frontend only | transitive |
| HIGH | `vite` | Dev/build | direct dependency |
| HIGH | `postcss` | Dev/build | direct dependency |
| HIGH | `brace-expansion` | Dev/build | transitive |
| HIGH | `browserslist` | Dev/build | transitive |
| HIGH | `nanoid` | Dev/build | transitive |
| HIGH | `picomatch` | Dev/build | transitive |
| HIGH | `flatted` | Dev/build | transitive |
| HIGH | `js-yaml` | Dev/build | transitive |
| Moderate | `esbuild` | Dev/build | transitive via vite |
| Moderate | `@babel/core` | Dev/build | transitive |
| Moderate | `@humanfs/node` | Dev/build | transitive |
| LOW | `postcss-selector-parser` | Dev/build | transitive |

**Prod-runtime exposure:** Only `path-to-regexp` (ReDoS via Express route matching), `body-parser`, and `qs` reach the running server. All three require an Express major version upgrade. None are fixable with `npm audit fix`.

**NOT fixed per Track E constraints.** Dependency upgrades require their own certification pass.

---

## K. TRACK_E_REPORT.md Classification

**Classification: KEEP**

The file is a 313-line certification record documenting: root cause analysis of the 57 test failures, all implemented fixes with code, all deferred items with risk classification, test result tables, and the full change inventory. It is committed in the branch.

Rationale: this is the primary artifact reviewers need to understand what Track E did and why. It should remain committed so the PR review has the full context. Post-merge, it can be archived to `docs/certifications/track-e.md` at the team's discretion — that is a cosmetic rename outside the scope of this pass.

---

## L. Regression Delta

| Metric | origin/main | track-e | Delta |
|--------|-------------|---------|-------|
| Tests passing | 1,822 | 1,915 | **+93** |
| Tests failing | 57 | 0 | **−57** |
| Tests cancelled | 36 | 0 | **−36** |
| Tests skipped | 69 | 69 | 0 |
| npm audit vulns | 19 | 19 | 0 |
| New CVEs introduced | — | 0 | — |
| Financial logic changes | — | 0 | — |
| Auth/RLS changes | — | 0 | — |
| Migration changes | — | 0 | — |

The 93 newly-passing tests are the formerly port-race-flaky suite. No previously-passing test was broken or weakened.

---

## M. Diff Security Review

Every changed file has been reviewed. Summary findings:

| File | Change | Security verdict |
|------|--------|-----------------|
| `tests/helpers/isolatedSqliteServer.js` | Retry logic, fast-fail, timeout increase | No auth/RLS/financial logic. Clears Postgres env vars in child. CLEAN |
| `tests/branchEAdversarialApi.test.js` | Replace Math.random port with getAvailablePort() | CLEAN |
| `tests/*.test.js` (8 files) | Same port pattern fix | CLEAN |
| `index.js` | `server.on('error')` handler; 3 security headers; `RAF_BUILD_SHA` → `/health` | Headers reduce clickjacking/sniffing surface. SHA is a deployment-metadata field with no auth role. No financial logic touched. CLEAN |
| `scripts/migrate.js` | Remove shadowing `const allowBootstrap` re-declaration | Restores CLI flag semantics. No financial mutation logic changed. CLEAN |
| `.env.example` | Document `ANTHROPIC_API_KEY` and `RAF_BUILD_SHA` | Documentation only. Both values are empty (`=`). No secrets. CLEAN |
| `render.yaml` | `RAF_BUILD_SHA: fromEnv: RENDER_GIT_COMMIT` | Deployment config only. No secrets. CLEAN |
| `TRACK_E_REPORT.md` | New file | Documentation only. CLEAN |

No secrets appear in the diff. No financial calculations were moved. No auth bypass was introduced. No RLS policy was altered.

---

## N. Change Inventory

| Item | Category | Status |
|------|----------|--------|
| TOCTOU port race in `isolatedSqliteServer.js` | Test infra bug | FIXED |
| Math.random port in `branchEAdversarialApi.test.js` | Test infra bug | FIXED |
| Math.random ports in 8 additional test files | Test infra bug (Phase 15) | FIXED |
| Silent EADDRINUSE crash in `index.js` | Server bug | FIXED |
| `allowBootstrap` variable shadowing in `scripts/migrate.js` | Runner bug | FIXED |
| Security headers (nosniff, DENY, no-referrer) | Security hardening | ADDED |
| Build SHA attestation via `RAF_BUILD_SHA` | Ops capability | ADDED |
| `ANTHROPIC_API_KEY` and `RAF_BUILD_SHA` in `.env.example` | Documentation | ADDED |
| `RAF_BUILD_SHA` in `render.yaml` | Deployment config | ADDED |
| `raf.current_workspace_id()` search_path hardening | Security hardening | DEFERRED_P2 |
| Express v5 upgrade (path-to-regexp ReDoS) | Dependency | DEFERRED |
| `npm audit fix` (dev/frontend deps) | Dependency | DEFERRED |
| `Content-Security-Policy` header | Security hardening | DEFERRED |
| `Strict-Transport-Security` header | Security hardening | DEFERRED |

---

## O. Verdict

All certification phases are complete. No blocking issues found.

```
RAF TRACK E: PASS — TEST INFRASTRUCTURE, MIGRATION-RUNNER FIX, SECURITY HEADERS,
AND BUILD-ATTESTATION CAPABILITY CERTIFIED; READY FOR CONVERGENCE, NOT MERGE OR DEPLOYMENT
```
