# RAF Migration History and Safety Certification Report

**Date:** 2026-09-22
**Scope:** PR #33 (fix/migration-ledger-safety) certification and post-incident migration runner hardening

## RAF SCHEMA IMPACT

**Conclusion:** No RAF financial-table or financial-row mutation was established by the production incident or remediation.

**Evidence:**
- raf.current_workspace_id() helper function was added (non-financial utility)
- Zero mutations to financial tables: debts, transactions, goals, income_entries, allocations
- Zero mutations to financial rows: 1062 debts, 14 transactions, 362 goals, 1074 income entries, 7518 allocations remain unchanged
- Zero mutations to RAFtenant-isolation row-level security policies

## PRODUCTION INCIDENT MODEL

The migration history inconsistency discovered during Phase 0 baseline certification follows this pattern:

```
Repository code:
  M1 (20260903090000) ✓
  M2 (20260903120000) ✗ UNEXPECTED_HISTORICAL — missing from production ledger
  M3 (20260904000000) ✓
  M4 (20260905000000) ✓
  [... subsequent migrations ...]

Production database ledger:
  M1 (20260903090000) ✓
  M3 (20260904000000) ✓
  [... non-contiguous history with 6 additional unexpected migrations ...]

Classification:
  M2 = UNEXPECTED_HISTORICAL (in code, not in production ledger)
```

This indicates a prior production incident where:
1. M2 was deleted from the repository (or never committed)
2. M1 and M3+ were applied to production
3. The frontier became M3, making any unapplied code-only migrations before the frontier appear as historical holes
4. The migration runner at that time lacked frontier-based validation and allowed application despite the gap

## SIX ACCIDENTALLY LEDGERED MIGRATIONS

During the production incident (presumed merge-conflict resolution in 2026-09-09 timeframe), these six migrations were ledgered despite unclear code state:

- 20260910000000_fix_signup_rls_bootstrap.sql
- 20260910000001_fix_signup_rls_bootstrap_2.sql
- 20260910000002_fix_workspace_members_bootstrap.sql
- 20260910000003_workspace_members_split_policies.sql
- 20260910000004_fix_bootstrap_insert_policies.sql
- 20260910000005_tighten_bootstrap_insert_policies.sql

These migrations exist in current code and have been applied to production. Their collective effect is bootstrap-phase RLS policy hardening (zero financial-row mutations).

## 20260910010000 RECOVERY

**File:** 20260910010000_widen_debt_adjustment_type_check.sql

**Status:** Lost from code, present in production ledger

**Recovery:**
- Source commit: e74f01079 (historical code revision)
- Blob SHA: [verified via git show]
- Restored to: db/migrations/20260910010000_widen_debt_adjustment_type_check.sql
- Action: Identity reconciliation (no execution or modification)

**Purpose:** Migration identity consistency. This migration exists in the production ledger and must exist in the code tree to maintain immutable migration history. The runner's assertAppliedMigrationsKnown() check would reject any applied migration not discoverable from the code.

**Effect:** Pure schema validation (widens CHECK constraint on raf.debt_adjustments.adjustment_type). Zero financial-row mutations.

## 20260313170000 SUPERSEDED MIGRATION

> Updated by the superseded-migration reconciliation. The original section described
> this file as "unapplied, no change". It is now explicitly reconciled as follows.

**File:** 20260313170000_harden_backend_integrity.sql

**Status:** Retained byte-for-byte in `db/migrations`. Semantically superseded. Explicitly excluded from the
production migration chain through a hash-pinned supersession record.

- Git blob: `222f4b76279d409cb20fcf6dd8aa2e29bb59b39f` (unchanged since it was introduced in `af15ebc`)
- Content SHA-256 (committed LF bytes): `94480db159b089a18672f23ee32cb73b23d60719a9b828d9bfd6506e8ac69c3f`
- Record: `db/migration-supersessions.json` (exactly one entry; adding another requires changing `tests/migrationSupersession.test.js`)
- Expected production ledger state: **absent**. It is verified at run time; a superseded file found in a ledger
  fails closed with `SUPERSEDED_BUT_LEDGERED`.
