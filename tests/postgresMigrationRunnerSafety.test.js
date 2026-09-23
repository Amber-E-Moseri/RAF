import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';

import {
  applyMigrations,
  discoverMigrations,
  ensureMigrationLedger,
  readAppliedMigrations,
  validateMigrationOrder,
  calculateMigrationFrontier,
} from '../scripts/migrate.js';

// Use test database
const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/raf_test';

async function withTestDB(fn) {
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS raf CASCADE');
    return await fn(client);
  } finally {
    await client.end();
    await pool.end();
  }
}

async function withTempMigrationDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raf-pg-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeMigration(dir, filename, sql = `-- ${filename}\nselect 1;\n`) {
  await fs.writeFile(path.join(dir, filename), sql, 'utf8');
}

test.skip('PG-MIG-1: Historical-hole fail-closed with real PostgreSQL', async () => {
  if (!process.env.TEST_POSTGRES_URL) {
    console.log('Skipping: TEST_POSTGRES_URL not set');
    return;
  }

  await withTestDB(async (client) => {
    await withTempMigrationDir(async (dir) => {
      // Setup: M1, M2, M3, M4 in code
      await writeMigration(dir, '20260901000000_M1.sql', 'CREATE TABLE test_m1 (id INT);');
      await writeMigration(dir, '20260901000001_M2.sql', 'CREATE TABLE test_m2 (id INT);');
      await writeMigration(dir, '20260902000000_M3.sql', 'CREATE TABLE test_m3 (id INT);');
      await writeMigration(dir, '20260902000001_M4.sql', 'CREATE TABLE test_m4 (id INT);');

      // Initialize ledger with only M1 and M3 (historical hole)
      await ensureMigrationLedger(client);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260901000000_M1.sql']);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260902000000_M3.sql']);

      // Apply migrations - should fail before M2 executes
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, logger: { log() {} } }),
        /Unexpected historical migrations detected/,
      );

      // Verify no DDL executed for M2 or M4
      const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
      const tableNames = tables.rows.map((r) => r.table_name);

      assert.ok(!tableNames.includes('test_m2'), 'M2 should not have executed');
      assert.ok(!tableNames.includes('test_m4'), 'M4 should not have executed');
      assert.ok(tableNames.includes('test_m1'), 'M1 should exist');
      assert.ok(tableNames.includes('test_m3'), 'M3 should exist');

      // Verify ledger unchanged
      const ledger = await readAppliedMigrations(client);
      assert.deepEqual(ledger.sort(), ['20260901000000_M1.sql', '20260902000000_M3.sql']);
    });
  });
});

test.skip('PG-MIG-2: Check mode with real PostgreSQL', async () => {
  if (!process.env.TEST_POSTGRES_URL) return;

  await withTestDB(async (client) => {
    await withTempMigrationDir(async (dir) => {
      // Same fixture as PG-MIG-1
      await writeMigration(dir, '20260901000000_M1.sql', 'CREATE TABLE test_m1 (id INT);');
      await writeMigration(dir, '20260901000001_M2.sql', 'CREATE TABLE test_m2 (id INT);');
      await writeMigration(dir, '20260902000000_M3.sql', 'CREATE TABLE test_m3 (id INT);');
      await writeMigration(dir, '20260902000001_M4.sql', 'CREATE TABLE test_m4 (id INT);');

      await ensureMigrationLedger(client);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260901000000_M1.sql']);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260902000000_M3.sql']);

      // Check mode
      const result = await applyMigrations({ client, migrationsDir: dir, checkMode: true, logger: { log() {} } });
      assert.equal(result.ok, false, 'Check should fail due to historical migration');

      // Verify no tables created
      const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
      const tableNames = tables.rows.map((r) => r.table_name);
      assert.equal(tableNames.length, 0, 'No tables should be created in check mode');

      // Verify ledger unchanged
      const ledger = await readAppliedMigrations(client);
      assert.deepEqual(ledger.sort(), ['20260901000000_M1.sql', '20260902000000_M3.sql']);
    });
  });
});

