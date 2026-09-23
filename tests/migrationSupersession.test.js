import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SUPERSESSION_RECORD_PATH,
  applyMigrations,
  discoverMigrations,
  hashMigrationContent,
  loadSupersessions,
  validateMigrationOrder,
} from '../scripts/migrate.js';

const SUPERSEDED_FILE = '20260313170000_harden_backend_integrity.sql';
const SUPERSEDED_FILE_SHA256 = '94480db159b089a18672f23ee32cb73b23d60719a9b828d9bfd6506e8ac69c3f';
const silent = { log() {} };

class FakeClient {
  constructor({ applied = [] } = {}) {
    this.applied = applied;
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (/select filename from raf\.schema_migrations/i.test(sql)) {
      return { rows: this.applied.map((filename) => ({ filename })) };
    }
    return { rows: [] };
  }

  get mutatingCalls() {
    return this.calls.filter(
      (call) =>
        !/^\s*(select\b|create table if not exists raf\.schema_migrations)/i.test(call.sql),
    );
  }
}

// Fixture: M1 < M2 (historical, optionally superseded) < M3 (applied frontier) < M4 (pending).
async function withFixture(fn, { record, files } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raf-supersession-'));
  const migrations = files ?? {
    '20000101000000_m1.sql': 'select 1;',
    '20000101000001_m2.sql': 'select 2;',
    '20000101000002_m3.sql': 'select 3;',
    '20000101000003_m4.sql': 'select 4;',
  };
  try {
    for (const [name, sql] of Object.entries(migrations)) {
      await fs.writeFile(path.join(dir, name), sql, 'utf8');
    }
    const recordPath = path.join(dir, 'supersessions.record.json');
    const entry = (overrides = {}) => ({
      filename: '20000101000001_m2.sql',
      sha256: hashMigrationContent(migrations['20000101000001_m2.sql'] ?? ''),
      expectedLedgerState: 'absent',
      supersededBy: ['20000101000002_m3.sql'],
      reason: 'test fixture',
      ...overrides,
    });
    const writeRecord = async (supersessions) =>
      fs.writeFile(recordPath, JSON.stringify({ supersessions }), 'utf8');
    if (record !== undefined) await writeRecord(record(entry));
    return await fn({ dir, recordPath, entry, writeRecord });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const LEDGER_M1_M3 = ['20000101000000_m1.sql', '20000101000002_m3.sql'];

test('SUP-1: valid supersession record loads', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const entries = await loadSupersessions({ recordPath, migrationsDir: dir });
      assert.deepEqual(entries.map((e) => e.filename), ['20000101000001_m2.sql']);
    },
    { record: (entry) => [entry()] },
  );
});

test('SUP-1b: hash is stable across LF and CRLF checkouts', () => {
  assert.equal(hashMigrationContent('a\nb\n'), hashMigrationContent('a\r\nb\r\n'));
  assert.notEqual(hashMigrationContent('a\nb\n'), hashMigrationContent('a\nc\n'));
});

test('SUP-2: superseded migration missing from db/migrations fails closed', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      await assert.rejects(
        () => loadSupersessions({ recordPath, migrationsDir: dir }),
        /does not exist in db\/migrations/,
      );
      const client = new FakeClient({ applied: LEDGER_M1_M3 });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        /does not exist in db\/migrations/,
      );
      assert.equal(client.calls.length, 0, 'record validation fails before any database access');
    },
    {
      record: (entry) => [entry({ filename: '20000101000009_gone.sql' })],
    },
  );
});

test('SUP-3: hash mismatch fails closed before any database access', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: LEDGER_M1_M3 });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        /SHA-256 mismatch/,
      );
      assert.equal(client.calls.length, 0);
    },
    { record: (entry) => [entry({ sha256: 'f'.repeat(64) })] },
  );
});

test('SUP-4: missing or invalid supersededBy fails closed', async () => {
  const bad = [
    undefined,
    [],
    'not-an-array',
    ['20000101000077_nonexistent.sql'],
    ['20000101000001_m2.sql'], // self reference
  ];
  for (const supersededBy of bad) {
    await withFixture(
      async ({ dir, recordPath }) => {
        await assert.rejects(
          () => loadSupersessions({ recordPath, migrationsDir: dir }),
          /supersededBy must list existing migrations other than itself/,
          `supersededBy=${JSON.stringify(supersededBy)}`,
        );
      },
      { record: (entry) => [entry({ supersededBy })] },
    );
  }
});

