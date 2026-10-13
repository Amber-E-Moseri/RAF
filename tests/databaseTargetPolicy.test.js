import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertDatabaseTargetAllowed, parseDatabaseTarget } from '../lib/server/databaseTarget.js';
import { loadServerEnv } from '../lib/server/env.js';

const MIGRATE_SCRIPT = fileURLToPath(new URL('../scripts/migrate.js', import.meta.url));
const SECRET = 'S3cr3t-Pass-DO-NOT-LEAK';
const REMOTE_URL = `postgresql://owner_user:${SECRET}@ep-prod-example.neon.tech/rafdb?sslmode=require`;
const LOOPBACK_URL = 'postgresql://neondb_owner@127.0.0.1:54399/raf_test';

const AUTH_ENV = {
  RAF_DATABASE_REMOTE_AUTHORIZED: 'true',
  RAF_DATABASE_EXPECTED_HOST: 'ep-prod-example.neon.tech',
  RAF_DATABASE_EXPECTED_NAME: 'rafdb',
};

// ── Pure policy ──────────────────────────────────────────────────────────────

test('parseDatabaseTarget returns host and database and flags loopback', () => {
  assert.deepEqual(parseDatabaseTarget(LOOPBACK_URL), { host: '127.0.0.1', database: 'raf_test', loopback: true });
  assert.deepEqual(parseDatabaseTarget(REMOTE_URL), { host: 'ep-prod-example.neon.tech', database: 'rafdb', loopback: false });
});

test('invalid connection string is refused without echoing its contents', () => {
  const bad = `not a url ${SECRET}`;
  assert.throws(
    () => parseDatabaseTarget(bad),
    (err) => err.message.includes('not a valid URL') && !err.message.includes(SECRET),
  );
});

for (const url of [
  'postgresql://u@localhost:5432/db',
  'postgresql://u@127.0.0.1:5432/db',
  'postgresql://u@[::1]:5432/db',
]) {
  test(`loopback target is allowed without authorization: ${url.split('@')[1]}`, () => {
    const target = assertDatabaseTargetAllowed({ connectionString: url, label: 'X', source: 'file', env: {} });
    assert.equal(target.loopback, true);
  });
}

test('remote target from a .env file is refused even when authorization is present', () => {
  assert.throws(
    () => assertDatabaseTargetAllowed({ connectionString: REMOTE_URL, label: 'POSTGRES_CONNECTION_STRING', source: 'file', env: AUTH_ENV }),
    (err) => /from \.env/.test(err.message) && err.message.includes('ep-prod-example.neon.tech') && !err.message.includes(SECRET),
  );
});

test('remote target in the process environment without authorization is refused', () => {
  assert.throws(
    () => assertDatabaseTargetAllowed({ connectionString: REMOTE_URL, label: 'POSTGRES_CONNECTION_STRING', source: 'process', env: {} }),
    (err) => /RAF_DATABASE_REMOTE_AUTHORIZED/.test(err.message) && !err.message.includes(SECRET),
  );
});

test('authorization must be exactly "true"', () => {
  for (const value of ['True', '1', 'yes', '']) {
    assert.throws(() => assertDatabaseTargetAllowed({
      connectionString: REMOTE_URL,
      label: 'X',
      source: 'process',
      env: { ...AUTH_ENV, RAF_DATABASE_REMOTE_AUTHORIZED: value },
    }), /RAF_DATABASE_REMOTE_AUTHORIZED/, `value ${JSON.stringify(value)} must not authorize`);
  }
});

test('authorized remote target with matching host and database is allowed', () => {
  const target = assertDatabaseTargetAllowed({ connectionString: REMOTE_URL, label: 'X', source: 'process', env: AUTH_ENV });
  assert.equal(target.host, 'ep-prod-example.neon.tech');
  assert.equal(target.database, 'rafdb');
});

test('authorized remote target is refused when host or database does not match', () => {
  assert.throws(() => assertDatabaseTargetAllowed({
    connectionString: REMOTE_URL, label: 'X', source: 'process',
    env: { ...AUTH_ENV, RAF_DATABASE_EXPECTED_HOST: 'ep-other.neon.tech' },
  }), /does not match/);
  assert.throws(() => assertDatabaseTargetAllowed({
    connectionString: REMOTE_URL, label: 'X', source: 'process',
    env: { ...AUTH_ENV, RAF_DATABASE_EXPECTED_NAME: 'otherdb' },
  }), /does not match/);
});

