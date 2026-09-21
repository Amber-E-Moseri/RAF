import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyMigrations,
  assertAppliedMigrationsKnown,
  discoverMigrations,
} from '../scripts/migrate.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raf-migrations-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeMigration(dir, filename, sql = `-- ${filename}\nselect 1;\n`) {
  await fs.writeFile(path.join(dir, filename), sql, 'utf8');
}

class FakeClient {
  constructor({ applied = [], failSql = null } = {}) {
    this.applied = applied;
    this.failSql = failSql;
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });

    if (/select filename from raf\.schema_migrations/i.test(sql)) {
      return { rows: this.applied.map((filename) => ({ filename })) };
    }

    if (this.failSql && sql.includes(this.failSql)) {
      throw new Error('migration failed');
    }

    return { rows: [] };
  }
}

test('discoverMigrations returns every repository migration in canonical filename order', async () => {
  const migrationsDir = path.resolve('db/migrations');
  const fsEntries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const expected = fsEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const discovered = await discoverMigrations(migrationsDir);

  assert.deepEqual(discovered, expected);
  assert.ok(
    discovered.includes('20260919000001_import_batch_file_idempotency.sql'),
    'release idempotency migration must be discovered without editing the runner',
  );
});

test('discoverMigrations rejects invalid migration filenames', async () => {
  await withTempDir(async (dir) => {
    await writeMigration(dir, '20260901000000_valid_name.sql');
    await writeMigration(dir, '20260901000001-Bad-Name.sql');

    await assert.rejects(
      () => discoverMigrations(dir),
      /Invalid migration filename\(s\): 20260901000001-Bad-Name\.sql/,
    );
  });
});

test('discoverMigrations rejects duplicate migration timestamp ids', async () => {
  await withTempDir(async (dir) => {
    await writeMigration(dir, '20260901000000_alpha.sql');
    await writeMigration(dir, '20260901000000_beta.sql');

    await assert.rejects(
      () => discoverMigrations(dir),
      /Duplicate migration id\(s\): 20260901000000_alpha\.sql, 20260901000000_beta\.sql/,
    );
  });
});

test('assertAppliedMigrationsKnown fails when the ledger is ahead of source truth', () => {
  assert.throws(
    () =>
      assertAppliedMigrationsKnown(
        ['20260901000000_known.sql', '20260901000001_missing.sql'],
        ['20260901000000_known.sql'],
      ),
    /Applied migration\(s\) are missing from db\/migrations: 20260901000001_missing\.sql/,
  );
});

test('applyMigrations skips already-applied files and records new files only after SQL succeeds', async () => {
  await withTempDir(async (dir) => {
    await writeMigration(dir, '20260901000000_first.sql', 'select 1;');
    await writeMigration(dir, '20260901000001_second.sql', 'select 2;');
    const client = new FakeClient({ applied: ['20260901000000_first.sql'] });

    const result = await applyMigrations({
      client,
      migrationsDir: dir,
      logger: { log() {} },
    });

    assert.deepEqual(result, { discovered: 2, applied: 1 });
    assert.equal(
      client.calls.filter((call) => call.sql === 'select 1;').length,
      0,
      'already-applied migration SQL is not rerun',
    );
    assert.equal(
      client.calls.filter((call) => call.sql === 'select 2;').length,
      1,
      'pending migration SQL is run once',
    );
    assert.ok(
      client.calls.some(
        (call) =>
          /insert into raf\.schema_migrations/i.test(call.sql) &&
          call.params[0] === '20260901000001_second.sql',
      ),
      'pending migration is recorded in the ledger',
    );
  });
});

test('applyMigrations does not record a failed migration in the ledger', async () => {
  await withTempDir(async (dir) => {
    await writeMigration(dir, '20260901000000_fails.sql', 'select boom;');
    const client = new FakeClient({ failSql: 'select boom;' });

    await assert.rejects(
      () =>
        applyMigrations({
          client,
          migrationsDir: dir,
          logger: { log() {} },
        }),
      /migration failed/,
    );

    assert.equal(
      client.calls.filter((call) => /insert into raf\.schema_migrations/i.test(call.sql))
        .length,
      0,
      'failed migration is not inserted into schema_migrations',
    );
  });
});
