/**
 * Phase 1 runtime role startup security contracts.
 *
 * Proves that checkRuntimeRolePrivileges:
 *   - ACCEPTS a connection that uses the raf_app role (NOSUPERUSER NOBYPASSRLS NOCREATEROLE)
 *   - REJECTS a connection that uses the owner role (has BYPASSRLS, CREATEROLE)
 *   - Considers CREATEROLE as a standalone dangerous condition (Phase 1G)
 *
 * Also proves the startup connection-string selection contract (Phase 1H):
 *   - CASE A: production-style Postgres, app URL missing → REJECTED at loadServerEnv
 *   - CASE B: production-style Postgres, owner role as app URL → REJECTED at checkRuntimeRolePrivileges
 *   - CASE C: production-style Postgres, legitimate raf_app URL → ACCEPTED
 *
 * Gate conditions (same as postgresRoleTopologyContracts.test.js):
 *   DATABASE_URL                   — owner/admin connection
 *   POSTGRES_CONNECTION_STRING_APP — raf_app connection
 *   RAF_RUN_POSTGRES_RLS_TESTS     — must be 'true'
 *   RAF_CONFIRM_NON_PRODUCTION_DB  — must be 'true'
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadServerEnv, checkRuntimeRolePrivileges } from '../lib/server/env.js';

const ownerUrl  = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const appUrl    = process.env.POSTGRES_CONNECTION_STRING_APP;
const rlsEnabled = process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true';
const nonProd    = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const shouldRun = Boolean(ownerUrl && appUrl && rlsEnabled && nonProd);
const maybeTest = shouldRun ? test : test.skip;

// ── ROLE-A: raf_app URL → checkRuntimeRolePrivileges(authRequired=true) ACCEPTS ──

maybeTest('ROLE-A: checkRuntimeRolePrivileges accepts raf_app connection (authRequired=true)', async () => {
  // Must not throw — raf_app has no dangerous privileges
  await assert.doesNotReject(
    () => checkRuntimeRolePrivileges({
      postgresConnectionString: appUrl,
      authRequired: true,
    }),
    'checkRuntimeRolePrivileges should accept a raf_app role in production mode',
  );
});

// ── ROLE-B: owner URL supplied as app URL → REJECTED ──────────────────────────

maybeTest('ROLE-B: checkRuntimeRolePrivileges rejects owner role as app connection (authRequired=true)', async () => {
  // Must throw — neondb_owner has BYPASSRLS + CREATEROLE
  await assert.rejects(
    () => checkRuntimeRolePrivileges({
      postgresConnectionString: ownerUrl,
      authRequired: true,
    }),
    /BYPASSRLS|CREATEROLE|SUPERUSER/,
    'checkRuntimeRolePrivileges must reject the owner role even when supplied as the app connection string',
  );
});

// ── Phase 1G: CREATEROLE alone is dangerous ───────────────────────────────────

maybeTest('Phase 1G: CREATEROLE flag causes rejection regardless of BYPASSRLS', async () => {
  // neondb_owner has both BYPASSRLS and CREATEROLE.
  // Verify the rejection message names CREATEROLE.
  let caught = null;
  try {
    await checkRuntimeRolePrivileges({
      postgresConnectionString: ownerUrl,
      authRequired: true,
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught !== null, 'checkRuntimeRolePrivileges must throw for owner role');
  assert.ok(
    /CREATEROLE/.test(caught.message),
    `Expected error message to mention CREATEROLE; got: "${caught.message}"`,
  );
});

// ── Phase 1H startup contract ─────────────────────────────────────────────────

// CASE A: production postgres + app URL absent → loadServerEnv THROWS
test('CASE A: production postgres + app URL missing → startup REJECTED', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-startup-'));
  const saved = { ...process.env };
  try {
    // Clear all non-critical env to isolate
    for (const key of Object.keys(process.env)) {
      if (!['TEMP','TMP','TMPDIR','USERPROFILE','HOME','HOMEPATH','HOMEDRIVE',
             'SYSTEMROOT','SystemRoot','WINDIR','windir','SYSTEMDRIVE','SystemDrive',
             'PATH','Path','COMSPEC','ComSpec'].includes(key)) {
        delete process.env[key];
      }
    }
    process.env.PERSISTENCE_DRIVER = 'postgres';
    process.env.POSTGRES_CONNECTION_STRING = ownerUrl;
    process.env.RAF_AUTH_REQUIRED = 'true';
    // No POSTGRES_CONNECTION_STRING_APP

    assert.throws(
      () => loadServerEnv({ cwd }),
      /POSTGRES_CONNECTION_STRING_APP is required when PERSISTENCE_DRIVER=postgres and RAF_AUTH_REQUIRED=true/,
      'CASE A: loadServerEnv must throw when app URL is absent in production mode',
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!['TEMP','TMP','TMPDIR','USERPROFILE','HOME','HOMEPATH','HOMEDRIVE',
             'SYSTEMROOT','SystemRoot','WINDIR','windir','SYSTEMDRIVE','SystemDrive',
             'PATH','Path','COMSPEC','ComSpec'].includes(key)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// CASE B: production postgres + owner role as app URL → checkRuntimeRolePrivileges THROWS
maybeTest('CASE B: production postgres + owner supplied as app URL → startup REJECTED by role check', async () => {
  await assert.rejects(
    () => checkRuntimeRolePrivileges({
      postgresConnectionString: ownerUrl,
      authRequired: true,
    }),
    /BYPASSRLS|CREATEROLE|SUPERUSER/,
    'CASE B: owner-as-app must be rejected by privilege check',
  );
});

// CASE C: production postgres + legitimate raf_app URL → ACCEPTED
maybeTest('CASE C: production postgres + raf_app URL → startup ACCEPTED', async () => {
  await assert.doesNotReject(
    () => checkRuntimeRolePrivileges({
      postgresConnectionString: appUrl,
      authRequired: true,
    }),
    'CASE C: raf_app role must be accepted',
  );
});