test('SUP-4b: unsupported expectedLedgerState, missing reason, bad sha format, unknown field fail closed', async () => {
  const cases = [
    [{ expectedLedgerState: 'present' }, /unsupported expectedLedgerState/],
    [{ expectedLedgerState: undefined }, /unsupported expectedLedgerState/],
    [{ reason: '  ' }, /reason is required/],
    [{ sha256: 'ABC' }, /sha256 must be a lowercase hex SHA-256/],
    [{ extra: true }, /unsupported field/],
  ];
  for (const [overrides, pattern] of cases) {
    await withFixture(
      async ({ dir, recordPath }) => {
        await assert.rejects(() => loadSupersessions({ recordPath, migrationsDir: dir }), pattern);
      },
      { record: (entry) => [entry(overrides)] },
    );
  }
});

test('SUP-5: duplicate supersession entry fails closed', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      await assert.rejects(
        () => loadSupersessions({ recordPath, migrationsDir: dir }),
        /duplicate supersession entry/,
      );
    },
    { record: (entry) => [entry(), entry()] },
  );
});

test('SUP-6: wildcard, range and pattern entries are rejected', async () => {
  for (const filename of [
    '*.sql',
    '20000101*_m2.sql',
    '20000101000001_m*.sql',
    '2000010100000[0-9]_m2.sql',
    '20000101000000..20000101000003',
    '20000101000001_m2',
    '',
  ]) {
    await withFixture(
      async ({ dir, recordPath }) => {
        await assert.rejects(
          () => loadSupersessions({ recordPath, migrationsDir: dir }),
          /filename must be an exact migration filename/,
          `filename=${JSON.stringify(filename)}`,
        );
      },
      { record: (entry) => [entry({ filename })] },
    );
  }
});

test('SUP-6b: missing or malformed record file fails closed', async () => {
  await withFixture(async ({ dir, recordPath, writeRecord }) => {
    await assert.rejects(() => loadSupersessions({ recordPath, migrationsDir: dir }), /Supersession record unreadable/);
    await fs.writeFile(recordPath, '{not json', 'utf8');
    await assert.rejects(() => loadSupersessions({ recordPath, migrationsDir: dir }), /Supersession record unreadable/);
    await fs.writeFile(recordPath, JSON.stringify({ supersessions: 'x' }), 'utf8');
    await assert.rejects(() => loadSupersessions({ recordPath, migrationsDir: dir }), /"supersessions" array/);
    void writeRecord;
  });
});

test('SUP-7: superseded-but-ledgered fails closed without mutation', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({
        applied: ['20000101000000_m1.sql', '20000101000001_m2.sql', '20000101000002_m3.sql'],
      });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        /SUPERSEDED_BUT_LEDGERED.*20000101000001_m2\.sql/,
      );
      assert.deepEqual(client.mutatingCalls, [], 'no DDL and no ledger writes');

      const checkClient = new FakeClient({ applied: client.applied });
      await assert.rejects(
        () =>
          applyMigrations({
            client: checkClient,
            migrationsDir: dir,
            supersessionRecordPath: recordPath,
            checkMode: true,
            logger: silent,
          }),
        /SUPERSEDED_BUT_LEDGERED/,
      );
    },
    { record: (entry) => [entry()] },
  );
});

test('SUP-8: undeclared historical hole still fails closed (no record configured)', async () => {
  await withFixture(async ({ dir }) => {
    const client = new FakeClient({ applied: LEDGER_M1_M3 });
    await assert.rejects(
      () => applyMigrations({ client, migrationsDir: dir, logger: silent }),
      /Unexpected historical migrations detected: 20000101000001_m2\.sql/,
    );
    assert.deepEqual(client.mutatingCalls, []);
  });
});