test('authorized remote target without expected host and name is refused', () => {
  assert.throws(() => assertDatabaseTargetAllowed({
    connectionString: REMOTE_URL, label: 'X', source: 'process',
    env: { RAF_DATABASE_REMOTE_AUTHORIZED: 'true' },
  }), /EXPECTED_HOST and RAF_DATABASE_EXPECTED_NAME are required/);
});

// ── Migration runner (spawned, environment fully controlled) ─────────────────

function runMigrate({ args = [], env = {}, cwd }) {
  // Minimal environment: nothing inherited from the developer shell or repo .env.
  const base = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    HOME: process.env.HOME ?? '',
  };
  const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, ...args], {
    env: { ...base, ...env },
    cwd: cwd ?? os.tmpdir(),
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('migrate fails closed with no connection string and never reads .env', () => {
  const { status, output } = runMigrate({});
  assert.equal(status, 1);
  assert.match(output, /POSTGRES_CONNECTION_STRING not set/);
});

test('migrate refuses an unauthorized remote target before connecting, without leaking the password', () => {
  const { status, output } = runMigrate({ env: { POSTGRES_CONNECTION_STRING: REMOTE_URL } });
  assert.equal(status, 1);
  assert.match(output, /Refusing remote database target/);
  assert.match(output, /ep-prod-example\.neon\.tech/);
  assert.equal(output.includes(SECRET), false, 'password must never be printed');
  assert.equal(output.includes('Connected to Postgres'), false);
});

test('migrate refuses bootstrap against a remote target even when authorized', () => {
  const { status, output } = runMigrate({
    args: ['--bootstrap'],
    env: { POSTGRES_CONNECTION_STRING: REMOTE_URL, ...AUTH_ENV },
  });
  assert.equal(status, 1);
  assert.match(output, /bootstrap is refused for remote database targets/);
  assert.equal(output.includes(SECRET), false);
});

test('migrate proceeds past target validation for an authorized matching remote target', () => {
  // The target is authorized; it will then try to connect to a host that does not resolve.
  // The test only asserts that the guard did not refuse it.
  const { output } = runMigrate({
    env: { POSTGRES_CONNECTION_STRING: REMOTE_URL.replace('ep-prod-example.neon.tech', 'ep-prod-example.neon.tech.invalid'), RAF_DATABASE_REMOTE_AUTHORIZED: 'true', RAF_DATABASE_EXPECTED_HOST: 'ep-prod-example.neon.tech.invalid', RAF_DATABASE_EXPECTED_NAME: 'rafdb' },
  });
  assert.doesNotMatch(output, /Refusing remote database target/);
  assert.match(output, /Migration target: host=ep-prod-example\.neon\.tech\.invalid database=rafdb/);
});

test('migrate reaches the connection step for a loopback target without authorization', () => {
  const { status, output } = runMigrate({ env: { POSTGRES_CONNECTION_STRING: LOOPBACK_URL } });
  assert.equal(status, 1);
  assert.doesNotMatch(output, /Refusing/);
  assert.match(output, /Migration target: host=127\.0.0\.1 database=raf_test/);
});

// ── Server loader ────────────────────────────────────────────────────────────

function withEnv(overrides, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: saved.PATH ?? '', SYSTEMROOT: saved.SYSTEMROOT ?? '', ...overrides });
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('server loader refuses a remote target supplied only by a local .env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-envpolicy-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), `POSTGRES_CONNECTION_STRING=${REMOTE_URL}\n`);
    withEnv({ PERSISTENCE_DRIVER: 'postgres' }, () => {
      assert.throws(
        () => loadServerEnv({ cwd: dir }),
        (err) => /Refusing remote database target from \.env/.test(err.message) && !err.message.includes(SECRET),
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server loader accepts an authorized remote target from the process environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-envpolicy-'));
  try {
    withEnv({
      PERSISTENCE_DRIVER: 'postgres',
      POSTGRES_CONNECTION_STRING: REMOTE_URL,
      ...AUTH_ENV,
    }, () => {
      assert.doesNotThrow(() => loadServerEnv({ cwd: dir }));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a .env file cannot grant remote authorization for a process-env connection string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-envpolicy-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), [
      'RAF_DATABASE_REMOTE_AUTHORIZED=true',
      'RAF_DATABASE_EXPECTED_HOST=ep-prod-example.neon.tech',
      'RAF_DATABASE_EXPECTED_NAME=rafdb',
      '',
    ].join('\n'));
    withEnv({ PERSISTENCE_DRIVER: 'postgres', POSTGRES_CONNECTION_STRING: REMOTE_URL }, () => {
      assert.throws(
        () => loadServerEnv({ cwd: dir }),
        (err) => /RAF_DATABASE_REMOTE_AUTHORIZED/.test(err.message) && !err.message.includes(SECRET),
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
