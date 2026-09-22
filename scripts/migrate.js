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

export async function ensureMigrationLedger(client) {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS raf.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } catch {
    await client.query('CREATE SCHEMA IF NOT EXISTS raf');
    await client.query(`
      CREATE TABLE IF NOT EXISTS raf.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }
}

export async function readAppliedMigrations(client) {
  const { rows } = await client.query(
    'SELECT filename FROM raf.schema_migrations ORDER BY filename',
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

export async function applyMigrations({
  client,
  migrationsDir = defaultMigrationsDir,
  logger = console,
} = {}) {
  if (!client) throw new Error('client is required');

  const migrations = await discoverMigrations(migrationsDir);

  await ensureMigrationLedger(client);

  const applied = await readAppliedMigrations(client);
  assertAppliedMigrationsKnown(applied, migrations);
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
      'INSERT INTO raf.schema_migrations (filename) VALUES ($1)',
      [filename],
    );
    logger.log(`  done  ${filename}`);
  }

  return { discovered: migrations.length, applied: migrations.length - appliedSet.size };
}

export async function run() {
  loadDotEnv();

  const connStr = process.env.POSTGRES_CONNECTION_STRING;
  if (!connStr) {
    console.error('POSTGRES_CONNECTION_STRING not set');
    process.exitCode = 1;
    return;
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connStr });

  try {
    await client.connect();
    console.log('Connected to Postgres');
    await applyMigrations({ client, migrationsDir: defaultMigrationsDir });
    console.log('\nAll migrations applied.');
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
