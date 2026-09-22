/**
 * C-P1.7 — Invitation resolver security catalog proof.
 *
 * Proves, against a live disposable PostgreSQL instance, that the three
 * SECURITY DEFINER invitation resolver functions created by migration
 * 20260919000000_invitation_security_resolver.sql have the correct
 * security properties in pg_proc after a fresh bootstrap.
 *
 * Functions verified:
 *   raf.resolve_invitation_by_token(text)
 *   raf.accept_workspace_invitation(text, uuid, text)
 *   raf.decline_workspace_invitation(text)
 *
 * Properties asserted per function:
 *   - SECURITY DEFINER (prosecdef = true)
 *   - Restricted search_path (proconfig contains 'search_path=raf')
 *   - owner is neondb_owner (proowner → pg_roles.rolname)
 *   - PUBLIC EXECUTE revoked (proacl does not contain bare '=X/' grantee)
 *   - raf_app EXECUTE granted (proacl contains 'raf_app=X/')
 *
 * Gate conditions:
 *   DATABASE_URL                   — privileged connection (neondb_owner)
 *   RAF_RUN_POSTGRES_RLS_TESTS     — must be 'true'
 *   RAF_CONFIRM_NON_PRODUCTION_DB  — must be 'true'
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const shouldRun = Boolean(connectionString)
  && process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true'
  && process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const maybeTest = shouldRun ? test : test.skip;

const sslOption = process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
  ? false
  : { rejectUnauthorized: false };

const RESOLVER_FUNCTIONS = [
  'resolve_invitation_by_token',
  'accept_workspace_invitation',
  'decline_workspace_invitation',
];

maybeTest('C-P1.7: invitation resolver functions exist after fresh migration', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'raf'
        AND p.proname = ANY($1::text[])
    `, [RESOLVER_FUNCTIONS]);

    const found = new Set(rows.map((r) => r.proname));
    for (const fn of RESOLVER_FUNCTIONS) {
      assert.ok(found.has(fn),
        `Function raf.${fn} must exist in pg_proc after fresh migration`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('C-P1.7: all three resolver functions are SECURITY DEFINER', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT p.proname, p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'raf'
        AND p.proname = ANY($1::text[])
    `, [RESOLVER_FUNCTIONS]);

    const byName = new Map(rows.map((r) => [r.proname, r]));
    for (const fn of RESOLVER_FUNCTIONS) {
      const row = byName.get(fn);
      assert.ok(row, `raf.${fn} not found in pg_proc`);
      assert.equal(row.prosecdef, true,
        `raf.${fn} must be SECURITY DEFINER (prosecdef=true)`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('C-P1.7: all three resolver functions have hardened search_path', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'raf'
        AND p.proname = ANY($1::text[])
    `, [RESOLVER_FUNCTIONS]);

    const byName = new Map(rows.map((r) => [r.proname, r]));
    for (const fn of RESOLVER_FUNCTIONS) {
      const row = byName.get(fn);
      assert.ok(row, `raf.${fn} not found`);
      const configStr = (row.proconfig ?? []).join(',');
      assert.ok(
        configStr.includes('search_path=raf') || configStr.includes('search_path = raf'),
        `raf.${fn} must have SET search_path=raf in proconfig; got: ${configStr}`,
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('C-P1.7: all three resolver functions are owned by neondb_owner', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT p.proname, r.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'raf'
        AND p.proname = ANY($1::text[])
    `, [RESOLVER_FUNCTIONS]);

    const byName = new Map(rows.map((r) => [r.proname, r]));
    for (const fn of RESOLVER_FUNCTIONS) {
      const row = byName.get(fn);
      assert.ok(row, `raf.${fn} not found`);
      assert.equal(row.owner, 'neondb_owner',
        `raf.${fn} must be owned by neondb_owner; got "${row.owner}"`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('C-P1.7: PUBLIC EXECUTE revoked and raf_app EXECUTE granted on all resolver functions', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT p.proname, array_to_string(p.proacl, ',') AS acl_str
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'raf'
        AND p.proname = ANY($1::text[])
    `, [RESOLVER_FUNCTIONS]);

    const byName = new Map(rows.map((r) => [r.proname, r]));
    for (const fn of RESOLVER_FUNCTIONS) {
      const row = byName.get(fn);
      assert.ok(row, `raf.${fn} not found`);
      const acl = row.acl_str ?? '';

      // PUBLIC must not have EXECUTE: public grantee appears as '{=X/' or ',=X/'
      const publicHasExecute = acl.startsWith('{=X/') || acl.includes(',=X/');
      assert.equal(publicHasExecute, false,
        `raf.${fn}: PUBLIC must NOT have EXECUTE (proacl: "${acl}")`);

      // raf_app must have EXECUTE
      assert.ok(acl.includes('raf_app=X/'),
        `raf.${fn}: raf_app must have EXECUTE privilege (proacl: "${acl}")`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});
