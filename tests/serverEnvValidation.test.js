import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadServerEnv } from '../lib/server/env.js';
import {
  assertIsolatedSqliteEnvResolvesToSqlite,
  startIsolatedSqliteServer,
} from './helpers/isolatedSqliteServer.js';

const OS_CRITICAL = new Set([
  'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'HOMEPATH', 'HOMEDRIVE',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir',
  'SYSTEMDRIVE', 'SystemDrive',
  'PATH', 'Path', 'COMSPEC', 'ComSpec',
]);

function withIsolatedEnv(run) {
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (!OS_CRITICAL.has(key)) {
        delete process.env[key];
      }
    }
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!OS_CRITICAL.has(key)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
  }
}

test('loadServerEnv fails clearly when RAF_DB_PATH is missing', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    assert.throws(
      () => loadServerEnv({ cwd }),
      /Invalid server environment configuration[\s\S]*RAF_DB_PATH/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));

test('loadServerEnv parses .env and validates PORT range', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    fs.writeFileSync(path.join(cwd, '.env'), 'RAF_DB_PATH=./db/test.sqlite\nPORT=abc\n', 'utf8');
    assert.throws(
      () => loadServerEnv({ cwd }),
      /PORT must be an integer from 1 to 65535/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));

test('explicit SQLite test env wins when .env requests Postgres', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    const dbPath = path.join(cwd, 'test.sqlite');
    fs.writeFileSync(
      path.join(cwd, '.env'),
      [
        'PERSISTENCE_DRIVER=postgres',
        'POSTGRES_CONNECTION_STRING=postgres://example.invalid/neon',
        'POSTGRES_CONNECTION_STRING_APP=postgres://example.invalid/neon_app',
        'DATABASE_URL=postgres://example.invalid/admin',
        '',
      ].join('\n'),
      'utf8',
    );

    const resolved = assertIsolatedSqliteEnvResolvesToSqlite({
      cwd,
      env: {
        ...process.env,
        PERSISTENCE_DRIVER: 'sqlite',
        RAF_DB_PATH: dbPath,
        POSTGRES_CONNECTION_STRING: '',
        POSTGRES_CONNECTION_STRING_APP: '',
        DATABASE_URL: '',
        SUPABASE_DATABASE_URL: '',
      },
    });

    assert.equal(resolved.persistenceDriver, 'sqlite');
    assert.equal(Boolean(resolved.postgresConnectionString), false);
    assert.equal(resolved.dbPath, dbPath);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));

test('isolated SQLite server helper fails before startup when Postgres is requested', async () => {
  await assert.rejects(
    () => startIsolatedSqliteServer({
      repoRoot: path.resolve(process.cwd()),
      testName: 'raf-bad-isolated-env',
      extraEnv: {
        PERSISTENCE_DRIVER: 'postgres',
        POSTGRES_CONNECTION_STRING: 'postgres://example.invalid/neon',
      },
    }),
    /isolated helper requires PERSISTENCE_DRIVER=sqlite/,
  );
});
