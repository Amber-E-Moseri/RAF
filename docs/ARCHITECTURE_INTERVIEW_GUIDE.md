# RAF Architecture Interview Guide

**135 Architectural Questions & Answers for Job Interviews**

This document is a comprehensive preparation guide for software engineering interviews. It covers RAF's design decisions, financial architecture, security model, testing strategy, scaling considerations, and lessons learned—organized by topic area.

---

## Table of Contents

1. [Core Philosophy & Design Decisions (Q1–9)](#core-philosophy--design-decisions-q19)
2. [Scaling & Architecture Evolution (Q10–17)](#scaling--architecture-evolution-q1017)
3. [Security & Isolation (Q18–29)](#security--isolation-q1829)
4. [Transactions & Atomicity (Q30–40)](#transactions--atomicity-q3040)
5. [Financial Invariants & Authority (Q41–60)](#financial-invariants--authority-q4160)
6. [Forecasting & Time (Q61–72)](#forecasting--time-q6172)
7. [Remi & AI Integration (Q73–81)](#remi--ai-integration-q7381)
8. [Testing & Validation (Q82–91)](#testing--validation-q8291)
9. [Migrations & Deployment (Q92–100)](#migrations--deployment-q92100)
10. [Infrastructure & Operations (Q101–110)](#infrastructure--operations-q101110)
11. [Advanced Scaling (Q111–120)](#advanced-scaling-q111120)
12. [Lessons Learned (Q121–135)](#lessons-learned-q121135)
13. [Master Question Summary](#master-question-summary)

---

## Core Philosophy & Design Decisions (Q1–9)

### 1. Why separate Nomi, RAF, and Remi?

Nomi is the brand/product. RAF (Resilient Allocation Framework) is the financial computation engine—deterministic, multi-tenant, the source of truth for household finances. Remi is an AI advisor that *consumes* RAF's outputs but never defines financial truth. Separating them enforces that financial mutations go through RAF's authorized pathways (authorization → workspace scope → database transactions → RLS), while Remi can explain state without risking silent mutations from LLM inference.

### 2. Why is RAF deterministic while Remi is not allowed to define financial truth?

RAF must be auditable and reproducible. Given the same input data and user actions, RAF produces the same financial state every time. This enables testing, forensics, and confidence that the system won't mysteriously change a user's account. Remi is probabilistic—it hallucinates, misinterprets, infers intent. Allowing it to mutate RAF state would violate the determinism guarantee and create risk of unintended financial actions.

### 3. Where is the source of truth for a user's financial state?

PostgreSQL, scoped to a workspace via RLS + application-layer workspace filters. The authoritative sources by domain are mapped in `docs/financial-authority-map.md`:

- **Account balance**: `financial_accounts.current_balance`
- **Debt balance**: manual = ledger-derived from `debt_payments`, account-backed = linked `financial_accounts.current_balance`
- **Goal funding**: sum of `transactions` with `linkedGoalId`
- **Spending**: `transactions` where `direction = 'debit'`
- **Allocations**: `income_allocations` (intent, not actual spending)

### 4. How does data flow from React frontend through API into RAF and PostgreSQL?

React → POST to Express API → route handler validates auth & workspace → `resolveTrustedContext` injects `{ userId, workspaceId }` → domain service receives trusted context → `db.transaction()` wraps a Postgres transaction → direct SQL OR compat adapter (hybrid during migration) → trigger-layer invariant checks → COMMIT (or ROLLBACK on error) → response to frontend. Every transaction is scoped: `WHERE workspace_id = $N`.

### 5. Why PostgreSQL for RAF?

Multi-tenant isolation via RLS, ACID transactions for financial operations, triggers for invariant enforcement, JSON support for compatibility during migration from in-memory model, full-text search for transaction search, and query optimization via indexes. Also: cost-effective at startup scale, mature ecosystem, Neon offers serverless + branching for testing.

### 6. Why repository abstractions instead of direct SQL in services?

Repositories abstract the persistence layer (direct SQL vs. compat adapter during migration). Services call repositories, not SQL. This allows swapping implementations—Branch D progressively migrated from the compatibility adapter to direct repositories without changing service logic. Repositories also centralize the workspace filter, making it harder to accidentally write a non-scoped query.

### 7. How do you decide where business logic belongs?

- **Database layer**: invariant enforcement that cannot be skipped (trigger sums for allocations, FK constraints, RLS policies)
- **Repository**: data access + workspace scoping
- **Service**: domain calculation (debt snapshot, cash-flow forecast) that combines multiple repo queries
- **Route handler**: auth/permission check, request parsing, response formatting—never financial logic
- **Frontend**: state display, user interaction, optimistic updates—never financial truth calculation

This separates concerns: if a bug bypasses application logic, the database layer still prevents invalid states.

### 8. What parts would you redesign if starting today?

Monthly review and import pipeline remain on the compatibility adapter (compat-backed in Branch I). If rebuilding: (a) direct SQL repositories for those domains from day one, (b) explicit idempotency keys on all financial writes (currently use transactions + application-layer de-duplication), (c) separate event sourcing layer for audit trail (currently mixed with activity feed), (d) structured logging with workspaceId in all financial events.

### 9. Why modular monolith instead of microservices?

Startup reality: all domains are coupled through financial state. Splitting them increases complexity (distributed transactions, eventual consistency, cross-service schema changes). The monolith allows shared database transactions, simpler debugging, and easier refactoring. Microservices become viable only when domains genuinely scale independently—if a 100x surge in users hits forecasting but not accounting, then split forecasting to its own service and cache aggressively.

---

## Scaling & Architecture Evolution (Q10–17)

### 10. At what scale would you split into services?

When: (a) transaction load on forecasting overwhelms the shared Postgres connection pool (add read replicas first; if that fails, split forecasting to a read-only service), (b) import processing causes latency spikes in critical paths (move to async queue + background workers), (c) Remi's AI calls block financial mutations (move Remi to separate service, RAF stays critical path). Would never split: multi-tenant auth (stays core), financial ledger (stays core), monthly close (stays core).

### 11. What architectural debt currently exists?

- (Documented) Compat adapter still backs monthly reviews (6 methods) and imports (24 methods). Adds serialization cost via `pg_advisory_xact_lock`.
- Dev-mode auth bypass (`RAF_AUTH_REQUIRED=false`) allows IDOR via workspace header in shared dev environment.
- `raf_app` role activation is deployment-dependent; no pre-flight check outside startup logs.
- Legacy belt-and-suspenders in Remi handlers: `direction === 'debit' || amount < 0` (fallback to amount sign for direction-less rows).
- No backup/restore procedure documented; no restore drill run.
- Workspace-scoped activity log exists; not yet added to structured request logs for tracing.

### 12. Why did some pages become large?

Monthly review UI (buffer disposition, surplus split, month-close transition) couples presentation with complex financial logic (remaining buffer calculation, allocation adjustments, state immutability). Import pipeline UI couples transaction classification (matching merchant rules, reviewing imported balances) with multi-step approval workflows. Both grew because their domains are genuinely complex—not poor separation. Would decompose safely via: (a) extract pure calculation functions (already done for allocation math, needs doing for import logic), (b) separate test layer that proves calculation independently of UI state, (c) progressive migration from compat to direct SQL so you can verify behavior during refactor.

### 13. How do you prevent a refactor from changing financial semantics?

- **Authoritative tests**: adversarial test suite (Phase 1–7, docs/testing/) runs against real PostgreSQL, compares outputs before/after every refactor candidate
- **Ledger verification**: reconcile transaction ledgers, debt balances, goal progress before/after
- **RLS red-team tests**: Branch E suite (`tests/branchERlsEnforcement.test.js`) runs mutations via two separate pools (admin + app role) to prove RLS doesn't change behavior
- **Baseline comparisons**: failing tests are compared against a tracked baseline, not dismissed as pre-existing
- **No silent semantic changes**: if a refactor changes output, tests fail visibly; you can't accidentally merge

### 14. How do you maintain backwards compatibility while migrating?

Hybrid persistence: the compatibility adapter loads existing `raf.*.raw_json` rows into the in-memory RAF model, domain logic runs, diffs flush back to Postgres. This keeps old behavior alive while new direct-SQL repositories are added incrementally. Branch D phased it: audit → repository boundaries → pilot low-risk domains → core domains → remove lock dependence → remove dead compat code. Exit condition: 45% compat reduction (69 direct SQL / 38 compat-backed / 0 dead).

### 15. How did you migrate from compatibility to direct persistence?

Five-phase approach: (a) identify which domains use compat (transactions, debts, accounts, imports, allocations), (b) write direct-SQL repository (workspace-scoped FROM/WHERE, RLS-ready), (c) write unit tests verifying repo behavior matches compat, (d) swap one route at a time, run integration tests, (e) delete compat code once all routes are migrated. Branch D proved this with 27/27 dispatch verification tests and 83 financial regression tests (9 pre-existing failures, 0 new ones).

### 16. Why not rewrite during migration?

Rewriting risks changing financial semantics invisibly. Staying on compat while adding direct SQL allows side-by-side verification—you can run both paths and compare outputs. If the new direct repo produces a different debt snapshot, the test fails before production. A full rewrite has no checkpoint; you discover divergence in production after real data is corrupted.

### 17. How does RAF support multiple users/workspaces without leaking data?

Three independent layers:

1. **Application**: `resolveTrustedContext` on every protected route, `withSecurityContext` injects `{ userId, workspaceId }` into `db.transaction()`
2. **SQL**: every repository query includes `WHERE workspace_id = $N` (defense-in-depth: cross-tenant rows are invisible even if RLS fails)
3. **RLS**: 26 tables carry `ENABLE ROW LEVEL SECURITY` + policies using `raf.current_workspace_id()` and `raf.has_workspace_membership()`

A compromise of any single layer doesn't grant cross-tenant access.

---

## Security & Isolation (Q18–29)

### 18. Why use PostgreSQL RLS when you already check workspace access in application?

Defense in depth. If application auth is bypassed (code bug, framework vulnerability, supply-chain compromise), the database layer still prevents data escape. RLS is the last barrier. Also: direct SQL writes from compat adapter or future async workers use the same RLS policies automatically—no per-worker auth reimplementation needed.

### 19. What happens if an application authorization bug forgets to filter by workspace?

RLS blocks it. If a route returns `SELECT * FROM debts` without `WHERE workspace_id = $N`, RLS policies prevent rows from other workspaces from being fetched. The `raf_app` role (NOBYPASSRLS) cannot bypass these policies—they're enforced at query execution time, not trusting application code.

### 20. How do you test that RLS actually works?

Branch E created `tests/branchERlsEnforcement.test.js`: two-pool pattern. Admin pool (full permissions) inserts test data into WorkspaceA and WorkspaceB. App pool (raf_app role, NOBYPASSRLS) connects as a user in WorkspaceA. Test verifies: (a) queries for WorkspaceA data succeed, (b) queries for WorkspaceB data return 0 rows, (c) INSERT/UPDATE/DELETE attempts on WorkspaceB fail. 8/8 tests pass, proving RLS is not a security theater.

### 21. Why use raf_app role instead of database owner?

Owner role has BYPASSRLS privilege by default—it can read/write any row regardless of RLS policies. Using `raf_app` (created with NOBYPASSRLS NOSUPERUSER) forces all application data access through RLS gates. Production startup calls `checkRuntimeRolePrivileges()` and throws if the role has BYPASSRLS, preventing accidental privilege escalation.

### 22. What is BYPASSRLS, and why does allowing it undermine security?

BYPASSRLS allows a role to ignore RLS policies. If the application role had it, a code bug or supply-chain attack could bypass tenant isolation by using raw SQL or forcing a policy-skipping path. NOBYPASSRLS means RLS is enforced for the `raf_app` role on every query it executes — there is no application-level escape hatch. The `neondb_owner` role retains BYPASSRLS and is deliberately used only for schema setup and test fixtures, never for application data access. This prevents accidentally hardcoded workarounds.

### 23. How do you establish trusted workspace context for a request?

`resolveTrustedContext` in `lib/server/routerLoader.js`: (a) extract and verify JWT, check token_blacklist, (b) read workspace membership from DB (not trusting the header), (c) check role-to-permission mapping, (d) call `withSecurityContext` to inject `{ userId, workspaceId }` into the transaction context. The context is passed to every `db.transaction()` call, which sets PostgreSQL session variables via `set_config()`. Session vars are transaction-local and cleared on COMMIT/ROLLBACK.

### 24. Why shouldn't the frontend be allowed to tell the backend which workspace is authoritative?

The frontend is in the user's browser—compromised, network-intercepted, or buggy. If the backend trusts a workspace header from the frontend, an attacker can IDOR into another user's workspace by guessing UUIDs. The backend must derive workspace membership from the database (look up the user's assigned workspaces) and reject any workspace not in that list.

### 25. How do you prevent a user from submitting another workspace's ID?

Application layer: `resolveTrustedContext` looks up workspace membership in the DB. If the user is not a member, 403 is returned before domain logic runs. Database layer: every query includes `WHERE workspace_id = $N`, so cross-workspace rows are invisible. RLS layer: policies check `has_workspace_membership` before permitting access. One user cannot submit another workspace's goal/debt/account ID and have it accepted.

### 26. Difference between authentication, authorization, tenant isolation, and RLS?

- **Authentication**: "Who are you?" JWT verification, token blacklist check.
- **Authorization**: "What are you allowed to do?" Role-to-permission mapping (viewer cannot write financial data).
- **Tenant isolation**: "Which data set belongs to you?" Workspace membership lookup, workspace scoping in queries.
- **RLS**: "Enforce tenant isolation at the database layer." Policies in PostgreSQL that prevent rows from other tenants from being fetched, even if application code has a bug.

### 27. What if RLS were accidentally disabled on one financial table?

If `DISABLE ROW LEVEL SECURITY` was run on, say, `debts`, a query like `SELECT * FROM debts` without a workspace filter would return all debts from all workspaces. RLS is the last layer—if it's off, the application-layer workspace filter is the only remaining defense. Tests would catch this (Branch E tests would fail if RLS is disabled), but in production it would be an undetected data leak until an attacker probed or logs revealed unusual access patterns.

### 28. How would you detect a tenant-isolation regression before production?

- **RLS tests**: Run the Branch E suite on every PR. If any policy is removed or disabled, tests fail.
- **Workspace-scoped query audit**: Static analysis or runtime logging to flag queries without `WHERE workspace_id`.
- **Cross-workspace integration tests**: Set up test data in two workspaces, make authenticated requests in one, verify you cannot retrieve the other's data.
- **Adversarial tests**: Intentionally try to IDOR by guessing UUIDs; verify 403 is returned for workspaces you're not a member of.

### 29. Why test PostgreSQL behavior against real PostgreSQL, not mocks?

Mocks simulate RLS, triggers, constraint enforcement, transaction isolation. Real PostgreSQL has subtle behaviors that mocks miss—constraint-check timing, trigger sequencing, query plan edge cases. If you mock out `REFERENCES ON DELETE CASCADE`, you won't catch a bug where orphan rows accumulate under concurrency. Tests must run against real Postgres to have confidence RLS and triggers actually work.

---

## Transactions & Atomicity (Q30–40)

### 30. What does a transaction protect you from?

Atomicity: all-or-nothing. If a financial operation writes to three tables and the third fails, the first two roll back—the database never observes a partial state. Isolation: concurrent transactions don't see half-committed data. Consistency: triggers and constraints run inside the transaction, enforcing invariants before commit. Durability: once committed, data survives crashes.

### 31. Example of an operation in RAF that must be atomic?

Monthly close: (a) create `monthly_review` record, (b) allocate income from `income_entries` to allocation buckets via `income_allocations`, (c) apply spending totals to allocation state, (d) calculate remaining buffer / surplus, (e) update workspace metadata to mark the month as closed. If step (c) fails, step (b)'s allocations shouldn't persist—you can't have allocated income with no corresponding review. All five steps run inside one `db.transaction()`. Either all succeed or all rollback.

### 32. Why is applying a buffer disposition and closing the month as two independent requests dangerous?

User applies disposition (rest of buffer goes to surplus), then navigates away before clicking "close month." If they never close, the disposition is applied but the month isn't marked closed—forecast uses outdated opening balance, income allocations aren't finalized, surplus rules don't execute. Next login, UI may recalculate and show inconsistent state. A bad connection could apply disposition, fail on close, and leave the month in a corrupted state. Better: both are one request inside one transaction, or disposition is "applied" only after close succeeds.

### 33. What happens if goal contribution succeeds but month-close fails?

The transaction rolls back. If month-close fails on, say, a trigger validation (allocation sums don't equal 100%), the goal contribution is also rolled back—the database is consistent. The frontend receives a 500 error and doesn't update its state. Next request, the user retries from a clean slate.

### 34. How would you redesign so it's atomic?

Combine into one endpoint: `POST /workspace/:id/months/:yearMonth/finalize` with payload `{ bufferDisposition, ... }`. The server runs all steps (apply disposition, compute surplus allocation, close month) inside one transaction. If any step fails, all rollback. Response includes the final state so the frontend can update atomically.

### 35. How do you ensure repositories share the same transaction?

`db.transaction()` returns a transaction-scoped connection (`tx`). Every repository method takes `tx` as the first argument. Inside the transaction callback:

```js
db.transaction(async tx => {
  await debtRepository.updateDebtBalance(tx, debtId, newBalance);
  await allocationRepository.updateBucket(tx, bucketId, newAllocation);
})
```

Both repositories use the same `tx` connection, so they share the same Postgres transaction. If either fails, both rollback.

### 36. What happens if a repository accidentally uses the global connection pool?

Deadlock or lost updates. The global pool is outside the transaction context. A repository write using the global pool commits immediately (or fails), while the calling transaction continues—now you have partial data committed, and if the transaction later rolls back, the repository write is orphaned. The fix: all repository methods must accept `tx` and use it exclusively. Code review should flag `pool.query()` in domain code.

### 37. How do you test rollback behavior?

Write a test that triggers a rollback mid-transaction:

```js
try {
  await db.transaction(async tx => {
    await repository.insert(tx, data);
    throw new Error('simulate failure');
  });
} catch (err) {
  const result = await repository.find(id); // query outside transaction
  expect(result).toBeUndefined(); // row was never persisted
}
```

Also test constraint-driven rollback: attempt an operation that violates a trigger or constraint, verify the transaction fails and previous writes are undone.

### 38. If network drops after commit but before client receives response?

The server has committed the transaction—the financial state is durably persisted. The client doesn't know and will likely retry the same request. The server receives a duplicate (idempotent retry). If the operation is idempotent (paying a goal by ID: if goal already at target balance, no-op), retrying is safe. If not (creating a new transaction), you need an idempotency key to deduplicate.

RAF has targeted idempotency protections for the highest-risk duplicate operations. CSV import batches use a file-hash uniqueness constraint (`UNIQUE(workspace_id, file_hash)` on `raf.import_batches`). Imported transaction rows carry a fingerprint uniqueness constraint (`UNIQUE(workspace_id, fingerprint)` on `raf.imported_transactions`). General-purpose idempotency keys on all financial mutations (goal contributions, debt payments, buffer disposition) are not yet implemented and are the next hardening priority post-launch.

### 39. How do you make financial operations safe to retry?

Idempotency keys: client generates a UUID for the operation, includes it in the request. Server stores the key + result. If the same key arrives twice, return the cached result instead of re-executing. For operations without an idempotency key layer, ensure the operation is *naturally* idempotent: paying a goal to $X (if already at $X, no change) vs. adding $X to goal progress (must only run once).

### 40. Difference between atomicity and idempotency?

Atomicity: one operation is all-or-nothing (no partial state). Idempotency: doing an operation twice has the same effect as doing it once. Paying off a goal to a fixed amount is idempotent (pay twice to the same amount, no change). Adding $100 to a balance is not idempotent (do it twice, balance changes twice). A network retry needs idempotency to be safe; atomicity alone doesn't prevent duplicate effects.

---

## Financial Invariants & Authority (Q41–60)

### 41. Why does RAF need both atomicity and idempotency?

Atomicity ensures the operation itself is consistent. Idempotency ensures *retries* are safe. A payment is atomic (ledger + balance updated together). If the client doesn't receive the response, it will retry. Idempotency ensures the second payment doesn't double-charge. Without both, you have either inconsistent state (atomicity missing) or duplicate charges (idempotency missing).

### 42. How do you protect against double-clicking a financial action?

- **Database level**: uniqueness constraint on idempotency keys, checked with SERIALIZABLE isolation
- **Application level**: request de-duplication by ID, return cached result for duplicate requests within N seconds
- **UI level**: button is disabled after click until response arrives

UI-only is insufficient (user can modify JS or network can drop response). Database de-duplication is the authoritative layer.

### 43. Why isn't disabling the button enough?

Network latency, JavaScript errors, or a malicious client can submit duplicate requests. An attacker can use curl to replay the request. The server must verify de-duplication, not trust the UI.

### 44. How do you prevent duplicate statement imports?

Two database-layer uniqueness constraints prevent duplicate imports. For batch-level (file uploads): `UNIQUE(workspace_id, file_hash) WHERE file_hash IS NOT NULL` on `raf.import_batches` — the hash is a SHA-256 of the file contents, scoped per workspace. For row-level: `UNIQUE(workspace_id, fingerprint) WHERE fingerprint IS NOT NULL` on `raf.imported_transactions`. Both use partial indexes so legacy rows without hashes remain unconstrained. If a file with the same hash has already been imported into the same workspace, the constraint fires and the application returns a 409 or 200 with the existing batch ID. PDF file-level idempotency at the batch layer is not yet implemented (deferred). Also: UI prevents re-uploading the same file by checking the account's import history before submission.

### 45. Why enforce duplicate detection in database and application?

Application-layer detection is fast (check in-memory cache or quick index lookup). Database-layer constraint is authoritative and prevents duplicates even if the application logic is bypassed (direct SQL, batch import job, race condition between two servers). Database is the source of truth.

### 46. Why scope import uniqueness by workspace, not globally?

Each workspace is a separate tenant. User A in Workspace 1 and User B in Workspace 2 can import the same bank statement file without conflict—they're importing into different financial realities. Global uniqueness would prevent legitimate re-use of statements across workspaces.

### 47. How would you handle two identical import requests arriving concurrently?

Database uniqueness constraint: first request inserts and commits, second request attempts INSERT and hits the constraint, fails. Application catches the constraint error and either: (a) returns 409 Conflict with existing import ID, or (b) returns 200 OK with existing import ID (idempotent response). The constraint ensures only one import is created, not a race condition where both create separate rows.

### 48. What financial invariants does RAF enforce?

- Allocation percentages sum to exactly 100% (trigger: `enforce_active_allocation_percent_sum`)
- Surplus split rules sum to exactly 100% (trigger: `enforce_active_surplus_split_percent_sum`)
- Income allocation rows don't exceed the income amount (trigger: `enforce_income_allocation_total`, fixed in Branch D)
- Debts with payments cannot be deleted (trigger: `prevent_debt_delete_with_payments`)
- Account balances are never calculated from transaction sums (always read from DB, computed by bank import or user reconciliation)
- A month cannot be closed twice (handled at application layer via immutability flag)

### 49. What do you mean when you call RAF the "financial authority"?

RAF is the canonical system of record for financial state. When Remi wants to summarize debt, it calls RAF to retrieve `buildDebtListResponse()`, which derives the debt snapshot with the correct balance authority (manual vs. account-backed). Remi never recalculates; it consumes. If Remi's interpretation contradicts RAF, RAF is correct and Remi's reasoning was flawed. RAF is not the *source* of bank data (imports are), but it's the authoritative *computation* of household financial state.

### 50. How do you ensure only one authoritative calculation for remaining buffer?

The buffer remaining calculation is deterministic and lives in one place: `lib/monthlyReviews/monthlyLifecycle.js`, computed inside the month lifecycle state machine. The authoritative surplus snapshot is `computeMonthlyReviewSnapshot()` in `lib/raf/reporting.js`. No other route or service recalculates it. The frontend displays the value returned by the server — it never re-derives the buffer independently. If a formula bug is discovered, fix it once; tests verify the fix everywhere. If the frontend ever computes "remaining buffer" for optimistic updates, it must use the same formula as the server (document it as a contract, test both match).

### 51. Why is duplicating a financial formula across frontend and backend dangerous?

Frontend and backend drift. The frontend formula calculates remaining buffer as `income - spending`, the backend as `income - spending - fees`. Users see different numbers, leading to surprise and distrust. Later, the backend formula changes for a bug fix; the frontend still uses the old formula. The solution: server calculates, frontend displays (no re-derivation). If frontend needs the value for optimistic updates, derive it client-side *only for display*, then fetch authoritative value on submit and verify locally.

### 52. What should happen if frontend shows $100 buffer but financial state changes before close?

Optimistic display is stale. When the user submits month-close, the server recalculates from current state. If the recalculated buffer is $95, it applies $95, not $100. The frontend doesn't trust its optimistic calculation; it's merely for UX responsiveness. Real calculation happens server-side inside the transaction.

### 53. Why should the server calculate final disposition amount, not trust client submission?

Client submission can be forged (user modifies the form via DevTools) or stale (they calculated $100 buffer two minutes ago, new transactions arrived). The server runs the calculation fresh: current transactions, current allocations, current rules. The disposition amount is recomputed server-side. Client's submission of amount is overwritten.

### 54. How do you handle rounding and monetary precision?

RAF uses cents (integers) throughout. `financial_accounts.current_balance` is stored as `NUMERIC(12,2)` in Postgres but represented as an integer count of cents in application code. Display formatting happens at the view layer (divide by 100, format with 2 decimals). No floating-point arithmetic. Ledger sums are always exact integer arithmetic.

### 55. How does RAF distinguish balances, transactions, adjustments, payments, interest, and reconciliations?

- **Balance**: `financial_accounts.current_balance` (single observed amount at a point in time)
- **Transaction**: `transactions` (activity with `direction` = debit/credit, `amount`, optional `linkedGoalId`)
- **Adjustment**: manual correction to `financial_accounts.current_balance` (user reconciles against bank, balance is adjusted)
- **Payment**: `debt_payments` ledger entry (applies toward debt payoff, separate from transactions)
- **Interest**: future interest (projected in forecast) or accrued interest (added to debt via adjustment; not auto-calculated)
- **Reconciliation**: `account_reconciliations` (user confirms balance matches bank statement, reconciliation becomes a checkpoint)

Each is a separate table with distinct semantics.

### 56. How do you prevent generated interest from being counted twice?

Interest is not auto-generated in RAF. Manual debt tracks interest via ledger entries (user enters "I owe $50 more interest" as an adjustment). The ledger sum includes it once. Account-backed debt (linked to a credit card account) gets interest via the account balance (bank adds interest; RAF sees the new balance on import). Interest is never both in the ledger *and* added to the account balance. This is enforced by not auto-calculating interest—it's a manual entry.

### 57. How does RAF determine debt payoff trajectories?

`deriveDebtSnapshot()` in `lib/raf/debts.js`: (a) resolve balance authority (manual or account-backed), (b) compute payment pace (average monthly payment from `debt_payments` ledger), (c) project months to payoff: `remaining balance / monthly pace`. If no payments recorded, trajectory is undefined. Forecast uses this to schedule debt payoffs as fixed obligations. The calculation is deterministic and re-run on every read (not cached).

### 58. How do imported transactions interact with manually entered data?

They're separate. Imported transactions go to the `imported_transactions` table (requires review before approval). Manual transactions are entered directly into `transactions`. Both contribute to spending totals and account reconciliation, but they're trackable separately. Duplicates are detected by hash (don't double-count imported + manually entered version of the same transaction).

### 59. How do you reconcile an imported payment with an existing debt payment?

`debtPaymentMatching.js` in `lib/debts/`: when approving an import batch, check if any imported transactions match existing debt payments (by date, amount, direction). If a match is found, link them (record the connection in metadata or a junction table). This prevents double-counting the same payment as both an imported transaction and a manual debt payment.

### 60. What happens when RAF can't confidently match an import?

Import stays in `unreviewed` status, flagged for the user. User manually reviews and either: (a) confirms it matches an existing debt payment, or (b) creates a new transaction/payment record. The system doesn't auto-mutate financial state on uncertainty. Financial Attention signals unreviewed imports as ACTION_NEEDED.

---

## Forecasting & Time (Q61–72)

### 61. Why shouldn't uncertain reconciliation automatically mutate authoritative state?

Uncertainty is the domain of Remi (advisory). Financial state is RAF (authoritative). If an import might match a debt payment but you're unsure, leaving it unreviewed is correct. Mutating state based on guessed matching risks hiding the user's actual financial position. The user must confirm the match explicitly.

### 62. How does monthly close work conceptually?

(a) User reviews the month: transactions, income, allocations, buffer. (b) User decides how to disposition the remaining buffer (return to plan, allocate to surplus split, or leave for next month). (c) Server applies the disposition in a transaction: create `monthly_review` record, finalize `income_allocations`, calculate new `allocation_buckets` state for next month, mark the month as closed (immutable). (d) Forecast starts from the new next month.

### 63. What financial state becomes immutable or authoritative after close?

The `monthly_review` record is immutable (no edits allowed). The allocation state it captured is frozen. Income allocations are finalized. The month's spending totals are committed (new transactions in that month cannot be added—they'd go to the current month). The starting balance for the next month is calculated from the prior month's ending state.

### 64. What happens if a user tries to close the same month twice?

First close succeeds, creates a `monthly_review` with `closed_at` timestamp. Second attempt: server checks if the month is already closed, returns 409 Conflict or silently succeeds with 200 and returns the existing review (idempotent response).

### 65. How do you handle stale state during month close?

User opens month-close dialog, calculates remaining buffer ($100). Meanwhile, another session adds a transaction. User submits month-close with $100 disposition. Server recalculates the buffer fresh (now $95), and applies $95 disposition, not the stale $100. The frontend doesn't dictate the financial calculation; it's recomputed on submit.

### 66. Why is `return_to_plan` metadata-only, not another financial transaction?

Returning unused buffer to the plan is an intent statement, not a financial mutation. It doesn't create a transaction ledger entry. Instead, it sets metadata (`unused_buffer_returned: true` or similar on the monthly review). The next month, the plan engine respects the intent and adds the buffer back to available income. This keeps the ledger clean—no "magic" transactions appear.

### 67. How would accidentally adding unused buffer to surplus again create double counting?

If `return_to_plan` sets metadata AND creates a transaction, you've recorded the buffer twice: once as metadata (plan engine sees it), once as a ledger entry (spending sums include it). When the plan next month allocates income, the buffer is inflated. Or it appears in spending totals twice. Metadata-only avoids this.

### 68. How do you test month-boundary behavior like December → January?

Integration test: (a) create year-end month (Nov, Dec), (b) run a few transactions and allocations, (c) close Nov, verify Dec opening state is initialized correctly, (d) close Dec, verify Jan opening state starts fresh. Also test year rollover: forecast spans Dec/Jan, verify the low point is correctly attributed to the right month.

### 69. How does forecasting differ from authoritative current state?

Forecasting is *projection* of future state based on current authorities (balances, income, planned expenses, debt trajectories). Authoritative current state is what RAF knows now (recorded transactions, current balances, actual payments). Forecast never modifies the ledger. It consumes read-only data from RAF and projects forward, producing "if current patterns continue, your balance will dip to $X on Sep 23."

### 70. Why shouldn't a forecast modify the ledger?

A forecast is a prediction, not a fact. If a forecast modified the ledger (e.g., auto-creating projected transactions), then past forecasts would contaminate the present. You couldn't undo a bad forecast without manual cleanup. Forecasts are ephemeral—recalculated on every read, never persisted.

### 71. What assumptions does the 30/60/90-day forecast make?

(a) Income events recur as scheduled (fixed events, or trailing-average for variable income). (b) Planned expenses (fixed bills, debt payments) recur as scheduled. (c) Spending continues at trailing-average baseline. (d) No new unexpected transactions. (e) Account balances don't change except for scheduled activity. (f) Credit-card limits are infinite (no modeled overflow). If a user knows Q4 will be heavy spending, the forecast is conservative.

### 72. What happens when new financial information invalidates an existing forecast?

Forecast is recalculated on next read. New transactions, new income, new fixed bills, new debt payments all feed into the projection. Old forecast is discarded. This happens automatically; no cache invalidation needed. If the low point changes from Sep 23 to Oct 5, the user will see the new projection next time they visit the forecast.

---

## Remi & AI Integration (Q73–81)

### 73. Why did you introduce Remi instead of putting AI directly inside RAF's calculations?

RAF must be deterministic and auditable (same inputs always produce same outputs). LLMs are probabilistic and opaque. Putting an LLM inside RAF would make it impossible to guarantee financial calculations or debug why a user's state changed. Remi is a separate advisor layer: it consumes RAF's outputs, interprets them, explains them, and recommends actions. If Remi hallucinates, RAF's state is unaffected. RAF remains the source of truth.

### 74. What information is Remi allowed to interpret?

Pre-computed domain outputs:
- Account balances, transactions, transaction direction + category (human-reviewed)
- Debt snapshots (balance, payment pace, trajectory)
- Goal progress (sum of linked transactions)
- Forecast (projections, pressure points)
- Allocation state (intended budget vs. actual)
- Monthly review summaries

Remi analyzes these to explain (e.g., "you're on pace to pay off this debt 6 months early"), recommend (e.g., "increase the payment to reach your goal faster"), and contextualize ("this spike in spending is seasonal").

### 75. What is Remi explicitly not allowed to decide?

- Whether a transaction direction or category is correct (Financial Inbox decides this via user review)
- Whether an account balance is accurate (user reconciliation or bank import decides this)
- What financial action to execute (user confirms explicitly before any mutation)
- Whether a debt balance is up-to-date (account reconciliation or ledger update decides this)
- What the forecasted low point will be (the forecast engine calculates; Remi interprets)

Remi explains and recommends, RAF executes with user consent.

### 76. How do you prevent an LLM hallucination from changing a user's financial state?

Remi is read-only. It calls RAF's services to *retrieve* financial data but cannot call RAF's mutation APIs directly. If Remi recommends "pay $500 toward this debt," the user sees the recommendation. If they approve, they click a button that submits a separate request to RAF's mutation endpoint (authorization-gated, runs in a transaction, triggers all invariant checks). Remi's reasoning is only advisory; execution is always through RAF's authorized pathways.

### 77. If Remi says something that contradicts RAF, which wins and why?

RAF. RAF is the source of truth. If Remi says "you have 3 debts" but RAF lists 4 debts, RAF is correct. Remi's reasoning was flawed (misread the data, hallucination, or data changed between calls). User should trust RAF and distrust Remi's reasoning. This is why RAF's authority map is clear: Remi is a *consumer* of RAF's outputs, not a co-equal authority.

### 78. Would you ever allow Remi to execute financial actions? What controls?

No, not in the current architecture. If Remi were given execute permissions, the controls would be:

1. **Explicit user confirmation** for every action (no silent execution)
2. **Narrow scope** (Remi can adjust goals/allocations, never touch core balances or delete debts)
3. **Execution via RAF mutation APIs** (not direct SQL or special Remi paths)
4. **Audit logging** (every Remi action is logged with reasoning + user confirmation)
5. **Approval workflow** (actions are queued for user review; user sees the action + reasoning before confirming)
6. **Undo capability** (user can revert Remi-executed actions)

Even with these, it's risky—users might approve without reading, creating silent mutations. Better to keep Remi advisory.

### 79. How would you design tool calling for Remi safely?

Separate two code paths: (a) *recommend* tools (tool schema, example invocations, expected outputs—no mutation), (b) *execute* tools (after user explicitly confirms a recommendation). The recommend path allows Remi to show "here's a suggested action and why." The execute path runs only on user confirmation, inside a transaction, with full audit logging. Remi never auto-executes; the tool call is staged for user review.

### 80. Why is "AI explains state; it doesn't define truth" an architectural rule?

Because it prevents silent mutations from LLM inference. If AI could define truth, a hallucination becomes reality. If AI can only explain, a hallucination is merely a misinterpretation that the user can spot and ignore. This rule is architectural because it's enforced at the service layer (Remi is read-only) and the API layer (mutation endpoints don't accept Remi-suggested values as input). It's not just product copy; it's code structure.

### 81. How do you test financial software differently from normal CRUD?

(a) **Ledger reconciliation**: sum transactions, verify against account balances. (b) **Adversarial tests**: craft edge cases (negative balances, zero-balance months, concurrent writes). (c) **Forensic replay**: load a month's worth of transactions and re-derive all computed values; verify they match. (d) **RLS red-team tests**: try to break isolation. (e) **Snapshot diffs**: before/after refactoring, compute full financial state snapshots and compare. (f) **Baseline tests**: track pre-existing test failures separately from new regressions. Normal CRUD tests would be "create a user, delete a user, read a user." Financial tests are "allocate income, spend from bucket, verify balance doesn't go negative."

---

## Testing & Validation (Q82–91)

### 82. Why aren't unit tests sufficient for RAF?

Unit tests mock the database. A mock allocation trigger won't catch the real trigger (fixed in Branch D). A mock RLS policy won't test the real policy. A mock transaction won't catch a deadlock or a serialization conflict. Financial correctness requires real-world validators. Tests must run against real PostgreSQL to prove (a) triggers fire at the right time, (b) RLS blocks cross-tenant access, (c) constraints prevent invalid states.

### 83. What's the purpose of adversarial tests?

Adversarial tests simulate attack patterns: (a) try to IDOR into other workspaces, (b) submit invalid allocations (sum < 100%), (c) create circular references, (d) run concurrent writes, (e) exceed account balances, (f) refactor a financial formula and verify output doesn't change. Purpose: find bugs before users hit them. Phase 1–7 adversarial suites cover 8 domains; Phase 8 certification proved all pass.

### 84. What's the difference between testing an endpoint and testing a financial invariant?

Endpoint test: "POST /workspace/:id/income returns 200." Financial invariant test: "after posting income and allocating, the allocation sums equal 100%, and the account balance reflects the income." Endpoint testing is behavioral; financial testing is outcome-oriented. An endpoint can return 200 with corrupted financial state (if the financial logic is missing). Invariant testing catches this.

### 85. Why maintain PostgreSQL-specific integration tests?

Because RAF's financial correctness depends on PostgreSQL features (triggers, RLS, constraints, transactions). A test running against SQLite or an in-memory mock won't prove Postgres behavior. If a trigger is removed, a mock won't catch it. If RLS is disabled, a mock won't fail the test. Integration tests against real Postgres are the only way to validate the full stack.

### 86. What should CI/CD prove before a financial change merges?

(a) **Unit tests**: logic functions work in isolation. (b) **Integration tests**: repositories + services work with real Postgres. (c) **Tenant isolation tests**: RLS + application authorization prevent cross-workspace access. (d) **Financial regression tests**: before/after snapshots match (no unintended financial calculation changes). (e) **Adversarial tests**: edge cases don't break invariants. (f) **Lint**: code style, no secrets in committed files. All must pass. If any fails, block the merge.

### 87. Why run RLS tests separately?

RLS tests require two database connections (admin + restricted app role) and careful test isolation (one test's data shouldn't contaminate another's). Running them inline with unit tests would require spinning up multiple connection pools and careful setup/teardown. Separate RLS test suite (Branch E) is cleaner: dedicated test runner, clear setup, explicit two-pool pattern.

### 88. How do you distinguish a genuine regression from test-infrastructure instability?

Baseline comparison: first run of a new test is the baseline. If the test fails on the second run with the same code, it's infrastructure instability (flaky test, timing-dependent, or previous test contamination). If it passes on reruns, it's likely a real bug in the tested code. Adversarial tests Phase 1–7 are baselined; failures are compared against the baseline to detect new regressions vs. pre-existing failures.

### 89. Why compare against an exact baseline instead of calling pre-existing failures "ok"?

An exact baseline means you *know* what's currently failing and why. If a test starts passing, that's a regression you caught (test was meant to fail, but code unexpectedly fixed it—need to understand why). If a new test fails, you know it's new. Calling pre-existing failures "ok" lets them hide real bugs. The baseline is a contract: these tests fail *because* of these known architectural limitations. Fix a limitation, update the baseline.

### 90. How do you test failure injection and rollback?

Test infrastructure: (a) wrap a transaction in try/catch, (b) force an error mid-transaction (throw an error, violate a constraint), (c) verify rollback cleaned up the database, (d) run a query outside the transaction and confirm the row doesn't exist. Example: `await repository.insertDebt(tx, data)` succeeds, then `throw new Error()`, then check the DB—no debt row. Rollback worked.

### 91. How do you test concurrency problems that don't appear in normal tests?

Load tests + race condition injection: (a) spin up N concurrent API calls with the same request (e.g., create an allocation), (b) verify only one succeeds or all fail gracefully (no race condition where both create rows), (c) use PostgreSQL advisory locks to simulate contention, (d) run with `SERIALIZABLE` isolation to catch serialization conflicts, (e) measure lock contention and deadlock frequency. Manual timing tests (e.g., sleep in one transaction while another tries to read) also reveal concurrency issues.

---

## Migrations & Deployment (Q92–100)

### 92. What is your approach to database migrations?

Versioned SQL files in `migrations/` directory, applied forward-only. Runner loads `schema_migrations` table (audit log of applied migrations), compares against pending migrations, and applies new ones in order. Each migration file uses `CREATE TABLE IF NOT EXISTS` (idempotent for schema) and tracks applied state. Data migrations (backfills, UPDATEs) are not re-applied if already run—the runner prevents re-execution.

### 93. How do you know which migrations have been applied in production?

`schema_migrations` table in the database: `migration_id TEXT PRIMARY KEY, applied_at TIMESTAMP`. Before applying a migration, the runner checks if it's in this table. If yes, skip it. If no, execute it and log the row. This is the source of truth—not git history or deployment logs.

### 94. What problems did you encounter with migration-ledger divergence?

(A historical issue, resolved in Branch H): Git history showed a migration was committed, but it was never actually applied in production—schema_migrations table lacked the entry. The cause was manual application (DBA ran SQL directly without logging to schema_migrations) or a skipped migration step in the deploy process. Solution: enforce `ENABLE_POSTGRES_CI=true` in GitHub Actions so migrations are verified on every PR (test database gets a fresh migration run), and audit schema_migrations table before every production deployment.

### 95. Why is a migration existing in Git not proof that production has applied it?

Because migrations can be: (a) committed but never deployed (branch was abandoned), (b) deployed but schema_migrations not updated (manual execution), (c) deployed to a test environment but not production (different deploy target). Git is the source of *intent*; the database is the source of *truth*. Always check `schema_migrations` to know production's actual state.

### 96. How do you rehearse risky migrations before production?

Separate worktree + feature branch: (a) create a Neon branch from the production database (point-in-time clone), (b) apply pending migrations to the branch, (c) run full test suite against the cloned schema, (d) measure performance impact (migration time, lock contention), (e) gather team approval, (f) only then apply to production main branch. This proves the migration is safe and fast before real users are affected.

### 97. How would you roll back a bad schema change?

Write a reverse migration: if migration `0001_add_column.sql` added a column, the rollback migration `0001_reverse_add_column.sql` drops it. The runner doesn't automatically rollback; you must write explicit reverse migrations. Alternatively, if a migration is brand-new and hasn't been deployed to production yet, delete the commit and write a better version. Never try to "undo" production migrations by deleting schema_migrations rows—that causes future migrations to fail.

### 98. Why use separate feature worktrees for risky changes?

A worktree is an isolated git checkout. If you're testing a risky schema change, you work on a separate worktree (e.g., `git worktree add feature/risky-migration`), modify the database (Postgres allows `pg_restore` or `CREATE DATABASE` from dump), and test thoroughly. If anything goes wrong, you delete the worktree and the main branch is unaffected. This prevents broken schemas from being accidentally committed to main.

### 99. What must be true before you merge a financial change into main?

(a) **All CI passes**: unit, integration, RLS, lint tests. (b) **Code review**: another engineer verified the logic and security. (c) **No pre-existing test failures introduced**: compare baseline before/after. (d) **Financial regression tests pass**: before/after snapshots are identical (or approved change is intentional). (e) **RLS tests pass**: tenant isolation holds. (f) **Migration runs cleanly on Neon branch**: rehearsed against realistic data volume. (g) **Commit message is clear**: explains the financial impact, not just "fix bug." Only then merge.

### 100. Difference between "tests pass," "release certified," and "production verified"?

- **Tests pass**: CI green, code is syntactically correct and logically sound at the unit level.
- **Release certified**: full test suite passes, RLS red-team passes, financial regression passes, deployment checklist complete, no known blockers. Code is ready to ship.
- **Production verified**: release has been deployed to production for 24–72 hours, no customer-reported issues, logs are clean, no unusual RLS denials or Sentry errors. Release is stable.

A PR can have tests pass but fail release certification (e.g., a migration that's slow on real data). A release can be certified but fail production verification (e.g., a race condition that only appears under real-world load).

---

## Infrastructure & Operations (Q101–110)

### 101. How do Vercel, Render, PostgreSQL/Neon, and frontend/backend fit together?

Vercel: hosts React frontend (Vite), auto-deploys on git push, static assets served from CDN. Render: hosts Node/Express backend API, auto-deploys on git push, listens on a port. Neon: hosted PostgreSQL, accessed via connection string, supports branching (for testing). Data flow: React → Fetch to Render API → Render connects to Neon Postgres. Frontend and backend are separate deployments; they communicate via HTTP + CORS.

### 102. How do you prove code deployed to production corresponds to the commit you certified?

Deployment pipeline: (a) Render detects a push to the main branch, (b) checks out the commit, (c) runs tests, (d) builds the Docker image, (e) deploys to production. (f) Render logs the deployed commit SHA. Verify: SSH into the Render container and check `git log HEAD` to see the commit SHA, or check Render's deployment log. This proves the running code matches git.

### 103. How do you handle CORS between independently hosted frontend and backend?

Backend (Render) sets `Access-Control-Allow-Origin: https://nomi.app` (frontend's URL). Frontend sends authenticated requests with credentials (`fetch(..., { credentials: 'include' })` for cookies, or Authorization headers for tokens). Preflight OPTIONS requests are allowed. Backend verifies the request origin and responds with CORS headers. If frontend and backend are on different origins (different domains or ports), CORS headers are required.

### 104. Why should configuration and secrets be treated differently?

Configuration is values that vary per environment (API endpoint URL, feature flags, log level) but are not sensitive. They can be in `.env.example` (committed to git). Secrets are sensitive values (database password, API keys, JWT secrets) that must never be committed. They go in `.env.local` (gitignored) or environment variables (injected at deploy time via Render/Vercel settings). Treating them the same risks accidentally committing secrets.

### 105. What should happen if the database becomes temporarily unavailable?

Backend retries: exponential backoff on connection pool retries (up to 3 times, then fail). If Postgres is unavailable for >N seconds, return 503 Service Unavailable to clients. Frontend: show a "service temporarily down" message, retry the request. User can retry manually or wait. Don't cascade the outage (don't retry aggressively, don't spawn N background jobs that all fail). The database is the single point of failure—if Postgres is down, all financial operations are blocked (this is correct, not a bug).

### 106. How would you investigate a production 500 without modifying financial data?

(a) Check Sentry (error logs): what's the stack trace? (b) Check Render logs: what was the request? (c) Check Neon logs: any unusual database behavior (slow queries, locks, connection failures)? (d) Check GitHub for recent commits: did something just deploy? (e) Run a read-only query against production to diagnose the issue (SELECT only, never UPDATE). The goal is to understand the failure without making it worse. Financial data is read-only during investigation.

### 107. What financial/security information should never be logged?

- Account balances or transaction amounts
- User email addresses or workspace IDs (in most contexts—logging "user X accessed workspace Y" is audit trail; logging "workspace_id=abc123" in an error message is leakage)
- Passwords or tokens
- Bank routing numbers, credit-card numbers (PII)
- Full SQL queries (might include sensitive values)

Nomi scrubs these from Sentry by default and logs only the operation type and result (success/failure), not amounts.

### 108. How do you use observability without exposing sensitive financial information?

Structured logging with redaction: log the event type ("allocate income", "close month"), parameters that aren't sensitive (allocation ID, month), and outcome ("success", "failed: allocation percent sum < 100%"). Don't log amounts or balances. Use Sentry integrations that automatically redact numbers and PII. Audit logs record the user and action; financial data stays out.

### 109. What would happen if RAF suddenly had 100,000 users?

(a) PostgreSQL connection pool would be exhausted (default ~20 connections; 100k users would need 100k+ connections). Solution: use a connection pool multiplexer (PgBouncer) to share connections. (b) Compat adapter's full-table hydration would become unbearably slow (load 100k rows into memory per transaction). Solution: finish migration to direct SQL (Branch D work—mandatory at scale). (c) Forecast calculation for 100k workspaces would take too long. Solution: cache forecasts or run async. (d) Neon disk and compute would need to scale—handled by Neon autoscaling.

### 110. Where do you expect the first scaling bottleneck?

Database connection pool (without PgBouncer, each concurrent user needs a Postgres connection—exhausted at ~100 concurrent users). Second: compat adapter (full-table hydration is O(rows), doesn't scale to large workspaces). Third: forecast calculation (recalculated on every read, could be cached). Fourth: import processing (large statement files, AI parsing, full-text search indexing). Address them in that order: pooling first, migration to direct SQL second, caching third, async processing fourth.

---

## Advanced Scaling (Q111–120)

### 111. Would PostgreSQL RLS remain viable at larger scale?

Yes, with caveats. RLS adds a small per-query overhead (policy check at execution time). At 100k users, you wouldn't notice. At 10M users on one database, you'd start to see RLS overhead in query plans. Solution: partition tables by workspace (each workspace gets its own schema or database), reducing RLS scope. But RLS itself is still viable—it's a standard PostgreSQL feature, well-optimized.

### 112. Which operations would you cache, and which deliberately not cache?

**Cache:**
- Forecast (recalculated on every read; could be cached for 1 hour)
- Account freshness state (import timestamps, balance age)
- User's workspace list (rarely changes)

**Don't cache:**
- Current account balance (must be up-to-date)
- Debt snapshot (depends on latest ledger entries)
- Allocations (can change on every income entry)
- Monthly review state (immutable once closed, but needs fresh calculation for next month)

The rule: cache computed state, not authoritative state. If it's the source of truth, don't cache.

### 113. Which operations could safely run asynchronously?

**Can be async:**
- Import PDF parsing (AI extraction, can take 30s)
- Weekly email reminder generation
- Scheduled backup jobs
- Merchant rule compilation (run once, cache results)
- Forecast calculation for the next 7 months (pre-compute, cache, serve from cache)

**Must stay synchronous:**
- Authenticating a user
- Retrieving current balance
- Creating a transaction
- Applying buffer disposition
- Closing a month

Financial mutations and reads of current state must be synchronous (no race conditions). Advisory operations can be async.

### 114. When would you introduce queues or background workers?

When synchronous processing blocks the critical path. Example: import PDF parsing takes 30s. Today: user uploads, RAF parses, returns result (30s wait). Solution: queue the import job, return immediately (202 Accepted), and email the user when parsing is complete. This requires a job queue (e.g., Bull, Bree) and background worker process.

### 115. When would you introduce Redis?

When caching or session state becomes a bottleneck. Examples:
- Cache forecasts (TTL 1 hour): next forecast read hits Redis instead of recalculating
- Cache user's workspace list (TTL 24 hours)
- Rate limiting: track API calls per user in Redis (faster than DB lookups)
- Session store: store JWT session data in Redis instead of decoding on every request

Don't introduce Redis prematurely (premature optimization). Neon's built-in caching may be sufficient first.

### 116. When would you introduce microservices?

When a subdomain genuinely scales independently and needs its own data store / release cycle:
- Forecast service: heavy CPU, could scale with a read replica or separate database
- Import service: processes large files, could run on workers with a dedicated queue
- Audit service: append-only log, could use a time-series database

**Would never split:**
- Auth (single namespace)
- Financial ledger (shared across all domains)
- Monthly close (involves multiple domains)

Split only when the split reduces contention and complexity, not because it's "modern architecture."

### 117. How would you scale imports of large bank statements?

Async queue: (a) user uploads a 50k-row CSV, (b) server validates format, queues a job, returns immediately, (c) background worker parses CSV in batches (1k rows/sec), (d) for each batch, run AI categorization (parallel, N workers), (e) when complete, notify user and mark import as ready for review. Also: index the imported transaction search by merchant, account, date (allows filtering large imports quickly).

### 118. How would you prevent concurrent workers from processing the same import?

Database row lock: before processing, `SELECT ... FOR UPDATE` the import batch row. Only one worker can hold the lock; others wait. When the first worker finishes, it releases the lock and updates `status` to `processed`. Next worker sees the status and skips it. Alternatively: idempotency key + uniqueness constraint—if two workers try to insert the same transaction (same import batch + merchant + date + amount), the second fails on the constraint.

### 119. How would you evolve RAF to support multiple currencies?

Big change, not attempted yet. Considerations:
- Add `currency_code` to `financial_accounts` and `transactions`
- Amount storage: store as NUMERIC(14,2) per currency, not cents (cents are USD-specific)
- Display: always show currency code alongside amounts
- Forecast: sum balances across currencies (requires exchange rates, introduces risk)
- Debt: if a debt is in GBP and income is USD, how do you forecast repayment? (requires FX rates + time-dependent exchange rates)

This requires product decisions (how to handle multi-currency forecasts?) and deep schema changes. Deferred post-launch.

### 120. Hardest architectural decision?

Deciding to separate Remi from RAF. Early designs had AI-suggested allocations / AI decisions integrated into RAF. Separating them required: (a) accepting that Remi is advisory-only (not all recommendations are executed), (b) accepting that RAF's state might not match Remi's suggestions, (c) accepting that Remi can't fix financial problems automatically. The upside: RAF remains deterministic and auditable. The downside: Remi is less powerful. The decision was correct (determinism > convenience) but required convincing that financial data is not a playground for AI inference.

---

## Lessons Learned (Q121–135)

### 121. Example of a design you implemented and later discovered was unsafe?

Branch D: the compatibility adapter design assumed that full-table hydration per transaction wouldn't cause performance or correctness issues. After measuring, it showed: (a) O(rows) cost per mutation, (b) serialization via advisory locks, (c) write amplification across all known tables. The design was correct (preserved financial behavior during migration) but became a bottleneck. Lesson: don't assume a transitional design scales; measure and plan for removal.

### 122. Example of a bug tests didn't catch?

Pre-Branch D: `enforce_income_allocation_total` trigger used wrong parameter references (`$1` instead of `$2`), silently allowing allocations to exceed income. Tests didn't catch it because they tested the trigger in isolation (passed mock data). Integration tests ran against real Postgres (would have caught it). Lesson: test against real databases, not mocks, for constraint-level correctness.

### 123. Example where correctness was chosen over simplicity?

Monthly review persistence. Simple approach: calculate remaining buffer, return it, let frontend display it. Correct approach: persist the calculation in a `monthly_review` record so the calculation is auditable and immutable after close. Simple is faster to code; correct is safer for financial data. Chose correct.

### 124. Example of deliberately avoiding overengineering?

Debt interest calculation. Over-engineered option: auto-calculate interest based on interest rate + days + debt balance, update the balance nightly. Chosen approach: accept interest as a manual entry (user enters an adjustment of "+$50 interest"). Simple, auditable, and doesn't require interest-rate data (which varies per creditor and changes). Overengineering would add complexity without value.

### 125. Feature you decided not to build?

Credit-card statement parsing via OCR (extract balance, min payment, due date from a photo of the credit card statement). Reason: unreliable (OCR misreads numbers), creates false confidence (users assume the AI is accurate), duplicates functionality (users should link their bank account via import). Decided to keep credit cards manually entered instead. This keeps RAF conservative (only data the user provides or banks provide via import).

### 126. Most important technical debt?

Compat adapter still backs monthly reviews (6 methods) and imports (24 methods), plus 8 additional methods — 38 total. While it works, it adds serialization overhead via `pg_advisory_xact_lock` and full-table hydration on every compat-backed call (O(rows) per transaction). The penalty is not precisely profiled yet. It's not a blocker, but it's the first thing I'd remove post-launch — high-value refactor with clear ROI and a direct migration path to the direct-SQL repositories already proven in Branch D.

### 127. If you had two weeks to improve without adding features?

(a) **Remove compat adapter from monthly reviews + imports** (3 days): direct SQL repositories, no behavior change. (b) **Add idempotency keys to all financial mutations** (2 days): prevent double-charges on network retries. (c) **Implement backup/restore procedure + drill** (1 day): Neon branch → local Postgres, restore data, run tests. (d) **Add workspaceId to structured logs** (1 day): enable better debugging and tracing. (e) **Migrate non-sensitive activity log to structured format** (1 day): separate audit trail from activity feed. Remaining time: testing, hardening.

### 128. Most confident architectural decision?

Multi-layer tenant isolation (application auth + SQL WHERE + RLS). Each layer is independently verifiable (tests prove RLS works even if app auth fails). This gives high confidence that cross-tenant data escape is nearly impossible. If forced to choose one layer, I'd choose RLS—it's the hardest to bug because it's enforced by PostgreSQL itself, not trusting application code.

### 129. Least confident?

Import pipeline. It's still compat-backed, so I haven't fully verified it behaves correctly under concurrency or large data volumes. Database-layer uniqueness constraints now exist at both the batch level (`UNIQUE(workspace_id, file_hash)` on `raf.import_batches`) and the row level (`UNIQUE(workspace_id, fingerprint)` on `raf.imported_transactions`), so the duplicate-import race condition is covered. The remaining gap is behavioral correctness of the multi-step workflow (upload → parse → review → approve) under concurrent access — this hasn't been adversarially tested at high concurrency.

### 130. Assumption that could become invalid as the product grows?

That users have <100 debts, <100 accounts, <10k transactions per month. If users grow and these numbers increase 10x, the full-table hydration in the compat adapter becomes prohibitively slow. Also: assumption that monthly close takes <1s. With 10k transactions and 100+ allocation rules, calculation could take 5–10s. Solution: precompute or cache aggressively. Need to measure at scale.

### 131. Distinguish architectural decision from implementation detail?

**Architectural**: "All financial mutations run inside a database transaction" (enforces atomicity, high-level design choice). **Implementation detail**: "Use `pg_advisory_xact_lock` for compat adapter" (specific to the migration strategy, will be removed). Architectural decisions are long-lived and hard to change; implementation details are ephemeral. If you're unsure whether you can remove something without redesign, it's architectural.

### 132. Tradeoffs between speed and correctness?

Forecast calculation: correct version calculates on every read (adds latency proportional to data volume — unmeasured in production). Fast version caches for 1 hour (stale, but fast). Chosen: correct now, optimize with caching later (after measuring production behavior). For financial software, correctness is non-negotiable; speed is an optimization on top.

### 133. Why not use a third-party personal finance API?

Third-party APIs (Plaid, Finicity, etc.) provide data aggregation (connect to banks, get real-time transactions). They don't provide financial computation (allocation planning, forecasting, debt payoff calculation). Those are domain-specific to Nomi's product. Also: dependency risk (if the API changes, your product breaks). Also: cost scales with users (Plaid charges per API call). Also: data privacy (does the user own their data, or does the API provider?). Building RAF in-house gives you control over computation, schema, and pricing.

### 134. What RAF taught you that simpler projects wouldn't?

Determinism is hard. Distributed systems (multiple API instances, async workers, concurrent transactions) introduce non-determinism. Financial software must be deterministic. This forced learning on: database-layer invariant enforcement, transaction isolation levels, idempotency, ledger-based accounting (immutable entries, not mutable balances). A normal CRUD app can be sloppy (eventual consistency, last-write-wins); financial software cannot.

### 135. Most important technical lesson?

The three-layer isolation model (app auth + SQL WHERE + RLS). This is the pattern I'd apply to every multi-tenant system going forward. Each layer is independently verifiable and gives you confidence that even if one layer is breached, data remains isolated. It's not unique to RAF, but seeing it work in practice (Branch E proving it) convinced me it's the gold standard for tenant security.

---

## Master Question Summary

The 15 most critical questions to master for interviews:

1. **Why separate Nomi, RAF, and Remi?** — Enforces financial determinism, keeps AI advisory-only
2. **Where is the source of truth?** — PostgreSQL, workspace-scoped, domain-specific (balance vs. debt vs. spending)
3. **Why modular monolith not microservices?** — Domains couple through financial state; split only at scale
4. **Why use PostgreSQL RLS?** — Defense-in-depth; protects even if app auth fails
5. **Why raf_app role?** — NOBYPASSRLS forces all access through RLS gates
6. **What do transactions protect?** — Atomicity, isolation, consistency—no partial financial state
7. **Why atomic month-close?** — Prevents corruption if user navigates away before close
8. **How ensure shared transaction?** — All repos use same `tx` object; failure rolls back all
9. **Network drops after commit?** — Commit happened; retry is idempotent
10. **Idempotency + atomicity?** — Atomicity prevents partial state; idempotency prevents duplicate effects
11. **One authoritative calculation?** — Deterministic, lives in one place, no re-derivation
12. **Why Remi separate?** — LLM is probabilistic; RAF must be deterministic and auditable
13. **"AI explains, not defines"?** — Prevents silent mutations from LLM hallucinations
14. **Tests pass vs. release vs. verified?** — Tests = logic, release = full suite + review, verified = stable in production
15. **Hardest decision?** — Separating Remi from RAF; required accepting AI is advisory, not autonomous

---

**Use this guide to:**
- Understand RAF's architectural reasoning
- Prepare for deep technical interviews
- Articulate complex tradeoffs and decisions
- Demonstrate knowledge of financial systems, multi-tenancy, and security
- Show thinking about scaling, testing, and operations