test('SUP-8b: a record declaring a different file does not exempt an undeclared hole', async () => {
  const files = {
    '20000101000000_m1.sql': 'select 1;',
    '20000101000001_hole.sql': 'select 2;',
    '20000101000002_m3.sql': 'select 3;',
    '20000101000003_declared.sql': 'select 4;',
  };
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: LEDGER_M1_M3 });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        /Unexpected historical migrations detected: 20000101000001_hole\.sql/,
      );
      assert.deepEqual(client.mutatingCalls, []);
    },
    {
      files,
      // Declares a different, unledgered file as superseded; the hole stays undeclared.
      record: (entry) => [
        entry({
          filename: '20000101000003_declared.sql',
          sha256: hashMigrationContent('select 4;'),
        }),
      ],
    },
  );
});

test('SUP-9: real hole next to a declared supersession still fails closed', async () => {
  const files = {
    '20000101000000_m1.sql': 'select 1;',
    '20000101000001_m2.sql': 'select 2;',
    '20000101000002_hole.sql': 'select 22;',
    '20000101000003_m3.sql': 'select 3;',
    '20000101000004_m4.sql': 'select 4;',
  };
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: ['20000101000000_m1.sql', '20000101000003_m3.sql'] });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        (err) => {
          assert.match(err.message, /Unexpected historical migrations detected: 20000101000002_hole\.sql/);
          assert.doesNotMatch(err.message, /m2\.sql/);
          return true;
        },
      );
      assert.deepEqual(client.mutatingCalls, []);
    },
    { files, record: (entry) => [entry({ supersededBy: ['20000101000003_m3.sql'] })] },
  );
});

test('SUP-10: check mode reports the validated exception and mutates nothing', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: LEDGER_M1_M3 });
      const lines = [];
      const result = await applyMigrations({
        client,
        migrationsDir: dir,
        supersessionRecordPath: recordPath,
        checkMode: true,
        logger: { log: (line) => lines.push(line) },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.superseded, ['20000101000001_m2.sql']);
      assert.deepEqual(client.mutatingCalls, [], 'no migration SQL, no ledger insert');
      const output = lines.join('\n');
      assert.match(output, /SUPERSEDED/);
      assert.match(output, /20000101000001_m2\.sql/);
      assert.match(output, /Pending: 1/);
      assert.match(output, /20000101000003_m4\.sql/);
    },
    { record: (entry) => [entry()] },
  );
});

test('superseded migration never executes or enters the ledger; later pending migration runs once', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: LEDGER_M1_M3 });
      const result = await applyMigrations({
        client,
        migrationsDir: dir,
        supersessionRecordPath: recordPath,
        logger: silent,
      });
      assert.equal(result.applied, 1);
      assert.equal(client.calls.filter((c) => c.sql === 'select 2;').length, 0, 'M2 SQL never runs');
      assert.equal(client.calls.filter((c) => c.sql === 'select 4;').length, 1, 'M4 SQL runs once');
      const inserts = client.calls.filter((c) => /insert into raf\.schema_migrations/i.test(c.sql));
      assert.deepEqual(inserts.map((c) => c.params[0]), ['20000101000003_m4.sql']);
    },
    { record: (entry) => [entry()] },
  );
});

test('superseded migration is not executed on explicit bootstrap of an empty ledger', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: [] });
      const result = await applyMigrations({
        client,
        migrationsDir: dir,
        supersessionRecordPath: recordPath,
        allowBootstrap: true,
        logger: silent,
      });
      assert.equal(result.applied, 3);
      assert.equal(client.calls.filter((c) => c.sql === 'select 2;').length, 0);
      const inserted = client.calls
        .filter((c) => /insert into raf\.schema_migrations/i.test(c.sql))
        .map((c) => c.params[0]);
      assert.deepEqual(inserted, [
        '20000101000000_m1.sql',
        '20000101000002_m3.sql',
        '20000101000003_m4.sql',
      ]);
    },
    { record: (entry) => [entry()] },
  );
});

test('empty ledger still fails closed without bootstrap even when a supersession is declared', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: [] });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        /Fresh database/,
      );
      assert.deepEqual(client.mutatingCalls, []);
    },
    { record: (entry) => [entry()] },
  );
});

