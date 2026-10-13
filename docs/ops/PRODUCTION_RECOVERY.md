# Production Recovery Runbook (RAF)

Status: DRAFT for owner review. Written from repository files only, on branch `docs/prod-recovery-runbook`, based on `origin/main` at e57852a.

Nothing in this document has been exercised against a live environment. Any statement marked **UNVERIFIED** requires provider-console or live evidence before it may be relied on.

## 1. Platform inventory (from repo)

| Component | Source of truth | Notes |
|---|---|---|
| Backend API | `render.yaml` (service `raf-api`, region `oregon`, plan `free`) | Build `npm ci`; start `node scripts/migrate.js && node index.js`; health check `/health` |
| Database | PostgreSQL (Neon per `.env.example` and CI docs) | Raw SQL migrations in `db/migrations/` (40 files) |
| Frontend | `vercel.json` (Vite, output `dist`, SPA rewrite) | Repo attests Vercel config; live project and domain **UNVERIFIED** |
| Error tracking | Sentry via `lib/server/sentry.js`, enabled only when `SENTRY_DSN` is set | Live DSN presence **UNVERIFIED** |

Health endpoints (from `index.js` and `lib/server/readinessHandler.js`):
- `GET /health` – liveness, returns `{status:"ok", service:"raf-api", sha?}`. `sha` comes from `RAF_BUILD_SHA`.
- `GET /api/v1/health` – readiness, pings the DB; returns 200 `{ok:true,db:"connected"}` or 503 `{ok:false,db:"unavailable"}`.

## 2. Backup and point-in-time recovery

### 2.1 What the repository states
- `TRACK_E_REPORT.md` (line 217) states: "Neon provides PITR; no RAF-specific runbook." This is a prior report's assertion, not evidence of configuration.
- No repository file defines a backup schedule, retention window, snapshot policy, restore drill, or RPO/RTO.
- `scripts/migrate.js` has no backup step.
- `render.yaml` contains no database backup configuration (Render does not host the database in this repo).

### 2.2 To verify in provider console (UNVERIFIED)
A human owner must answer each question below and record the answer with date and screenshot reference:

1. Neon project for production: what is the **history retention window** (days) on the plan in use?
2. Is **point-in-time restore** enabled, and what is the restorable window?
3. Are **automatic snapshots / branch snapshots** enabled (`snapshot_schedule`), and what is their retention?
4. Which **Neon branch** is the production branch, and is it the default branch? (The local `.env` sets a Neon branch name of `production`; see SECRET_MANAGEMENT_CHECKLIST.md.)
5. Who has console access to restore, and is that access audited?
6. Date of the **last successful restore drill** to a non-production branch, and its measured restore time. If none exists, state "none."
7. Render: is the backend on the free plan (`render.yaml` line 6), which has no always-on guarantee and no paid support path? Confirm whether a paid plan is planned before pilot.
8. Vercel: deployment retention and whether previous production deployments are still promotable.

### 2.3 Owner decisions required (placeholders, NOT agreed values)
| Parameter | Proposed placeholder | Owner decision |
|---|---|---|
| RPO (max tolerable data loss) | `[OWNER: e.g. 1 hour]` | TBD |
| RTO (max tolerable downtime) | `[OWNER: e.g. 4 hours]` | TBD |
| Backup retention for pilot | `[OWNER: e.g. 7 days PITR minimum]` | TBD |
| Restore drill cadence | `[OWNER: e.g. before pilot, then monthly]` | TBD |
| Who may authorize a production restore | `[OWNER: name]` | TBD |

## 3. Migration rollback strategy

### 3.1 Facts from `scripts/migrate.js` and `db/migrations/`
- **Forward-only.** There are no down/rollback migration files (`git ls-files | grep -i down|rollback|revert` returns nothing). Do not invent one.
- **Ledger.** Applied files are recorded in `raf.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz)`.
- **Runs on every deploy.** `render.yaml` start command is `node scripts/migrate.js && node index.js`. Schema changes are applied **before** the new code serves traffic, and rolling back code does **not** roll back the schema.
- **Fail-closed guards.** Empty ledger on a non-empty migration set aborts unless `--bootstrap` or `RAF_ALLOW_BOOTSTRAP=true`. Unknown applied files and unexpected historical files abort. Superseded migrations are hash-pinned in `db/migration-supersessions.json` (currently one entry: `20260313170000_harden_backend_integrity.sql`).
- **Transactions: GAP.** The runner executes each file with a single `client.query(sql)` and then inserts the ledger row in a separate statement. Only 21 of 40 migration files contain explicit `BEGIN;`/`COMMIT;`. A migration that fails midway in a file without explicit transaction can leave partial DDL/DML applied and no ledger row, and a re-run may then fail. **Treat any failed migration as a database incident, not a redeploy.**
- **Runtime role.** The migration runner uses `POSTGRES_CONNECTION_STRING` (owner role). The server uses `POSTGRES_CONNECTION_STRING_APP` when `RAF_AUTH_REQUIRED=true`.
- **Destructive statements.** A `DELETE` exists in `20260905000000_add_token_blacklist.sql` (expired-token cleanup). No `DROP TABLE`/`TRUNCATE` found by grep in `db/migrations/`.

