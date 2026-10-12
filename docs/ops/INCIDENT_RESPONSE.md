# Incident Response and Monitoring Checklist (RAF)

Status: DRAFT. Derived from repository source on `docs/prod-recovery-runbook`. No alerting system, dashboard, or Sentry project was inspected live.

## 1. Telemetry present in the repo

### 1.1 Structured log events (JSON on stdout/stderr)
| Event | Emitted by | Level | Fields |
|---|---|---|---|
| `api_request` | `index.js` (every response, `finish` hook) | info | method, path, status, durationMs, householdId |
| `api_error` | `index.js` final error handler | error | status, message |
| `readiness_check_failed` | `lib/server/readinessHandler.js` | error | message |
| `server_listen_failed` | `index.js` | error | port, message, code |
| `forgot_password_persist_failure` | `app/api/v1/auth/forgot-password/route.js` | error | userId |
| `forgot_password_email_failure` / `forgot_password_no_app_url` | same file | error / warn | (see source) |

Non-JSON log lines also exist (for example `[RAF] Unhandled route error` in `app/api/v1/_shared/http.js:67`, `[RAF audit] failed to write audit event` in `lib/audit/auditLog.js:42`, `[RAF scheduler] ...` in `lib/server/scheduler.js`, and `[RAF billing] ...` in the billing webhook). These are not JSON and need text matching.

### 1.2 Sentry
- `lib/server/sentry.js` initializes `@sentry/node` only when `SENTRY_DSN` is set. `sendDefaultPii: false`; `beforeSend` strips `authorization`, `cookie`, `set-cookie` and the request body.
- `index.js` calls `Sentry.setupExpressErrorHandler(app)` unconditionally; it is a no-op without init.
- Sentry captures unhandled exceptions. The `api_error` handler returns the error to the client and logs JSON, so handled 5xx errors may not reach Sentry unless thrown into the Express error chain. **Verify in Sentry console.**

### 1.3 Logging gaps
- No Pino or other logger library is present; logs are `console.*` with hand-built JSON. AGENTS.md says "Pino-compatible", which is aspirational.
- `api_request` logs `path` as `req.originalUrl`, which may include query strings. Check that no PII or tokens appear in query strings (privacy rule in AGENTS.md).
- No request ID or correlation ID is generated or logged.
- No auth-failure event exists. Login failures are visible only as `api_request` with status 401/403 on `/api/v1/auth/login`.
- No log for `api_error` on 4xx responses distinct from 5xx; `api_error` fires for any error with a `status`.

## 2. Alert conditions derivable from existing signals

| # | Condition | Derivable from | Threshold (proposed, owner to confirm) |
|---|---|---|---|
| A1 | Service down | Render health check on `GET /health` | 2 consecutive failures |
| A2 | DB unavailable | `readiness_check_failed` events, or `GET /api/v1/health` 503 | any occurrence |
| A3 | 5xx spike | `api_request` where `status >= 500` | e.g. >5 in 5 min |
| A4 | Unhandled error | `api_error` with status 500 | any occurrence |
| A5 | Auth failure spike | `api_request` on `/api/v1/auth/login` with status 401 | e.g. >50 in 10 min (possible credential stuffing) |
| A6 | Rate-limit saturation | `api_request` with status 429 on `/api/v1/auth/*` | sustained over 10 min |
| A7 | Slow requests | `api_request` durationMs | e.g. p95 > 2000 ms over 15 min |
| A8 | Migration failure | Render deploy log: `Error:` from `scripts/migrate.js`, exit 1 | any occurrence |
| A9 | Server did not start | `server_listen_failed` or `Invalid server environment configuration` on boot | any occurrence |
| A10 | Password reset delivery failure | `forgot_password_email_failure` | any occurrence |
| A11 | Runtime role unsafe | `[RAF] SECURITY: runtime database role` (boot) | any occurrence (should be impossible when auth required) |
| A12 | Scheduler failure | `[RAF scheduler] ...` text match | any occurrence |