test.skip('PG-MIG-3: Clean incremental with real PostgreSQL', async () => {
  if (!process.env.TEST_POSTGRES_URL) return;

  await withTestDB(async (client) => {
    await withTempMigrationDir(async (dir) => {
      // Setup: M1, M2, M3, M4 in code; M1, M2, M3 in ledger
      await writeMigration(dir, '20260901000000_M1.sql', 'CREATE TABLE test_m1 (id INT);');
      await writeMigration(dir, '20260901000001_M2.sql', 'CREATE TABLE test_m2 (id INT);');
      await writeMigration(dir, '20260902000000_M3.sql', 'CREATE TABLE test_m3 (id INT);');
      await writeMigration(dir, '20260902000001_M4.sql', 'CREATE TABLE test_m4 (id INT);');

      await ensureMigrationLedger(client);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260901000000_M1.sql']);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260901000001_M2.sql']);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260902000000_M3.sql']);

      // First run - apply M4
      const result1 = await applyMigrations({ client, migrationsDir: dir, logger: { log() {} } });
      assert.equal(result1.applied, 1, 'Should apply one migration (M4)');

      let tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
      let tableNames = tables.rows.map((r) => r.table_name);
      assert.ok(tableNames.includes('test_m4'), 'M4 should exist after first run');

      // Second run - idempotency check
      const result2 = await applyMigrations({ client, migrationsDir: dir, logger: { log() {} } });
      assert.equal(result2.applied, 0, 'Should not apply anything on second run');

      tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
      tableNames = tables.rows.map((r) => r.table_name);
      assert.ok(tableNames.includes('test_m4'), 'M4 should still exist');
      assert.equal(tableNames.filter((n) => n === 'test_m4').length, 1, 'M4 should exist exactly once');

      const ledger = await readAppliedMigrations(client);
      assert.equal(
        ledger.filter((f) => f === '20260902000001_M4.sql').length,
        1,
        'M4 should be ledgered exactly once',
      );
    });
  });
});

test.skip('PG-MIG-4: LEDGER_ONLY detection with real PostgreSQL', async () => {
  if (!process.env.TEST_POSTGRES_URL) return;

  await withTestDB(async (client) => {
    await withTempMigrationDir(async (dir) => {
      // Minimal migration in code
      await writeMigration(dir, '20260901000000_M1.sql', 'CREATE TABLE test_m1 (id INT);');

      // But ledger contains an orphan migration
      await ensureMigrationLedger(client);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260901000000_M1.sql']);
      await client.query('INSERT INTO raf.schema_migrations (filename) VALUES ($1)', ['20260901000001_orphan.sql']);

      // Should fail when trying to apply
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, logger: { log() {} } }),
        /Applied migration\(s\) are missing from db\/migrations/,
      );
    });
  });
});

test.skip('PG-MIG-5: Empty ledger fail-closed with real PostgreSQL', async () => {
  if (!process.env.TEST_POSTGRES_URL) return;

  await withTestDB(async (client) => {
    await withTempMigrationDir(async (dir) => {
      // Migrations in code but empty ledger
      await writeMigration(dir, '20260901000000_M1.sql', 'CREATE TABLE test_m1 (id INT);');
      await writeMigration(dir, '20260901000001_M2.sql', 'CREATE TABLE test_m2 (id INT);');

      // Initialize empty ledger
      await ensureMigrationLedger(client);

      // Normal mode should fail on empty ledger
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, logger: { log() {} } }),
        /Fresh database|empty migration ledger/i,
      );

      // Verify nothing was created
      const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
      assert.equal(tables.rows.length, 0, 'No tables should be created on empty ledger failure');

      // Verify ledger is still empty
      const ledger = await readAppliedMigrations(client);
      assert.equal(ledger.length, 0, 'Ledger should remain empty');
    });
  });
});
