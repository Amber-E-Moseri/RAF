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

// ── Phase 1 runtime-db security tests ────────────────────────────────────────

// ENV-1: postgres + RAF_AUTH_REQUIRED=true + owner URL present + app URL missing → THROW
test('ENV-1: postgres + auth required + app URL absent → throws (no owner fallback)', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    process.env.POSTGRES_CONNECTION_STRING = 'postgres://owner:secret@example.invalid/neondb';
    process.env.RAF_AUTH_REQUIRED = 'true';
    // POSTGRES_CONNECTION_STRING_APP intentionally absent

    assert.throws(
      () => loadServerEnv({ cwd }),
      /POSTGRES_CONNECTION_STRING_APP is required when PERSISTENCE_DRIVER=postgres and RAF_AUTH_REQUIRED=true/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));

// ENV-2: postgres + RAF_AUTH_REQUIRED=false + owner URL present + app URL missing → ALLOWED (dev fallback)
test('ENV-2: postgres + auth NOT required + app URL absent → owner fallback permitted', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    process.env.POSTGRES_CONNECTION_STRING = 'postgres://owner:secret@example.invalid/neondb';
    process.env.RAF_AUTH_REQUIRED = 'false';
    // POSTGRES_CONNECTION_STRING_APP intentionally absent

    const result = loadServerEnv({ cwd });
    // Falls back to the owner URL — acceptable for local dev
    assert.equal(result.persistenceDriver, 'postgres');
    assert.equal(result.postgresConnectionString, 'postgres://owner:secret@example.invalid/neondb');
    assert.equal(result.authRequired, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));

// ENV-3: postgres + RAF_AUTH_REQUIRED=true + owner URL present + app URL present → app URL selected
test('ENV-3: postgres + auth required + both URLs present → app URL selected', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    process.env.POSTGRES_CONNECTION_STRING = 'postgres://owner:secret@example.invalid/neondb';
    process.env.POSTGRES_CONNECTION_STRING_APP = 'postgres://raf_app:appsecret@example.invalid/neondb';
    process.env.RAF_AUTH_REQUIRED = 'true';

    const result = loadServerEnv({ cwd });
    assert.equal(result.persistenceDriver, 'postgres');
    assert.equal(result.postgresConnectionString, 'postgres://raf_app:appsecret@example.invalid/neondb');
    assert.equal(result.authRequired, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));

// ENV-4: postgres + RAF_AUTH_REQUIRED=true + app URL present but empty/whitespace → THROW
test('ENV-4: postgres + auth required + app URL whitespace-only → throws', () => withIsolatedEnv(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-env-'));
  try {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    process.env.POSTGRES_CONNECTION_STRING = 'postgres://owner:secret@example.invalid/neondb';
    process.env.POSTGRES_CONNECTION_STRING_APP = '   ';
    process.env.RAF_AUTH_REQUIRED = 'true';

    assert.throws(
      () => loadServerEnv({ cwd }),
      /POSTGRES_CONNECTION_STRING_APP is required when PERSISTENCE_DRIVER=postgres and RAF_AUTH_REQUIRED=true/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}));