Alerts A3, A5, A7 depend on a log aggregator or Sentry Discover-style queries. The repository does not configure any of them.

## 3. Signals that do not exist yet
- Log shipping or retention configuration (Render log retention: **UNVERIFIED**).
- Uptime monitor external to Render.
- Metrics endpoint (none exists in `index.js`).
- Database health beyond a single `ping()` (no replication lag, connection pool, or slow-query signal).
- Frontend error monitoring (Sentry is backend-only in the repo; the frontend `src/` was not checked for Sentry SDK use in this pass).
- Financial-integrity signal (e.g., allocation sums failing the `1.0000 ± 0.0001` rule). No runtime check emits an event.
- Audit alerting for owner-role connections.
- On-call rotation, paging, or escalation contact list (none in repo).

## 4. Incident checklist

### 4.1 Triage (first 15 minutes)
1. Open an incident record: time detected, reporter, suspected scope.
2. Check `GET /health` and `GET /api/v1/health` (see PRODUCTION_RECOVERY.md section 4.4).
3. Check the Render deploy list: was there a recent deploy? If yes, consider rollback first (PRODUCTION_RECOVERY.md section 4.1).
4. Check Sentry for new issues in the last hour (requires DSN configured; **UNVERIFIED**).
5. Classify severity:
   - SEV1: auth bypass, cross-workspace data exposure, incorrect financial mutation, or total outage.
   - SEV2: partial outage, 5xx spike, reset emails failing.
   - SEV3: cosmetic or non-blocking.

### 4.2 Containment
- Financial or data integrity suspected: stop new writes if a control exists (no feature flag exists in repo; owner decision on maintenance mode). **Do not** run ad-hoc SQL against production; use a restored branch for investigation.
- Credential suspected leaked: rotate in the provider console (Neon role password, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `SENTRY_DSN`). Changing `JWT_SECRET` invalidates existing tokens. This is an owner decision.
- Cross-tenant exposure suspected: preserve logs before any change. Check `api_request.householdId` header values and workspace membership. Do not disclose details outside the owner group.

### 4.3 Eradication and recovery
- Follow PRODUCTION_RECOVERY.md sections 3 to 4. Prefer rollback or forward fix over in-place database edits.

### 4.4 Communication
- Internal: incident channel, updated every 30 minutes for SEV1/SEV2.
- Users: owner decides wording and channel. Do not include user data, workspace IDs, amounts, or tokens.
- Regulatory or contractual notification: **owner and counsel decision**; no repo guidance exists.

### 4.5 Post-incident
- Write a blameless review within 5 working days: timeline, root cause, detection gap, and action items.
- Record whether the restore drill (if any) was exercised. If not, schedule one.
- Update this checklist if a new signal was needed and missing.

## 5. Contacts and ownership
| Role | Name | Contact |
|---|---|---|
| Incident commander | `[OWNER TO FILL]` | `[OWNER TO FILL]` |
| Database admin (Neon console) | `[OWNER TO FILL]` | `[OWNER TO FILL]` |
| Render admin | `[OWNER TO FILL]` | `[OWNER TO FILL]` |
| Vercel admin | `[OWNER TO FILL]` | `[OWNER TO FILL]` |
| Sentry admin | `[OWNER TO FILL]` | `[OWNER TO FILL]` |

## 6. Verification status

| Item | Status |
|---|---|
| Event names and emitters | VERIFIED from source grep and read |
| `/health` and `/api/v1/health` behavior | VERIFIED from source read; not called live |
| Sentry init and scrubbing | VERIFIED from `lib/server/sentry.js` |
| Sentry project exists, DSN set in Render | UNVERIFIED – provider console |
| Render health check configured to `/health` | VERIFIED in `render.yaml`; live status UNVERIFIED |
| Log retention and alert rules | UNVERIFIED – not configured in repo |
| Alert thresholds in section 2 | PROPOSED, not validated |
| Any incident drill | NOT PERFORMED |
