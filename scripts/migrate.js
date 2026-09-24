#!/usr/bin/env node
// Run raf-schema migrations against the configured Postgres database.
// Usage: node scripts/migrate.js

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = path.join(scriptDir, '../db/migrations');
const envPath = path.join(scriptDir, '../.env');
export const SUPERSESSION_RECORD_PATH = path.join(scriptDir, '../db/migration-supersessions.json');

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

const SUPPORTED_SUPERSEDED_LEDGER_STATES = new Set(['absent']);
const SUPERSESSION_ENTRY_KEYS = ['filename', 'sha256', 'expectedLedgerState', 'supersededBy', 'reason'];

// SHA-256 of migration content with line endings normalised to LF, so the pinned hash
// matches the committed bytes on checkouts that rewrite line endings (e.g. core.autocrlf).
export function hashMigrationContent(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

// Loads and strictly validates the supersession record. A superseded migration is retained
// in db/migrations but intentionally not part of the production migration chain. Matching is
// by exact filename only: no patterns, ranges, or wildcards.
export async function loadSupersessions({
  recordPath = SUPERSESSION_RECORD_PATH,
  migrationsDir = defaultMigrationsDir,
  discovered,
} = {}) {
  const discoveredSet = new Set(discovered ?? (await discoverMigrations(migrationsDir)));

  let record;
  try {
    record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  } catch (err) {
    throw new Error(`Supersession record unreadable (${recordPath}): ${err.message}`);
  }
  if (!record || typeof record !== 'object' || !Array.isArray(record.supersessions)) {
    throw new Error('Supersession record must be an object with a "supersessions" array');
  }

  const seen = new Set();
  const entries = [];
  for (const entry of record.supersessions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Supersession entry must be an object');
    }
    const { filename } = entry;
    const label = `Supersession entry ${JSON.stringify(filename)}`;

    const unknownKeys = Object.keys(entry).filter((key) => !SUPERSESSION_ENTRY_KEYS.includes(key));
    if (unknownKeys.length > 0) throw new Error(`${label}: unsupported field(s): ${unknownKeys.join(', ')}`);
    if (typeof filename !== 'string' || !MIGRATION_FILENAME_RE.test(filename)) {
      throw new Error(`${label}: filename must be an exact migration filename (no patterns or ranges)`);
    }
    if (seen.has(filename)) throw new Error(`${label}: duplicate supersession entry`);
    seen.add(filename);
    if (!discoveredSet.has(filename)) {
      throw new Error(`${label}: superseded migration does not exist in db/migrations`);
    }
    if (!SUPPORTED_SUPERSEDED_LEDGER_STATES.has(entry.expectedLedgerState)) {
      throw new Error(`${label}: unsupported expectedLedgerState ${JSON.stringify(entry.expectedLedgerState)}`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`${label}: reason is required`);
    }
    if (
      !Array.isArray(entry.supersededBy) ||
      entry.supersededBy.length === 0 ||
      entry.supersededBy.some((name) => typeof name !== 'string' || !discoveredSet.has(name) || name === filename)
    ) {
      throw new Error(`${label}: supersededBy must list existing migrations other than itself`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`${label}: sha256 must be a lowercase hex SHA-256`);
    }
    const actual = hashMigrationContent(await fs.readFile(path.join(migrationsDir, filename)));
    if (actual !== entry.sha256) {
      throw new Error(`${label}: SHA-256 mismatch (declared ${entry.sha256}, actual ${actual})`);
    }
    entries.push(entry);
  }
  return entries;
}

