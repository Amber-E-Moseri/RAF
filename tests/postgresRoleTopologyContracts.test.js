/**
 * C-P1.3 / C-P1.6 — Disposable role topology contracts.
 *
 * Proves the raf_app role cannot escalate privileges in the disposable
 * PostgreSQL environment, mirroring the production security posture.
 *
 * Tests:
 *   1. raf_app role flags: NOSUPERUSER NOBYPASSRLS NOCREATEROLE
 *   2. raf_app cannot SET ROLE neondb_owner (negative escalation assertion)
 *
 * Gate conditions:
 *   DATABASE_URL                   — privileged connection (for flag inspection)
 *   POSTGRES_CONNECTION_STRING_APP — raf_app connection (for escalation attempt)
 *   RAF_RUN_POSTGRES_RLS_TESTS     — must be 'true'
 *   RAF_CONFIRM_NON_PRODUCTION_DB  — must be 'true'
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const adminUrl = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const appUrl   = process.env.POSTGRES_CONNECTION_STRING_APP;
const rlsEnabled = process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true';
const nonProd    = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const shouldRun = Boolean(adminUrl && appUrl && rlsEnabled && nonProd);
const maybeTest = shouldRun ? test : test.skip;

const sslOption = process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
  ? false
  : { rejectUnauthorized: false };

maybeTest('C-P1.6: raf_app is NOSUPERUSER NOBYPASSRLS NOCREATEROLE', async () => {
  const pool = new Pool({ connectionString: adminUrl, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
       FROM pg_roles WHERE rolname = 'raf_app'`,
    );

    assert.ok(rows.length === 1,
      'raf_app role must exist in pg_roles');

    const { rolname, rolsuper, rolbypassrls, rolcreaterole } = rows[0];
    assert.equal(rolname, 'raf_app',
      'Role name must be raf_app');
    assert.equal(rolsuper, false,
      'raf_app must be NOSUPERUSER');
    assert.equal(rolbypassrls, false,
      'raf_app must be NOBYPASSRLS — RLS enforcement depends on this');
    assert.equal(rolcreaterole, false,
      'raf_app must be NOCREATEROLE');
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('C-P1.3: raf_app cannot SET ROLE neondb_owner (escalation denial)', async () => {
  const pool = new Pool({ connectionString: appUrl, ssl: sslOption });
  const client = await pool.connect();
  let escalationError = null;

  try {
    await client.query('BEGIN');
    try {
      await client.query('SET ROLE neondb_owner');
    } catch (err) {
      escalationError = err;
      await client.query('ROLLBACK').catch(() => {});
    }

    if (!escalationError) {
      // SET ROLE succeeded — immediately undo and fail the test
      await client.query('RESET ROLE');
      await client.query('ROLLBACK').catch(() => {});
      assert.fail(
        'raf_app was able to SET ROLE neondb_owner — privilege escalation is possible. ' +
        'This must never be allowed in the RAF security model.',
      );
    }

    assert.ok(
      escalationError.code === '42501' ||
      /permission denied|must be member/i.test(escalationError.message),
      `Expected "permission denied" or code 42501; got code="${escalationError.code}" message="${escalationError.message}"`,
    );
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('C-P1.6: current_user in raf_app connection is raf_app', async () => {
  const pool = new Pool({ connectionString: appUrl, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query('SELECT current_user AS cu');
    assert.equal(rows[0].cu, 'raf_app',
      `Expected current_user = raf_app; got "${rows[0].cu}"`);
  } finally {
    client.release();
    await pool.end();
  }
});
