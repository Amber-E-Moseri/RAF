# RAF Codex Handoff

This is the canonical handoff after PR #30. It describes the repository as it exists on `main` after the PostgreSQL architecture convergence merge. Do not reconstruct current architecture from old Track A/B/C/D chat history.

## 1. Canonical Repository State

- Branch: `main`
- HEAD: `f6eba338fa1c36d0441ff7e4dd7ec15e46750294`
- Latest merged PR: PR #30, `refactor(postgres): remove legacy compatibility adapter`
- Merge commit: `f6eba338`
- Date: 2026-09-19

Before future work, verify `main == origin/main`.

## 2. Current Database Architecture

PostgreSQL is the canonical production persistence architecture. The application selects persistence with `PERSISTENCE_DRIVER`; production must use `postgres` with `POSTGRES_CONNECTION_STRING`. SQLite/in-memory paths remain for test and local compatibility where intentionally selected, but they must not silently become production authority.

The hybrid/in-memory PostgreSQL compatibility adapter has been decommissioned from production runtime. PostgreSQL transactions now build a direct transaction object in `lib/server/postgresDb.js` through `buildDirectTransaction(client)`, which combines direct SQL methods and direct repository modules under `lib/repositories/postgres/`.

The current app codebase is Vite/React plus Express-style API routing, not a fresh Next.js/Supabase-only implementation. Treat the authoritative architecture as the current source plus `specs/raf_multi_income_debt_spec.md`.

## 3. Direct PostgreSQL Domains

Direct PostgreSQL repository modules currently present in `lib/repositories/postgres/`:

- `allocationCategoriesRepository.js`: allocation category reads/writes.
- `debtsRepository.js`: debts, debt adjustments, debt-account linking.
- `fixedBillsRepository.js`: fixed bill persistence.
- `goalsRepository.js`: goal persistence and goal funding support.
- `householdRepository.js`: household/settings direct PostgreSQL path.
- `importsRepository.js`: import batches, imported rows, imported transactions, review and merchant rules.
- `incomeRepository.js`: income entries and allocation persistence.
- `invitationsRepository.js`: workspace invitation direct PostgreSQL path and security resolver calls.
- `workspaceActivityRepository.js`: workspace activity append/list operations.
- `utils.js`: shared repository helpers.

`lib/server/postgresDb.js` also contains direct SQL methods for workspace membership, users, token blacklist, transactions, financial accounts, reconciliation, monthly closes/reviews, PDF import quota, Remi, and other cross-cutting operations.

## 4. Security Architecture

`withSecurityContext` lives in `lib/server/routerLoader.js`. It wraps DB calls so the PostgreSQL driver receives `userId` and/or `workspaceId` context. `lib/server/postgresDb.js` sets transaction-local values with:

- `select set_config('raf.user_id', $1, true)`
- `select set_config('raf.workspace_id', $1, true)`

Workspace isolation is enforced in application SQL predicates and by database RLS. These are separate controls. Application workspace predicates are not a substitute for RLS, and RLS is not a reason to omit explicit workspace scoping in application queries.

PostgreSQL migrations define workspace-scoped RLS helpers and policies. The `raf_app` role is expected to be non-superuser and must not have `BYPASSRLS`; migration `20260919000000_invitation_security_resolver.sql` contains an assertion that fails if `raf_app` has `BYPASSRLS`. Migration `20260909000000_create_raf_app_role.sql` creates/configures the app role.

## 5. Financial Semantics That Must Not Drift

Preserve these invariants from the spec, code, and tests:

- Monthly lifecycle: monthly close/review behavior is ordered, period-based, and guarded by monthly close state. See `lib/monthlyReviews/monthlyLifecycle.js`, `monthlyReviews.js`, and `applyMonthlyReview.js`.
- Debt calculations: debt balances are derived from starting balance, payments, and adjustments, not manually stored as an editable balance. See `lib/debts/debtBalanceAuthority.js`, `lib/debts/debts.js`, and debt tests.
- Interest behavior: interest/fees/corrections/reconciliation adjustments are explicit debt activity concepts; do not hide interest changes as arbitrary balance edits.
- Minimum/excess payments: minimum payment and planned payment fields drive obligations, pace, and trajectory calculations. Excess payments reduce debt trajectory according to current debt logic.
- Balance trajectory: forecasts and debt projections must remain deterministic for identical inputs and must not mutate input arrays.
- Cash-flow forecasting: `lib/raf/cashFlowForecasting.js` and cash-flow tests distinguish confirmed and expected cash flow and dates.
- Reconciliation behavior: account reconciliation uses resolved/open state and workspace-scoped account ownership; cross-workspace reconciliation visibility is forbidden.
- Statement/import behavior: imports flow through upload/parse/review/approve; imported rows require review state and category/debt handling as implemented in `lib/imports/`.
- Goal/debt transaction semantics: transaction splits, goal funding, debt payment matching, and debt payment reconciliation must preserve parent transaction amount integrity and workspace scope.
- Allocation semantics: allocation percents are fractions and active allocations must sum to `1.0000 +/- 0.0001`; allocation rounding remainder routes to `buffer`. Surplus split remainder routes to `emergency_fund`.
- Idempotency expectations: idempotency keys, token blacklist operations, import duplicate/fingerprint checks where present, and monthly close creation must not create duplicates on retry.

## 6. PostgreSQL Migration State

Tracked migrations currently include, among others:

- `20260313120000_create_raf_schema.sql`
- `20260903090000_workspace_postgres_persistence.sql`
- `20260903120000_financial_accounts.sql`
- `20260904000000_collaboration.sql`
- `20260905010000_enable_rls_policies.sql`
- `20260908020000_tighten_financial_rls_policies.sql`
- `20260909000000_create_raf_app_role.sql`
- `20260911000000_import_review_rules_learning.sql`
- `20260912000001_transaction_splits.sql`
- `20260912000002_goal_funding_splits.sql`
- `20260913000000_debt_financial_account_link.sql`
- `20260914000001_transaction_canonical_review.sql`
- `20260916000000_add_monthly_closes.sql`
- `20260917000000_fix_debt_adjustment_type_constraint.sql`
- `20260918000000_debt_payment_reconciliations.sql`
- `20260919000000_invitation_security_resolver.sql`

`db/migrations/20260917000001_add_import_fingerprint.sql` is present in the working tree but untracked as of this handoff. Do not treat it as canonical until it is deliberately reviewed and committed.

Repository migration presence is not proof that an external PostgreSQL database has applied the migration.

## 7. Invitation Architecture

The direct PostgreSQL invitation repository is `lib/repositories/postgres/invitationsRepository.js`.

Token resolution uses `raf.resolve_invitation_by_token($1)` from `20260919000000_invitation_security_resolver.sql`. Acceptance uses `raf.accept_workspace_invitation($1, $2, $3)`. Decline uses `raf.decline_workspace_invitation($1)`. These are `SECURITY DEFINER` functions with pinned search path and explicit grants to `raf_app`.

Workspace-admin invitation operations still use direct SQL under security context and workspace isolation. SQLite parity is covered by `tests/sqliteInvitationParity.test.js`; PostgreSQL invitation behavior is also covered by repository/security boundary tests.

## 8. Import Architecture

The direct PostgreSQL import repository is `lib/repositories/postgres/importsRepository.js`. Import orchestration lives in `lib/imports/`, including:

- `bankStatementImports.js`
- `uploadImportBatch.js`
- `parseImportBatch.js`
- `reviewImportBatch.js`
- `reviewImportedTransactions.js`
- `approveImportBatch.js`
- `rejectImportBatch.js`
- `importHistory.js`
- `importReviewRules.js`
- `merchantRules.js`
- `merchantNormalization.js`
- `quotaHelper.js`