### 3.2 Required pre-deploy backup step (policy)
Before any deploy that includes new files in `db/migrations/`:
1. Confirm the diff: `git diff --name-only <last-prod-sha>..<release-sha> -- db/migrations/`.
2. Create a named restore point on the production Neon branch (console or Neon API by an operator). Record name, timestamp, and LSN/time in the release record. **Method UNVERIFIED in this repo; confirm in Neon console.**
3. Optionally, take a logical dump for the release record, from an operator machine, without committing output:
   `pg_dump --format=custom --no-owner --file <local-path> "<owner connection string from secret store>"`. Do not store the dump in the repo.
4. Run `node scripts/migrate.js --check` against a non-production branch first. Exit code 0 means preflight OK.
5. Only then merge/deploy.

### 3.3 Rollback decision tree
```
Problem after deploy?
├─ App code bug, release has NO new migration files
│    → Roll back code (section 4.2). No DB action.
├─ Release has new migrations, all ADDITIVE (new tables/nullable columns)
│    → Roll back code to previous SHA; leave schema. VERIFY previous code tolerates new schema first.
├─ Release has new migrations that the previous code cannot tolerate
│    → Prefer FORWARD FIX: new code + new migration in a new PR. Do not edit an applied migration file.
├─ Migration FAILED during deploy
│    → Service should not start (&& chain). Inspect ledger and partial state with the owner role.
│      Do not re-run blindly. Owner decides: repair forward, or restore (section 4.3).
└─ Data corruption or wrong financial mutation
     → Stop writes if possible; restore to a NEW branch from PITR/restore point; compare; cut over only on owner decision.
```
Never edit an applied migration file; the runner's hash and ledger checks assume immutable history.

## 4. Deployment rollback runbook

### 4.1 Pin the previous deploy (backend, Render)
1. Render dashboard → service `raf-api` → Events/Deploys: identify the last healthy deploy and its commit SHA. **UNVERIFIED for this account.**
2. Confirm the previous commit's SHA matches the `sha` field returned by `GET /health` before the bad deploy.
3. Use Render's "Rollback"/"Redeploy this commit" action on the previous deploy. (Feature name and availability on the free plan: **UNVERIFIED**.)
4. Do not change `render.yaml` env vars during rollback.

### 4.2 Revert a commit via a new PR (no force-push)
1. Branch from `main`: `git switch -c revert/<short-sha> origin/main`.
2. `git revert --no-edit <bad-sha>` (use `-m 1` for merge commits).
3. Run `npm ci && npm test` (test script: `node --experimental-strip-types --test`) and `npm run build`.
4. Open PR to `main`. Merge via the normal review path. Never force-push `main`.
5. If the reverted commit included migrations, see section 3.3; reverting code does not revert schema.

### 4.3 Restore from backup
Only with owner authorization (section 2.3).
1. Restore to a **new** Neon branch from the chosen restore point. Do not overwrite the production branch in place.
2. Point a staging/verification API instance at that branch (`POSTGRES_CONNECTION_STRING` and `_APP`, `RAF_AUTH_REQUIRED=true`) and run `GET /api/v1/health`.
3. Run `node scripts/migrate.js --check` against the restored branch; the ledger must match the expected frontier.
4. Compare row counts and key balances against the release record.
5. Owner approves cut-over. Cut-over method (repointing Render env vars vs. promoting a branch) is **UNVERIFIED**; document it after a drill.

### 4.4 Verify health after any rollback
1. `GET https://<render-host>/health` → 200, `sha` equals the intended rollback SHA.
2. `GET https://<render-host>/api/v1/health` → 200, `{"ok":true,"db":"connected"}`.
3. Log in as a test user in a non-production workspace; confirm `POST /api/v1/auth/login` responds (route exists in `app/api/v1/auth/`).
4. Watch logs for `api_error`, `readiness_check_failed`, and `server_listen_failed` (see INCIDENT_RESPONSE.md).
5. Frontend: confirm the Vercel production deployment serves `index.html` and that `VITE_API_BASE_URL` points at the backend. **UNVERIFIED** in live environment.

### 4.5 Communicate
- Post incident start, impact, and the rollback SHA in the owner's chosen channel. Record times for each step.
- Notify pilot users only with owner approval; no user data in messages.
- Record the outcome in a dated note; do not state recovery is "tested" unless a drill produced evidence.

## 5. Verification status

| Item | Status |
|---|---|
| Repo inventory (render.yaml, vercel.json, migrate.js, index.js, env.js) | VERIFIED from repo files |
| Migration runner behavior (forward-only, ledger, no transaction wrapper) | VERIFIED from source reading; not executed |
| Health endpoint names and responses | VERIFIED from source reading; not called live |
| Neon PITR, retention, snapshot schedule | UNVERIFIED – provider console required |
| Render rollback feature and plan support | UNVERIFIED – provider console required |
| Vercel deployment retention and promotion | UNVERIFIED – provider console required |
| Any restore drill | NOT PERFORMED. No evidence exists. |
| Pre-deploy restore point creation | NOT PERFORMED. Method unverified. |
| RPO/RTO values | OWNER DECISION – placeholders only |