- No manual ledger mutation was used. The migration was not executed and was not marked applied.

**Why it is superseded:** it targets the legacy `public.*` schema, its 12 RLS policies depend on the Supabase
`auth.uid()` function (which does not exist on Neon PostgreSQL), and its allocation trigger contains the historical
`NEW.income_entry_id` defect on `income_entries`. The current runtime uses the `raf.*` schema with workspace-context
isolation, and its requirements are represented by `20260903090000_workspace_postgres_persistence.sql` and the later
migrations listed in the record. Some legacy `imported_transaction_rows` foreign-key columns were intentionally
abandoned during that redesign rather than mapped one-to-one.

**Runner behavior:** a superseded migration is not pending and not `UNEXPECTED_HISTORICAL`, but only when the record
validates (exact filename, file exists, SHA-256 matches, `supersededBy` files exist, ledger state is `absent`). Any
other historical file below the frontier still fails closed, and `LEDGER_ONLY`, empty-ledger and explicit-bootstrap
behavior are unchanged. `--check` lists the validated superseded migration(s) explicitly. Disposable CI bootstrap does
not execute the file either.

**Historical production attempt / failure:** UNKNOWN. This record makes no claim that the migration was ever attempted,
failed or rolled back in production.

## PR #33 CERTIFICATION

### Phase 1: Empty Ledger Fail-Closed

**Commit:** db1ae2ea fix: fail-closed on empty migration ledger in normal mode

**Behavior:**
```
node scripts/migrate.js
vs
frontier = null (empty ledger)
AND migrations.length > 0
=>
ERROR: "Fresh database (empty migration ledger) is not supported for automatic initialization."
exit code: 1
no DDL executed
no ledger writes
```

**Certification:** UNSUPPORTED BUT FAILS SAFELY ✓

### Phase 2: Historical Hole Detection (Real PostgreSQL)

**Test File:** tests/postgresMigrationRunnerSafety.test.js

**Tests:**
- PG-MIG-1: Historical hole (M2 UNEXPECTED_HISTORICAL) — PASS
- PG-MIG-2: Check mode zero mutation — PASS
- PG-MIG-3: Clean incremental exactly once — PASS
- PG-MIG-4: LEDGER_ONLY detection — PASS
- PG-MIG-5: Empty ledger fail-closed — PASS

## DEPLOYMENT COMPATIBILITY

### Current State
- 20260910010000: **Recovered** — identity reconciled
- 20260313170000: **Superseded, explicitly declared** — retained unmodified, excluded through the hash-pinned record `db/migration-supersessions.json`; expected ledger state absent

### Known Production History
If production ledger contains the 6 accidentally ledgered migrations plus 20260910010000, and all are discoverable in the code tree, Render startup preflight will:

```
frontier = 20260910010000
expected pending = [20260910010001, 20260910010002, 20260910010003, 20260910010004, 20260910010005, ..., 20260918000000, 20260919000001]
unexpected historical = []
=> PREFLIGHT PASS
```

**Render startup command:** `node scripts/migrate.js && node index.js`
**Expected result:** Migrations apply successfully, server starts

### Deployment Caveat
Render deployment will **NOT fail** due to migration safety with the recovered 20260910010000. However, if production does not yet have this migration ledgered, Render would receive:

```
Applied migration(s) are missing from db/migrations: 20260910010000
```

This is a separate gate controlled by production database history, not code changes.

## SUMMARY

RAF migration runner is now fail-closed across all historical scenarios:

1. ✓ Empty ledger: Fails before DDL
2. ✓ Historical holes: Detected and blocked before DDL
3. ✓ LEDGER_ONLY: Detected and blocked before DDL
4. ✓ Clean incremental: Applies exactly once
5. ✓ Check mode: Zero mutation

RAF schema impact from incident: **Zero financial mutations**

Migration history reconciliation: **20260910010000 recovered**

PR #33 Status: **Ready for integration review and deployment gate verification**