test('LEDGER_ONLY still fails closed when a supersession is declared', async () => {
  await withFixture(
    async ({ dir, recordPath }) => {
      const client = new FakeClient({ applied: [...LEDGER_M1_M3, '20000101000099_phantom.sql'] });
      await assert.rejects(
        () => applyMigrations({ client, migrationsDir: dir, supersessionRecordPath: recordPath, logger: silent }),
        /Applied migration\(s\) are missing from db\/migrations: 20000101000099_phantom\.sql/,
      );
    },
    { record: (entry) => [entry()] },
  );
});

test('validateMigrationOrder excludes only the exact declared filenames', () => {
  const discovered = ['20000101000000_a.sql', '20000101000001_b.sql', '20000101000002_c.sql'];
  const applied = ['20000101000002_c.sql'];
  assert.deepEqual(
    validateMigrationOrder(discovered, applied, ['20000101000001_b.sql']).unexpectedHistorical,
    ['20000101000000_a.sql'],
  );
  assert.deepEqual(validateMigrationOrder(discovered, applied).unexpectedHistorical, [
    '20000101000000_a.sql',
    '20000101000001_b.sql',
  ]);
});

// ── Production supersession record ─────────────────────────────────────

test('closed set: production record contains exactly the 20260313170000 supersession', async () => {
  const record = JSON.parse(await fs.readFile(SUPERSESSION_RECORD_PATH, 'utf8'));
  // Adding a second exception requires changing this test and passing review.
  assert.deepEqual(
    record.supersessions.map((entry) => entry.filename),
    [SUPERSEDED_FILE],
  );
  const [entry] = record.supersessions;
  assert.equal(entry.expectedLedgerState, 'absent');
  assert.equal(entry.sha256, SUPERSEDED_FILE_SHA256);
  assert.deepEqual(entry.supersededBy, [
    '20260903090000_workspace_postgres_persistence.sql',
    '20260908000000_fix_income_entry_allocation_trigger.sql',
    '20260908020000_tighten_financial_rls_policies.sql',
    '20260909000000_create_raf_app_role.sql',
    '20260919000000_invitation_security_resolver.sql',
  ]);
});

test('production record validates against the real db/migrations and pins the historical file hash', async () => {
  const migrationsDir = path.resolve('db/migrations');
  const entries = await loadSupersessions({ migrationsDir });
  assert.equal(entries.length, 1);
  const actual = hashMigrationContent(await fs.readFile(path.join(migrationsDir, SUPERSEDED_FILE)));
  assert.equal(actual, SUPERSEDED_FILE_SHA256);
});

test('real repository check against the production-shaped ledger reports the superseded exception and no holes', async () => {
  const discovered = await discoverMigrations(path.resolve('db/migrations'));
  // Production ledger shape: every repository migration except the superseded one.
  const applied = discovered.filter((name) => name !== SUPERSEDED_FILE);
  const client = new FakeClient({ applied });
  const lines = [];
  const result = await applyMigrations({
    client,
    migrationsDir: path.resolve('db/migrations'),
    supersessionRecordPath: SUPERSESSION_RECORD_PATH,
    checkMode: true,
    logger: { log: (line) => lines.push(line) },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.superseded, [SUPERSEDED_FILE]);
  assert.deepEqual(client.mutatingCalls, []);
  assert.match(lines.join('\n'), /SUPERSEDED/);
  assert.match(lines.join('\n'), /Pending: 0/);

  // Without the record the same ledger is an UNEXPECTED_HISTORICAL hole (fail closed).
  const noRecord = await applyMigrations({
    client: new FakeClient({ applied }),
    migrationsDir: path.resolve('db/migrations'),
    checkMode: true,
    logger: silent,
  });
  assert.equal(noRecord.ok, false);
});

test('real repository: the superseded migration is present in the ledger => fail closed', async () => {
  const discovered = await discoverMigrations(path.resolve('db/migrations'));
  await assert.rejects(
    () =>
      applyMigrations({
        client: new FakeClient({ applied: discovered }),
        migrationsDir: path.resolve('db/migrations'),
        supersessionRecordPath: SUPERSESSION_RECORD_PATH,
        logger: silent,
      }),
    /SUPERSEDED_BUT_LEDGERED/,
  );
});
