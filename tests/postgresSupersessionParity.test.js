/**
 * Current-schema parity for the superseded 20260313170000 migration.
 *
 * Runs against a disposable database that was initialised by `node scripts/migrate.js
 * --bootstrap` with db/migration-supersessions.json active (CI does exactly this).
 *
 * Proves:
 *   1. the superseded legacy migration did NOT execute (no ledger row, none of its
 *      public.* objects), and
 *   2. the current raf.* integrity / security model it was superseded by is intact.
 *
 * It intentionally does not require any legacy public.* object from the superseded file.
 *
 * Gate conditions (same as the other real-PostgreSQL suites):
 *   DATABASE_URL, RAF_RUN_POSTGRES_RLS_TESTS=true, RAF_CONFIRM_NON_PRODUCTION_DB=true
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const SUPERSEDED_FILE = '20260313170000_harden_backend_integrity.sql';

const adminUrl = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const shouldRun = Boolean(
  adminUrl &&
    process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true' &&
    process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true',
);
const maybeTest = shouldRun ? test : test.skip;

const sslOption =
  process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
    ? false
    : { rejectUnauthorized: false };

async function withPool(fn) {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

maybeTest('parity: superseded 20260313170000 did not execute and is not in the ledger', async () => {
  await withPool(async (pool) => {
    const { rows: ledger } = await pool.query(
      'SELECT filename FROM raf.schema_migrations WHERE filename = $1',
      [SUPERSEDED_FILE],
    );
    assert.equal(ledger.length, 0, 'superseded migration must not be ledgered');

    const { rows: total } = await pool.query('SELECT COUNT(*) FROM raf.schema_migrations');
    assert.ok(Number(total[0].count) > 0, 'bootstrap must have applied the rest of the chain');

    // Objects that only 20260313170000 creates (all in the legacy public schema).
    const { rows: constraints } = await pool.query(
      `SELECT conname FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
         AND conname = ANY($1::text[])`,
      [[
        'households_savings_floor_nonnegative_chk',
        'debts_apr_nonnegative_chk',
        'import_batches_id_household_unique',
        'merchant_rules_id_household_unique',
        'transactions_import_batch_fk',
        'imported_transaction_rows_batch_fk',
        'merchant_rules_category_fk',
      ]],
    );
    assert.deepEqual(constraints, [], 'no constraint from the superseded migration exists');

    const { rows: policies } = await pool.query(
      `SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND policyname = ANY($1::text[])`,
      [[
        'households_owner_policy',
        'allocation_categories_household_policy',
        'surplus_split_rules_household_policy',
        'income_entries_household_policy',
        'income_allocations_household_policy',
        'transactions_household_policy',
        'debts_household_policy',
        'debt_payments_household_policy',
        'import_batches_household_policy',
        'imported_transaction_rows_household_policy',
        'merchant_rules_household_policy',
        'monthly_reviews_household_policy',
      ]],
    );
    assert.deepEqual(policies, [], 'no auth.uid() owner policy from the superseded migration exists');

    const { rows: objects } = await pool.query(
      `SELECT 'function' AS kind, proname AS name FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname = 'enforce_income_allocation_total'
       UNION ALL
       SELECT 'index', indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_debt_payments_transaction_id_unique',
                            'idx_transactions_household_dedup_lookup',
                            'idx_income_allocations_income_entry_id',
                            'idx_merchant_rules_household_priority_created_at')`,
    );
    assert.deepEqual(objects, [], 'no function or index from the superseded migration exists');

    const { rows: triggers } = await pool.query(
      `SELECT t.tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
          AND t.tgname IN ('trg_income_entries_allocation_total', 'trg_income_allocations_total')`,
    );
    assert.deepEqual(triggers, [], 'no public.* allocation trigger from the superseded migration exists');
  });
});

maybeTest('parity: raf allocation-integrity enforcement exists', async () => {
  await withPool(async (pool) => {
    const { rows: fn } = await pool.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'raf'
          AND proname IN ('enforce_income_allocation_total',
                          'enforce_active_allocation_percent_sum',
                          'enforce_active_surplus_split_percent_sum',
                          'prevent_debt_delete_with_payments')
        ORDER BY proname`,
    );
    assert.deepEqual(
      fn.map((r) => r.proname),
      [
        'enforce_active_allocation_percent_sum',
        'enforce_active_surplus_split_percent_sum',
        'enforce_income_allocation_total',
        'prevent_debt_delete_with_payments',
      ],
    );

    const { rows: triggers } = await pool.query(
      `SELECT c.relname, t.tgname, t.tgdeferrable, t.tginitdeferred
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'raf' AND NOT t.tgisinternal
          AND t.tgname IN ('trg_income_entries_allocation_total', 'trg_income_allocations_total')
        ORDER BY t.tgname`,
    );
    assert.deepEqual(
      triggers.map((r) => [r.relname, r.tgname]),
      [
        ['income_allocations', 'trg_income_allocations_total'],
        ['income_entries', 'trg_income_entries_allocation_total'],
      ],
    );
    for (const trigger of triggers) {
      assert.equal(trigger.tgdeferrable, true, `${trigger.tgname} is a deferrable constraint trigger`);
      assert.equal(trigger.tginitdeferred, true, `${trigger.tgname} is initially deferred`);
    }
  });
});

maybeTest('parity: raf tenant RLS is enabled and forced on the financial tables', async () => {
  await withPool(async (pool) => {
    const tables = [
      'households',
      'allocation_categories',
      'surplus_split_rules',
      'income_entries',
      'income_allocations',
      'transactions',
      'debts',
      'debt_payments',
    ];
    const { rows } = await pool.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'raf' AND c.relkind = 'r' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [tables],
    );
    assert.equal(rows.length, tables.length, 'every financial table exists in raf');
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true, `raf.${row.relname} has RLS enabled`);
      assert.equal(row.relforcerowsecurity, true, `raf.${row.relname} has RLS forced`);
    }

    const { rows: policies } = await pool.query(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'raf' AND tablename = ANY($1::text[])
        GROUP BY tablename`,
      [tables],
    );
    assert.deepEqual(
      policies.map((r) => r.tablename).sort(),
      [...tables].sort(),
      'every financial table has at least one raf RLS policy',
    );
  });
});

maybeTest('parity: raf workspace-context isolation functions exist', async () => {
  await withPool(async (pool) => {
    const { rows } = await pool.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'raf'
          AND proname IN ('current_app_user_id', 'current_workspace_id',
                          'has_workspace_membership', 'has_workspace_role')
        ORDER BY proname`,
    );
    assert.deepEqual(rows.map((r) => r.proname), [
      'current_app_user_id',
      'current_workspace_id',
      'has_workspace_membership',
      'has_workspace_role',
    ]);
  });
});