Tracked source contains import review rules, merchant-rule matching, imported row review, approval/rejection, history, and PDF quota handling. `incrementPdfImportQuota` is implemented as a direct PostgreSQL atomic quota path in `lib/server/postgresDb.js` and used by `lib/imports/quotaHelper.js`.

Do not describe untracked files as committed architecture. The untracked import fingerprint migration may be WIP/stash work and must be reviewed before becoming canonical.

## 9. Household / Settings Architecture

`lib/repositories/postgres/householdRepository.js` is the direct PostgreSQL path for household/settings operations. `updateHousehold` is direct PostgreSQL and no longer depends on hybrid compatibility dispatch. Related domain code lives in `lib/household/`.

## 10. Workspace Activity Architecture

`lib/repositories/postgres/workspaceActivityRepository.js` persists workspace activity directly to PostgreSQL. `listWorkspaceActivity` queries by workspace and is covered by `tests/workspaceActivity.test.js` plus dispatch verification.

## 11. Adapter Decommission

PR #30 removed the production hybrid compatibility path from PostgreSQL runtime. Future production code must have zero dependency on:

- `loadState`
- `saveState`
- `withLockedState`
- legacy hybrid compatibility dispatch/fallback

Current production `lib/` and `app/` search found no runtime use of those symbols. The only `loadState` occurrence in production paths is a comment in `lib/server/postgresDb.js`. Tests may mention old adapter symbols as fixtures or negative controls; those are not production runtime dependencies.

Do not reintroduce the removed adapter as a shortcut. New persistence work should be direct PostgreSQL repository code or direct SQL in the existing transaction boundary.

## 12. Current Test Architecture

The package test command is `node --experimental-strip-types --test`.

Important suites include:

- `tests/postgresDispatchVerification.test.js`: verifies migrated methods dispatch directly and do not need fallback.
- `tests/postgresAdapterHardening.test.js`: verifies compat symbols are absent and direct PostgreSQL hardening remains.
- `tests/sqliteInvitationParity.test.js`: verifies invitation behavior remains consistent for SQLite/local compatibility.
- `tests/postgresInvitationsRepositoryParity.test.js` and `tests/postgresInvitationsSecurityBoundary.test.js`: invitation repository and security boundary.
- `tests/postgresImportsRepositoryParity.test.js`: import repository parity.
- `tests/postgresMigrationSchema.test.js`, `tests/postgresRlsIsolation.integration.test.js`, and `tests/postgresRepositoryTenantIsolation.test.js`: schema/RLS/tenant isolation.
- Financial suites: allocation, debts, debt activity, debt payment matching, debt payment reconciliation, monthly close/review, cash-flow forecasting, bank statement imports, goals, transaction splits, financial accounts, reconciliation, and adversarial suites.

The minimum post-cleanup smoke for this handoff is:

`node --experimental-strip-types --test tests/postgresDispatchVerification.test.js tests/postgresAdapterHardening.test.js tests/sqliteInvitationParity.test.js`

Historical expected result: 55/55 pass.

## 13. Known Baseline / Environment Issues

The previous convergence audit classified broad-suite failures as:

- New convergence regressions: 0
- Environment-gated: 1
- Pre-existing baseline: 7

The environment-gated failure was `GET /invitations/:token` against a live PostgreSQL/Neon environment because `raf.resolve_invitation_by_token` had not been applied to that external database. The source migration exists in main as `20260919000000_invitation_security_resolver.sql`. This is an external database migration-state issue, not evidence that the migration is absent from source.

Frontend contract failures observed in CI were reproduced on main/baseline and were not introduced by the PostgreSQL convergence work. Do not call pre-existing failures fixed unless a later dedicated phase actually fixes them.

## 14. External Database Warning

Repository migration presence != migration applied to external PostgreSQL.

Before debugging a live PostgreSQL failure, inspect the target database migration/schema state first. For invitation failures, specifically check whether these functions exist in schema `raf`:

