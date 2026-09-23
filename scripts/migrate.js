#!/usr/bin/env node
// Run raf-schema migrations against the configured Postgres database.
// Usage: node scripts/migrate.js

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = path.join(scriptDir, '../db/migrations');
const envPath = path.join(scriptDir, '../.env');

export const MIGRATION_FILENAME_RE = /^\d{14}_[a-z0-9_]+\.sql$/;

export function loadDotEnv(filePath = envPath, env = process.env) {
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const eq = l.indexOf('=');
      if (eq < 1) continue;
      const key = l.slice(0, eq).trim();
      const val = l.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!env[key]) env[key] = val;
    }
  } catch {}
}

export async function discoverMigrations(migrationsDir = defaultMigrationsDir) {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const invalid = filenames.filter((filename) => !MIGRATION_FILENAME_RE.test(filename));
  if (invalid.length > 0) {
    throw new Error(`Invalid migration filename(s): ${invalid.join(', ')}`);
  }

  const seenIds = new Map();
  const duplicates = [];
  for (const filename of filenames) {
    const id = filename.slice(0, 14);
    const first = seenIds.get(id);
    if (first) duplicates.push(`${first}, ${filename}`);
    seenIds.set(id, filename);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate migration id(s): ${duplicates.join('; ')}`);
  }

  return filenames;
}

export async function ensureMigrationLedger(client, ledgerSchema = 'raf') {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${ledgerSchema}.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } catch {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ledgerSchema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${ledgerSchema}.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }
}

export async function readAppliedMigrations(client, ledgerSchema = 'raf') {
  const { rows } = await client.query(
    `SELECT filename FROM ${ledgerSchema}.schema_migrations ORDER BY filename`,
  );
  return rows.map((row) => row.filename);
}

export function assertAppliedMigrationsKnown(applied, discovered) {
  const discoveredSet = new Set(discovered);
  const unknown = applied.filter((filename) => !discoveredSet.has(filename));
  if (unknown.length > 0) {
    throw new Error(
      `Applied migration(s) are missing from db/migrations: ${unknown.join(', ')}`,
    );
  }
}

export function calculateMigrationFrontier(applied) {
  if (applied.length === 0) return null;
  // Frontier is the ID (first 14 chars) of the last applied migration
  return applied[applied.length - 1].slice(0, 14);
}

export function validateMigrationOrder(discovered, applied) {
  const frontier = calculateMigrationFrontier(applied);
  const appliedSet = new Set(applied);

  // Find unexpected historical migrations: discovered but not applied, and before frontier
  const unexpectedHistorical = [];
  for (const filename of discovered) {
    const id = filename.slice(0, 14);
    if (!appliedSet.has(filename) && frontier && id < frontier) {
      unexpectedHistorical.push(filename);
    }
  }

  return { frontier, unexpectedHistorical };
}

export async function printPreflight(discovered, applied, logger = console) {
  const { frontier, unexpectedHistorical } = validateMigrationOrder(discovered, applied);
  const appliedSet = new Set(applied);
  const pending = discovered.filter((f) => !appliedSet.has(f));

  logger.log('\n═══════════════════════════════════════════════════════════════');
  logger.log('MIGRATION PREFLIGHT REPORT');
  logger.log('═══════════════════════════════════════════════════════════════');
  logger.log(`Frontier: ${frontier || '(none - fresh database)'}`);
  logger.log(`Applied: ${applied.length}`);
  logger.log(`Pending: ${pending.length}`);

  if (unexpectedHistorical.length > 0) {
    logger.log('\n🔴 UNEXPECTED HISTORICAL MIGRATIONS:');
    unexpectedHistorical.forEach((f) => logger.log(`     ${f}`));
  }

  if (pending.length > 0) {
    logger.log('\n✅ PENDING (will apply):');
    pending.forEach((f) => logger.log(`     ${f}`));
  } else if (unexpectedHistorical.length === 0) {
    logger.log('\n✅ No pending migrations.');
  }

  if (unexpectedHistorical.length > 0) {
    logger.log('\n🔴 FAIL: Unexpected historical migrations detected.');
    logger.log('   This usually means a migration was deleted from the code');
    logger.log('   and then restored, or the database state is inconsistent.');
    logger.log('   Review the frontier and validate the repository state.');
    return false;
  }

  logger.log('\n✅ Status: OK - Ready to apply.');
  logger.log('═══════════════════════════════════════════════════════════════\n');
  return true;
}

export async function applyMigrations({
  client,
  migrationsDir = defaultMigrationsDir,
  logger = console,
  checkMode = false,
  allowBootstrap = false,
  ledgerSchema = 'raf',
} = {}) {
  if (!client) throw new Error('client is required');

  const migrations = await discoverMigrations(migrationsDir);

  await ensureMigrationLedger(client, ledgerSchema);

  const applied = await readAppliedMigrations(client, ledgerSchema);
  assertAppliedMigrationsKnown(applied, migrations);

  // Preflight: validate migration order and print report
  const { frontier, unexpectedHistorical } = validateMigrationOrder(migrations, applied);

  // Fail closed on empty ledger unless explicitly approved for bootstrap
  if (applied.length === 0 && !allowBootstrap) {
    logger.log('\n🔴 ERROR: Fresh database detected — migration ledger is empty.');
    logger.log('   This may be a fresh database or lost migration history.');
    logger.log('   Starting bootstrap without confirmation is unsafe.');
    logger.log('');
    logger.log('   To intentionally initialize a new database, use:');
    logger.log('   node scripts/migrate.js --bootstrap');
    logger.log('');
    throw new Error('Fresh database detected: migration ledger is empty. Use --bootstrap for fresh database initialization.');
  }

  if (checkMode) {
    const ok = await printPreflight(migrations, applied, logger);
    return { discovered: migrations.length, applied: 0, ok };
  }

  // Secondary guard (reached only when allowBootstrap=true bypasses the primary check above).
  // Even with bootstrap permission, fail if frontier is null and there are pending migrations —
  // this path would apply all migrations blindly which is intentional for bootstrap only.
  if (frontier === null && migrations.length > 0 && !allowBootstrap) {
    const appliedSet = new Set(applied);
    const pending = migrations.filter((f) => !appliedSet.has(f));
    if (pending.length > 0) {
      await printPreflight(migrations, applied, logger);
      throw new Error(
        `Fresh database (empty migration ledger) is not supported for automatic initialization. ` +
        `This usually indicates a new Neon branch or empty database. ` +
        `Initialize the database using an explicit supported bootstrap procedure, ` +
        `or restore a database snapshot with known migration history.`
      );
    }
  }

  // Before applying any migrations, fail if unexpected historical migrations are detected
  if (unexpectedHistorical.length > 0) {
    await printPreflight(migrations, applied, logger);
    throw new Error(
      `Unexpected historical migrations detected: ${unexpectedHistorical.join(', ')}. ` +
      'Review the frontier and validate the repository state before proceeding.'
    );
  }

  const appliedSet = new Set(applied);

  for (const filename of migrations) {
    if (appliedSet.has(filename)) {
      logger.log(`  skip  ${filename} (already applied)`);
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    logger.log(`  run   ${filename} ...`);
    await client.query(sql);
    await client.query(
      `INSERT INTO ${ledgerSchema}.schema_migrations (filename) VALUES ($1)`,
      [filename],
    );
    logger.log(`  done  ${filename}`);
  }

  return { discovered: migrations.length, applied: migrations.length - appliedSet.size, ok: true };
}

export async function run() {
  loadDotEnv();

  const connStr = process.env.POSTGRES_CONNECTION_STRING;
  if (!connStr) {
    console.error('POSTGRES_CONNECTION_STRING not set');
    process.exitCode = 1;
    return;
  }

  const checkMode = process.argv.includes('--check');
  const allowBootstrap = process.argv.includes('--bootstrap');

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connStr });

  try {
    await client.connect();
    console.log('Connected to Postgres');
    const result = await applyMigrations({
      client,
      migrationsDir: defaultMigrationsDir,
      checkMode,
      allowBootstrap,
    });

    if (checkMode) {
      process.exitCode = result.ok ? 0 : 1;
    } else {
      console.log(`\n${result.applied} migration(s) applied.`);
      if (result.applied === 0) {
        console.log('All migrations are up to date.');
      }
    }
  } catch (err) {
    console.error('\nError:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