export function assertSupersededNotLedgered(applied, supersessions) {
  const appliedSet = new Set(applied);
  const ledgered = supersessions
    .filter((entry) => entry.expectedLedgerState === 'absent' && appliedSet.has(entry.filename))
    .map((entry) => entry.filename);
  if (ledgered.length > 0) {
    throw new Error(
      `SUPERSEDED_BUT_LEDGERED: migration(s) declared superseded (expected absent from ledger) ` +
      `are present in the migration ledger: ${ledgered.join(', ')}`,
    );
  }
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

export function validateMigrationOrder(discovered, applied, supersededFilenames = []) {
  const frontier = calculateMigrationFrontier(applied);
  const appliedSet = new Set(applied);
  const supersededSet = new Set(supersededFilenames);

  // Find unexpected historical migrations: discovered but not applied, and before frontier
  const unexpectedHistorical = [];
  for (const filename of discovered) {
    const id = filename.slice(0, 14);
    if (!appliedSet.has(filename) && !supersededSet.has(filename) && frontier && id < frontier) {
      unexpectedHistorical.push(filename);
    }
  }

  return { frontier, unexpectedHistorical };
}

export async function printPreflight(discovered, applied, logger = console, superseded = []) {
  const { frontier, unexpectedHistorical } = validateMigrationOrder(discovered, applied, superseded);
  const appliedSet = new Set(applied);
  const supersededSet = new Set(superseded);
  const pending = discovered.filter((f) => !appliedSet.has(f) && !supersededSet.has(f));

  logger.log('\n═══════════════════════════════════════════════════════════════');
  logger.log('MIGRATION PREFLIGHT REPORT');
  logger.log('═══════════════════════════════════════════════════════════════');
  logger.log(`Frontier: ${frontier || '(none - fresh database)'}`);
  logger.log(`Applied: ${applied.length}`);
  logger.log(`Pending: ${pending.length}`);
  logger.log(`Superseded (validated, will not run): ${superseded.length}`);

  if (superseded.length > 0) {
    logger.log('\nℹ️  SUPERSEDED (declared, hash-verified, absent from ledger):');
    superseded.forEach((f) => logger.log(`     ${f}`));
  }

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
  supersessionRecordPath = null,
} = {}) {
  if (!client) throw new Error('client is required');

  const migrations = await discoverMigrations(migrationsDir);

  // Validate the supersession record before any database access.
  const supersessions = supersessionRecordPath
    ? await loadSupersessions({ recordPath: supersessionRecordPath, migrationsDir, discovered: migrations })
    : [];
  const superseded = supersessions.map((entry) => entry.filename);
  const supersededSet = new Set(superseded);
  // Only reported when a supersession record is active, preserving the result shape otherwise.
  const supersededResult = supersessions.length > 0 ? { superseded } : {};

  await ensureMigrationLedger(client, ledgerSchema);

  const applied = await readAppliedMigrations(client, ledgerSchema);
  assertAppliedMigrationsKnown(applied, migrations);
  assertSupersededNotLedgered(applied, supersessions);

  // Preflight: validate migration order and print report
  const { frontier, unexpectedHistorical } = validateMigrationOrder(migrations, applied, superseded);

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
    const ok = await printPreflight(migrations, applied, logger, superseded);
    return { discovered: migrations.length, applied: 0, ...supersededResult, ok };
  }

  // Fail-closed on empty ledger: fresh database initialization is not automatically supported
  // unless the caller explicitly opts in via allowBootstrap (used by CI setup only).
  // Production (Render) never sets allowBootstrap, preserving fail-closed safety.
  if (frontier === null && migrations.length > 0 && !allowBootstrap) {
    const appliedSet = new Set(applied);
    const pending = migrations.filter((f) => !appliedSet.has(f) && !supersededSet.has(f));
    if (pending.length > 0) {
      await printPreflight(migrations, applied, logger, superseded);
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
    await printPreflight(migrations, applied, logger, superseded);
    throw new Error(
      `Unexpected historical migrations detected: ${unexpectedHistorical.join(', ')}. ` +
      'Review the frontier and validate the repository state before proceeding.'
    );
  }

  const appliedSet = new Set(applied);
  let executed = 0;

  for (const filename of migrations) {
    if (appliedSet.has(filename)) {
      logger.log(`  skip  ${filename} (already applied)`);
      continue;
    }
    if (supersededSet.has(filename)) {
      logger.log(`  skip  ${filename} (superseded, not executed, not ledgered)`);
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    logger.log(`  run   ${filename} ...`);
    await client.query(sql);
    await client.query(
      `INSERT INTO ${ledgerSchema}.schema_migrations (filename) VALUES ($1)`,
      [filename],
    );
    executed += 1;
    logger.log(`  done  ${filename}`);
  }

  return { discovered: migrations.length, applied: executed, ...supersededResult, ok: true };
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
  // Accept --bootstrap CLI flag OR RAF_ALLOW_BOOTSTRAP env var (e.g. CI setup).
  // The inner redeclaration that previously shadowed this line has been removed.
  const allowBootstrap = process.argv.includes('--bootstrap') || process.env.RAF_ALLOW_BOOTSTRAP === 'true';

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
      supersessionRecordPath: SUPERSESSION_RECORD_PATH,
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