- `resolve_invitation_by_token`
- `accept_workspace_invitation`
- `decline_workspace_invitation`

## 15. Branch / Worktree State

Fresh verification on 2026-09-19 found local branches:

- `main` only

Fresh `git fetch --prune origin` found remote branches:

- `origin/main` only

The following implementation branches are obsolete and not present locally after cleanup:

- `convergence/postgres-architecture-closure`
- `feature/postgres-invitations-direct`
- `feature/postgres-workspace-activity`
- `fix/postgres-pdf-import-quota`
- `feature/postgres-household-settings`

The requested remote cleanup targets were also absent after prune:

- `origin/convergence/postgres-architecture-closure`
- `origin/feature/postgres-invitations-direct`
- `origin/feature/postgres-workspace-activity`
- `origin/fix/postgres-pdf-import-quota`
- `origin/feature/postgres-household-settings`

`raf_baseline` worktree:

- Path: `C:/Users/moser/Downloads/raf/raf_baseline`
- HEAD: `799743e63f6ac70a4da39ee391bce904dde58a1b`
- Status: modified `app/api/v1/auth/forgot-password/route.js`, `app/api/v1/auth/reset-password/route.js`, `lib/server/postgresDb.js`
- Marking: PRESERVED - UNCOMMITTED USER WORK

Do not delete, clean, reset, stash, or modify `raf_baseline`.

## 16. Git Safety Rules

- Inspect before resetting, restoring, cleaning, deleting, or force-deleting.
- Never discard unknown user changes.
- Never force-delete branches without proving equivalence.
- Never treat untracked files as disposable solely because they are untracked.
- Do not use `git clean -fd` as a shortcut.
- Do not force-push `main`.

## 17. Next Development Rule

Future work should begin from `main` after verifying:

- `git branch --show-current` is `main`
- `git rev-parse HEAD` equals `git rev-parse origin/main`

Do not resume from old Track A/B/C/D branches. Those were migration implementation branches and are obsolete once cleanup is complete.

## 18. Certification Discipline

For future architecture changes:

- Establish a controlled baseline.
- Run candidate under the same conditions.
- Separate failures into `NEW REGRESSION`, `PRE-EXISTING BASELINE`, `ENVIRONMENT-GATED`, and `FLAKY INFRASTRUCTURE`.
- Do not use approximate pass/fail counts.
- Do not call infrastructure failures product regressions.
- Do not call product regressions infrastructure failures without evidence.

## 19. Deployment Readiness Distinction

Merge readiness, staging readiness, and production deployment readiness are separate gates.

PR #30 being merged means the source architecture is merged to main. It does not mean external databases have all migrations applied. It does not mean staging or production are certified. Production deployment readiness requires external migration verification and separate production sign-off.

## 20. Immediate Next-Step Candidates

Do not start any of these without user direction.

P0 correctness/security:

- Verify/apply `20260919000000_invitation_security_resolver.sql` in each external PostgreSQL environment before diagnosing live invitation-token failures.
- Confirm `raf_app` role expectations in each external environment, especially no `BYPASSRLS`.

P1 architecture/product:

- Review untracked `db/migrations/20260917000001_add_import_fingerprint.sql` before deciding whether import fingerprint persistence should become canonical.
- Review untracked `tests/phase1DebtActivityMigrations.test.js` before deciding whether it belongs in the tracked debt/import test set.
- Investigate the preserved `raf_baseline` auth route changes only if the user explicitly asks.

P2 cleanup/UX:

- Address pre-existing frontend contract failures in a dedicated phase.
- Review stash/local artifact hygiene carefully; do not drop user-owned WIP without proof.

Environment/deployment work:

- Check external migration state before live PostgreSQL debugging.
- Apply pending migrations to staging/production only through the approved deployment path.
- Re-run appropriate live PostgreSQL/RLS checks after environment migration updates.
