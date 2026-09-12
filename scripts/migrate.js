#!/usr/bin/env node
// Run raf-schema migrations against the configured Postgres database.
// Usage: node scripts/migrate.js

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Load .env manually (project has no dotenv dep)
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env');
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const eq = l.indexOf('=');
    if (eq < 1) continue;
    const key = l.slice(0, eq).trim();
    const val = l.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}


const { Client } = pg;

const RAF_MIGRATIONS = [
  '20260903090000_workspace_postgres_persistence.sql',
  '20260903120000_financial_accounts.sql',
  '20260904000000_collaboration.sql',
  '20260905000000_add_token_blacklist.sql',
  '20260908000000_fix_income_entry_allocation_trigger.sql',
  '20260908020000_tighten_financial_rls_policies.sql',
  '20260909000000_create_raf_app_role.sql',
  '20260909010000_branch_g_activity_category.sql',
  '20260910000000_fix_signup_rls_bootstrap.sql',
  '20260910000001_fix_signup_rls_bootstrap_2.sql',
  '20260910000002_fix_workspace_members_bootstrap.sql',
  '20260910000003_workspace_members_split_policies.sql',
  '20260910000004_fix_bootstrap_insert_policies.sql',
  '20260910000005_tighten_bootstrap_insert_policies.sql',
  '20260910000006_owner_scoped_signup_bootstrap.sql',
  '20260910000008_debt_payment_pace_acknowledgements.sql',
  '20260912000001_transaction_splits.sql',
];

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

const connStr = process.env.POSTGRES_CONNECTION_STRING;
if (!connStr) {
  console.error('POSTGRES_CONNECTION_STRING not set');
  process.exit(1);
}

const client = new Client({ connectionString: connStr });

try {
  await client.connect();
  console.log('Connected to Postgres');

  // Ensure migration tracking table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS raf.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch(async () => {
    // raf schema might not exist yet — create it minimally, then retry
    await client.query('CREATE SCHEMA IF NOT EXISTS raf');
    await client.query(`
      CREATE TABLE IF NOT EXISTS raf.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  const { rows: applied } = await client.query(
    'SELECT filename FROM raf.schema_migrations ORDER BY filename',
  );
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const filename of RAF_MIGRATIONS) {
    if (appliedSet.has(filename)) {
      console.log(`  skip  ${filename} (already applied)`);
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    console.log(`  run   ${filename} ...`);
    await client.query(sql);
    await client.query(
      'INSERT INTO raf.schema_migrations (filename) VALUES ($1)',
      [filename],
    );
    console.log(`  done  ${filename}`);
  }

  console.log('\nAll migrations applied.');
} finally {
  await client.end();
}
