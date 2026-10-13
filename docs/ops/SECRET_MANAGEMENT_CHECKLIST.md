# Secret Management Checklist (RAF)

Scope: repository files on `docs/prod-recovery-runbook` (base `origin/main` e57852a). Values were never printed. Only variable names, file paths, line numbers, and the first 4 characters of a matched literal are recorded here.

## 1. Git tracking of env files

| Check | Result | Status |
|---|---|---|
| `git ls-files \| grep -i "\.env"` | Only `.env.example` is tracked | PASS |
| `git log --all --diff-filter=A -- .env .env.local` | No commit in any ref ever added `.env` | PASS |
| `.env` on disk in `raf_app` ignored by git | Yes, matched by `.gitignore:2` (`.env`) | PASS |

**Finding:** the on-disk `C:\Users\moser\Downloads\raf\raf_app\.env` (modified Sep 9 2026) contains a `NEON_BRANCH=production` entry, and its other entries include production-style database connection variables. It is not tracked and is not in git history of any ref, based on this check. Because it is a local file, the risk is local-machine exposure, not repository exposure. **Owner should still rotate** the credentials in that file if the machine or the file was ever shared, copied to cloud sync, or used with a backup tool. Rotation is recommended, not confirmed as needed.

## 2. .gitignore coverage

Current rules that matter (`.gitignore`):
- `.env`, `.env.local`, `.env.*` ignored; `!.env.example` re-included. **Covered.**
- `*.sqlite`, `*.db`, `db/meta.db`, `db/households/` ignored. **Covered.**
- `.neon` ignored.

Gaps:
- No rule for private keys or cert files (`*.pem`, `*.key`, `*.p12`, `*.pfx`). **Gap.**
- No rule for cloud service-account JSON (e.g., `*service-account*.json`, `*credentials*.json`). **Gap.**
- No rule for `.vercel/` (Vercel local link metadata). **Gap**, low risk, project and org IDs only; not verified in this worktree.
- No rule for `.render/` or local Render secret-file exports. **Gap**, not verified whether such files exist.

## 3. Hardcoded credential patterns in the tracked tree

Method: `git grep` over tracked files, excluding `package-lock.json` and `*.md` for the password pattern. Values redacted to 4 characters.

| Pattern | File:line | Assessment |
|---|---|---|
| `postgres://` URL with password | `.github/workflows/ci.yml:13` (owner role) and `:14` (app role), host `localhost:5432/raf_ci` | CI-only throwaway DB. Low risk, but literal credentials are tracked. Keep, or move to GitHub secrets. |
| `postgresql://…:<pas…>@<host>` | `.env.example:22`, `.env.example:30` | Placeholder text. PASS. |
| `postgresql://…` in docs | `docs/architecture/closure/architecture-closure-f.md:80` (`raf_app` role) | Placeholder host. Confirm no real host. |
| `postgres://owner:secr…@example.invalid` | `tests/serverEnvValidation.test.js:123,141,148,160,161,166,178` | Test fixtures, `example.invalid`. PASS. |
| `sk-ant-` prefix | `tests/remiAnthropicContext.test.js:32` (`sk-ant-SERV…`), `:33` (`sk-ant-CLIE…`) | Appears to be fake fixtures. **Confirm** they are not live keys. |
| JWT-shaped literal (`eyJ…`) | None found | PASS |
| `password:` / `jwtSecret:` string literals | Many test files, e.g. `tests/localPasswordRecovery.test.js`, `tests/branchEAdversarialApi.test.js`, `tests/collaborationSecurity.test.js`, `tests/exportDeletion.test.js`, `tests/importAuthorizationHttp.test.js`, `tests/helpers/isolatedSqliteServer.js:232`, `tests/adversarialSecurityRemiCollisions.test.js:1069` | Test passwords and JWT secrets in test code. Expected. No production source (`index.js`, `lib/`, `app/`) matched. PASS for production source. |
| `CI_JWT_SECRET` value | `.github/workflows/ci.yml` env block | Labeled "do-not-use-in-production". Low risk. |

No hardcoded credential was found in `index.js`, `lib/`, `app/`, or `scripts/` by these patterns.

## 4. `.env.example` versus server code

Server-side `process.env` names referenced (`index.js`, `lib/`, `app/`, `scripts/`), and whether `.env.example` lists them:

| Variable | Read by | In `.env.example` | Schema in `lib/server/env.js` |
|---|---|---|---|
| PORT | index.js/env.js | Yes | optional |
| PERSISTENCE_DRIVER | env.js, migrate-related | Yes | enum sqlite/postgres, optional |
| RAF_DB_PATH | env.js, db | Yes | optional, required when sqlite |
| POSTGRES_CONNECTION_STRING | env.js, migrate.js, scripts | Yes | optional, required when postgres |
| POSTGRES_CONNECTION_STRING_APP | env.js | Yes | optional, **required when RAF_AUTH_REQUIRED=true and postgres** |
| JWT_SECRET | env.js, lib/auth/jwt.js | Yes | optional in schema |
| RAF_AUTH_REQUIRED | env.js, index.js | Yes | optional |
| ANTHROPIC_API_KEY | env.js, index.js | Yes | optional |
| SENTRY_DSN | env.js, sentry.js | Yes | optional |
| ALLOWED_ORIGINS | env.js, index.js | Yes | optional |
| RAF_BUILD_SHA | index.js | Yes | not in schema, read directly |
| **RESEND_API_KEY** | env.js | **No** | optional |
| **EMAIL_FROM** | env.js | **No** | optional |
| **RAF_APP_URL** | env.js | **No** | optional, http/https validated |
| **RAF_POSTGRES_SSL** | env.js | **No** | not in schema (read directly) |
| **RAF_TRUST_PROXY** | index.js (via `parseTrustProxy`), render.yaml | **No** | not in schema |
| **RAF_AUTH_RATE_LIMIT_MAX** | index.js | **No** | not in schema |
| **RAF_AUTH_ACCOUNT_RATE_LIMIT_MAX** | index.js | **No** | not in schema |
| **RAF_ALLOW_BOOTSTRAP** | migrate.js | **No** | not in schema |
| **RAF_VALIDATE_APPLY_MIGRATIONS** | scripts | **No** | not in schema |
| **RAF_CONFIRM_NON_PRODUCTION_DB** | scripts/validatePostgresPhase25.js | **No** | not in schema |
| **NODE_ENV** | index.js, rateLimit | **No** | not in schema |
| **DATABASE_URL** | scripts only | **No** | not applicable to server |
| **SUPABASE_DATABASE_URL** | scripts only (deprecated) | **No** | not applicable to server |
| **STRIPE_SECRET_KEY** | commented out in billing webhook | **No** | not used |
| **STRIPE_WEBHOOK_SECRET** | `app/api/v1/billing/webhook/route.js:3` | **No** | not in schema |

Extra (in `.env.example`, not read by server code): `VITE_API_BASE_URL` (frontend build only), `RENDER_GIT_COMMIT` (comment only; Render sets it and `render.yaml` maps it to `RAF_BUILD_SHA`).

On-disk `.env` names not in `.env.example` and not read by server code: `NEON_BRANCH`, `DATABASE_URL_UNPOOLED`. Not used by server; remove from local files if unused.

**Gap:** 15 names read by server or script code are missing from `.env.example` (the bold rows above; `DATABASE_URL` and `SUPABASE_DATABASE_URL` are script-only). Note that `render.yaml` declares `RESEND_API_KEY`, `EMAIL_FROM`, `RAF_APP_URL`, `RAF_TRUST_PROXY` but `.env.example` does not.

## 5. Production guard in `lib/server/env.js`

| Variable | Required? | Guard behavior |
|---|---|---|
| JWT_SECRET | Optional in schema | With `RAF_AUTH_REQUIRED=true` and missing: **warning only** (line ~153). `lib/auth/jwt.js` throws `JWT_SECRET is required for local JWT auth` when absent and used. **Gap:** no minimum length or entropy check. |
| RAF_AUTH_REQUIRED | Optional | Unset means auth not enforced. With `PERSISTENCE_DRIVER=postgres` and unset: **warning only**; tenant isolation disabled. `render.yaml` sets `"true"`. |
| POSTGRES_CONNECTION_STRING_APP | **Required** when postgres + RAF_AUTH_REQUIRED=true | Startup throws if missing. Owner fallback disallowed. Good. |
| checkRuntimeRolePrivileges | Runtime | Throws if runtime role is SUPERUSER, BYPASSRLS, or CREATEROLE when auth required. Good. |
| ANTHROPIC_API_KEY | Optional | Absent means Remi uses knowledge-base path. Logged at boot as enabled/disabled, not value. |
| SENTRY_DSN | Optional | Absent means Sentry not initialized. **No startup warning and no production requirement.** |
| RAF_APP_URL | Optional in schema | Warning when auth required and absent. |
| RESEND_API_KEY | Optional | Email skipped when absent. Logged at boot. |

Logging of secrets: `index.js` logs only enabled/disabled states. `lib/server/sentry.js` strips `authorization`, `cookie`, `set-cookie` headers and request body, and sets `sendDefaultPii: false`. Good.

## 6. Action items for owner

1. Rotate Neon/Postgres credentials, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, and `SENTRY_DSN` if the local `.env` was ever copied, synced, or shared. (Owner decision. Not performed.)
2. Confirm `sk-ant-` strings in `tests/remiAnthropicContext.test.js:32-33` are fixtures.
3. Add missing names to `.env.example` (section 4), with placeholders only.
4. Add `.gitignore` rules for `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*service-account*.json`, `.vercel/`.
5. Add a minimum length check for `JWT_SECRET` in production (`RAF_AUTH_REQUIRED=true`), and make missing `JWT_SECRET` a startup failure. Code change, out of scope for this docs branch.
6. Move CI database passwords to GitHub Actions secrets, or keep as documented throwaway values.

## 7. Verification status

| Item | Status |
|---|---|
| Tracked env files (git ls-files, git log) | VERIFIED from git |
| .gitignore coverage | VERIFIED from file read |
| Hardcoded credential scan | VERIFIED by grep; patterns can miss other formats |
| `.env.example` vs code | VERIFIED by grep and source read |
| Live secrets on Render / Vercel / Neon | UNVERIFIED – provider console required; variable names in `render.yaml` only |
| Whether credentials on the local `.env` were ever shared or are still valid | UNVERIFIED – owner must check |
| Whether `sk-ant-` strings are live | UNVERIFIED – owner must check |
