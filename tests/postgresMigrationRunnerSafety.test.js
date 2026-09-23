/**
 * PG-MIG-1 through PG-MIG-5 — Real PostgreSQL migration runner safety certification.
 *
 * These tests prove fail-closed behavior against actual PostgreSQL, not mocked clients.
 *
 * Gate conditions:
 *   DATABASE_URL                   — admin connection (for setup and verification)
 *   POSTGRES_CONNECTION_STRING_APP — raf_app connection (optional, for read-only checks)
 *   RAF_RUN_POSTGRES_RLS_TESTS     — must be 'true'
 *   RAF_CONFIRM_NON_PRODUCTION_DB  — must be 'true'
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';

import {
  applyMigrations,
} from '../scripts/migrate.js';

const adminUrl = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const rlsEnabled = process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true';
const nonProd = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const shouldRun = Boolean(adminUrl && rlsEnabled && nonProd);
const maybeTest = shouldRun ? test : test.skip;

const sslOption = process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
  ? false
  : { rejectUnauthorized: false };

async function createTestFixture(testName, migrations) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raf-pg-mig-'));
  for (const [filename, sql] of Object.entries(migrations)) {
    await fs.writeFile(path.join(tmpDir, filename), sql, 'utf8');
  }
  return tmpDir;
}

async function cleanupTestSchema(client, schemaName) {
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  } catch {}
}

// ── PG-MIG-1: HISTORICAL HOLE ──────────────────────────────────────────

maybeTest('PG-MIG-1: historical hole (M2 UNEXPECTED_HISTORICAL) fails before DDL execution', async () => {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  const client = await pool.connect();
  const schemaName = 'pgmig1_test';

  try {
    await cleanupTestSchema(client, schemaName);
    await client.query(`CREATE SCHEMA ${schemaName}`);

    // Create test fixture: M1 < M2 < M3 < M4, ledger has M1 + M3 only
    const tmpDir = await createTestFixture('PG-MIG-1', {
      '20000101000000_m1.sql': `CREATE TABLE ${schemaName}.m1_table AS SELECT 1;`,
      '20000101000001_m2.sql': `CREATE TABLE ${schemaName}.sentinel_m2 AS SELECT 2;`,
      '20000101000002_m3.sql': `CREATE TABLE ${schemaName}.m3_table AS SELECT 3;`,
      '20000101000003_m4.sql': `CREATE TABLE ${schemaName}.sentinel_m4 AS SELECT 4;`,
    });

    try {
      // Set up migration ledger with M1 and M3 only
      await client.query(`
        CREATE TABLE ${schemaName}.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz DEFAULT now()
        )
      `);
      await client.query(
        `INSERT INTO ${schemaName}.schema_migrations (filename) VALUES ($1), ($2)`,
        ['20000101000000_m1.sql', '20000101000002_m3.sql'],
      );

      // Try to apply migrations — should fail on M2 (UNEXPECTED_HISTORICAL)
      const testClient = new (await import('pg')).Client({
        connectionString: adminUrl,
        ssl: sslOption,
      });
      await testClient.connect();

      try {
        let thrownError = null;
        try {
          await applyMigrations({
            client: testClient,
            migrationsDir: tmpDir,
            ledgerSchema: schemaName,
            logger: { log: () => {} },
          });
        } catch (err) {
          thrownError = err;
        }

        assert.ok(
          thrownError && thrownError.message.includes('Unexpected historical migrations'),
          'Should throw on unexpected historical (M2)',
        );

        // Verify no DDL was executed
        const { rows: m2Check } = await client.query(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'sentinel_m2') AS exists`,
          [schemaName],
        );
        assert.equal(m2Check[0].exists, false, 'M2 sentinel must not exist');

        const { rows: m4Check } = await client.query(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'sentinel_m4') AS exists`,
          [schemaName],
        );
        assert.equal(m4Check[0].exists, false, 'M4 sentinel must not exist');

        // Verify ledger unchanged
        const { rows: ledgerRows } = await client.query(
          `SELECT filename FROM ${schemaName}.schema_migrations ORDER BY filename`,
        );
        assert.deepEqual(
          ledgerRows.map((r) => r.filename),
          ['20000101000000_m1.sql', '20000101000002_m3.sql'],
          'Ledger must remain unchanged',
        );
      } finally {
        await testClient.end();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await cleanupTestSchema(client, schemaName);
    client.release();
    await pool.end();
  }
});

// ── PG-MIG-2: CHECK MODE ZERO MUTATION ─────────────────────────────────

maybeTest('PG-MIG-2: check mode does not mutate database or ledger', async () => {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  const client = await pool.connect();
  const schemaName = 'pgmig2_test';

  try {
    await cleanupTestSchema(client, schemaName);
    await client.query(`CREATE SCHEMA ${schemaName}`);

    const tmpDir = await createTestFixture('PG-MIG-2', {
      '20000101000000_m1.sql': `CREATE TABLE ${schemaName}.m1_table AS SELECT 1;`,
      '20000101000001_m2.sql': `CREATE TABLE ${schemaName}.sentinel_m2 AS SELECT 2;`,
      '20000101000002_m3.sql': `CREATE TABLE ${schemaName}.m3_table AS SELECT 3;`,
      '20000101000003_m4.sql': `CREATE TABLE ${schemaName}.sentinel_m4 AS SELECT 4;`,
    });

    try {
      // Set up ledger with M1 + M3
      await client.query(`
        CREATE TABLE ${schemaName}.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz DEFAULT now()
        )
      `);
      await client.query(
        `INSERT INTO ${schemaName}.schema_migrations (filename) VALUES ($1), ($2)`,
        ['20000101000000_m1.sql', '20000101000002_m3.sql'],
      );

      // Run check mode
      const testClient = new (await import('pg')).Client({
        connectionString: adminUrl,
        ssl: sslOption,
      });
      await testClient.connect();

      try {
        const result = await applyMigrations({
          client: testClient,
          migrationsDir: tmpDir,
          ledgerSchema: schemaName,
          logger: { log: () => {} },
          checkMode: true,
        });

        assert.equal(result.ok, false, 'Check mode should report not-ok due to unexpected historical');

        // Verify no DDL executed
        const { rows: m2Check } = await client.query(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'sentinel_m2') AS exists`,
          [schemaName],
        );
        assert.equal(m2Check[0].exists, false, 'M2 sentinel must not exist (check mode)');

        const { rows: m4Check } = await client.query(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'sentinel_m4') AS exists`,
          [schemaName],
        );
        assert.equal(m4Check[0].exists, false, 'M4 sentinel must not exist (check mode)');

        // Verify ledger unchanged
        const { rows: ledgerRows } = await client.query(
          `SELECT filename FROM ${schemaName}.schema_migrations ORDER BY filename`,
        );
        assert.deepEqual(
          ledgerRows.map((r) => r.filename),
          ['20000101000000_m1.sql', '20000101000002_m3.sql'],
          'Ledger must remain unchanged (check mode)',
        );
      } finally {
        await testClient.end();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await cleanupTestSchema(client, schemaName);
    client.release();
    await pool.end();
  }
});

// ── PG-MIG-3: CLEAN INCREMENTAL EXACTLY ONCE ───────────────────────────

maybeTest('PG-MIG-3: clean incremental migration applies exactly once', async () => {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  const client = await pool.connect();
  const schemaName = 'pgmig3_test';

  try {
    await cleanupTestSchema(client, schemaName);
    await client.query(`CREATE SCHEMA ${schemaName}`);

    const tmpDir = await createTestFixture('PG-MIG-3', {
      '20000101000000_m1.sql': `CREATE TABLE ${schemaName}.m1_table AS SELECT 1;`,
      '20000101000001_m2.sql': `CREATE TABLE ${schemaName}.m2_table AS SELECT 2;`,
      '20000101000002_m3.sql': `CREATE TABLE ${schemaName}.m3_table AS SELECT 3;`,
      '20000101000003_m4.sql': `
        CREATE TABLE ${schemaName}.m4_counter AS SELECT 1 AS count;
        INSERT INTO ${schemaName}.m4_counter VALUES (1);
      `,
    });

    try {
      // Set up ledger with M1, M2, M3 (M4 is pending)
      await client.query(`
        CREATE TABLE ${schemaName}.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz DEFAULT now()
        )
      `);
      await client.query(
        `INSERT INTO ${schemaName}.schema_migrations (filename) VALUES ($1), ($2), ($3)`,
        ['20000101000000_m1.sql', '20000101000001_m2.sql', '20000101000002_m3.sql'],
      );

      const testClient = new (await import('pg')).Client({
        connectionString: adminUrl,
        ssl: sslOption,
      });
      await testClient.connect();

      try {
        // First run
        const result1 = await applyMigrations({
          client: testClient,
          migrationsDir: tmpDir,
          ledgerSchema: schemaName,
          logger: { log: () => {} },
        });
        assert.equal(result1.applied, 1, 'First run should apply 1 migration');

        const { rows: countAfterFirst } = await client.query(
          `SELECT COUNT(*) FROM ${schemaName}.m4_counter`,
        );
        // COUNT(*) returns bigint which node-postgres serializes as string
        assert.equal(Number(countAfterFirst[0].count), 2, 'M4 should have executed once (1 + 1)');

        // Second run
        const result2 = await applyMigrations({
          client: testClient,
          migrationsDir: tmpDir,
          ledgerSchema: schemaName,
          logger: { log: () => {} },
        });
        assert.equal(result2.applied, 0, 'Second run should apply 0 migrations');

        const { rows: countAfterSecond } = await client.query(
          `SELECT COUNT(*) FROM ${schemaName}.m4_counter`,
        );
        assert.equal(Number(countAfterSecond[0].count), 2, 'M4 count must remain 2 (not 3)');

        // Verify ledger has M4 exactly once
        const { rows: ledgerRows } = await client.query(
          `SELECT filename FROM ${schemaName}.schema_migrations WHERE filename LIKE '%m4%'`,
        );
        assert.equal(ledgerRows.length, 1, 'M4 must appear in ledger exactly once');
      } finally {
        await testClient.end();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await cleanupTestSchema(client, schemaName);
    client.release();
    await pool.end();
  }
});

// ── PG-MIG-4: LEDGER_ONLY ──────────────────────────────────────────────

maybeTest('PG-MIG-4: LEDGER_ONLY migration detected and normal mode fails', async () => {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  const client = await pool.connect();
  const schemaName = 'pgmig4_test';

  try {
    await cleanupTestSchema(client, schemaName);
    await client.query(`CREATE SCHEMA ${schemaName}`);

    // Repository has only M1 and M2
    const tmpDir = await createTestFixture('PG-MIG-4', {
      '20000101000000_m1.sql': `CREATE TABLE ${schemaName}.m1_table AS SELECT 1;`,
      '20000101000001_m2.sql': `CREATE TABLE ${schemaName}.m2_table AS SELECT 2;`,
    });

    try {
      // Ledger has M1, phantom M3, and we'll test pending M2
      await client.query(`
        CREATE TABLE ${schemaName}.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz DEFAULT now()
        )
      `);
      await client.query(
        `INSERT INTO ${schemaName}.schema_migrations (filename) VALUES ($1), ($2)`,
        ['20000101000000_m1.sql', '20000101000099_phantom.sql'],
      );

      const testClient = new (await import('pg')).Client({
        connectionString: adminUrl,
        ssl: sslOption,
      });
      await testClient.connect();

      try {
        // Normal mode should fail (LEDGER_ONLY phantom.sql)
        let thrownError = null;
        try {
          await applyMigrations({
            client: testClient,
            migrationsDir: tmpDir,
            ledgerSchema: schemaName,
            logger: { log: () => {} },
          });
        } catch (err) {
          thrownError = err;
        }

        assert.ok(
          thrownError && thrownError.message.includes('missing from db/migrations'),
          'Should throw on LEDGER_ONLY (phantom.sql)',
        );

        // Verify no new DDL
        const { rows: m2Check } = await client.query(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'm2_table') AS exists`,
          [schemaName],
        );
        assert.equal(m2Check[0].exists, false, 'M2 must not execute when LEDGER_ONLY blocks');
      } finally {
        await testClient.end();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await cleanupTestSchema(client, schemaName);
    client.release();
    await pool.end();
  }
});

// ── PG-MIG-5: EMPTY LEDGER ─────────────────────────────────────────────

maybeTest('PG-MIG-5: empty ledger fails closed before migration execution', async () => {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  const client = await pool.connect();
  const schemaName = 'pgmig5_test';

  try {
    await cleanupTestSchema(client, schemaName);
    await client.query(`CREATE SCHEMA ${schemaName}`);

    const tmpDir = await createTestFixture('PG-MIG-5', {
      '20000101000000_m1.sql': `CREATE TABLE ${schemaName}.sentinel_m1 AS SELECT 1;`,
    });

    try {
      // Create empty migration ledger (no applied migrations)
      await client.query(`
        CREATE TABLE ${schemaName}.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz DEFAULT now()
        )
      `);

      const testClient = new (await import('pg')).Client({
        connectionString: adminUrl,
        ssl: sslOption,
      });
      await testClient.connect();

      try {
        // Normal mode against empty ledger should fail
        let thrownError = null;
        try {
          await applyMigrations({
            client: testClient,
            migrationsDir: tmpDir,
            ledgerSchema: schemaName,
            logger: { log: () => {} },
          });
        } catch (err) {
          thrownError = err;
        }

        assert.ok(
          thrownError && thrownError.message.includes('Fresh database'),
          'Should throw on empty ledger',
        );

        // Verify no DDL executed
        const { rows: m1Check } = await client.query(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'sentinel_m1') AS exists`,
          [schemaName],
        );
        assert.equal(m1Check[0].exists, false, 'M1 sentinel must not exist');

        // Verify ledger remains empty (COUNT(*) returns bigint as string in node-postgres)
        const { rows: ledgerRows } = await client.query(
          `SELECT COUNT(*) FROM ${schemaName}.schema_migrations`,
        );
        assert.equal(Number(ledgerRows[0].count), 0, 'Ledger must remain empty');
      } finally {
        await testClient.end();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await cleanupTestSchema(client, schemaName);
    client.release();
    await pool.end();
  }
});
