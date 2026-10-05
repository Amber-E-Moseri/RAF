/**
 * TC-AUD-005 — Proves the import_batch file_hash partial unique index
 * enforces idempotency at the PostgreSQL layer.
 *
 * Index: idx_import_batches_workspace_file_hash
 *   UNIQUE (workspace_id, file_hash) WHERE file_hash IS NOT NULL
 *
 * Gate conditions:
 *   DATABASE_URL                   — privileged connection (neondb_owner)
 *   RAF_RUN_POSTGRES_RLS_TESTS     — must be 'true'
 *   RAF_CONFIRM_NON_PRODUCTION_DB  — must be 'true'
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import crypto from 'node:crypto';

const connectionString = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const shouldRun = Boolean(connectionString)
  && process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true'
  && process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const maybeTest = shouldRun ? test : test.skip;

const sslOption = process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
  ? false
  : { rejectUnauthorized: false };

function uuid() { return crypto.randomUUID(); }
function sha256hex() { return crypto.randomBytes(32).toString('hex'); }

maybeTest('TC-AUD-005: duplicate file_hash in same workspace is rejected (UNIQUE violation, code 23505)', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();
  const wsId = uuid();
  const ownerId = uuid();
  const fileHash = sha256hex();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO raf.app_users (id, email, password_hash)
       VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
      [ownerId, `file-hash-${wsId}@test.test`],
    );
    await client.query(
      `INSERT INTO raf.workspaces (id, name, owner_user_id)
       VALUES ($1, 'FileHashTestWS', $2) ON CONFLICT DO NOTHING`,
      [wsId, ownerId],
    );

    // First insert — must succeed
    await client.query(
      `INSERT INTO raf.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', now(), now())`,
      [uuid(), wsId, fileHash],
    );

    // Second insert — same workspace_id + file_hash — must be rejected
    let uniqueViolation = null;
    await client.query('SAVEPOINT before_duplicate');
    try {
      await client.query(
        `INSERT INTO raf.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, '{}', now(), now())`,
        [uuid(), wsId, fileHash],
      );
    } catch (err) {
      uniqueViolation = err;
      await client.query('ROLLBACK TO SAVEPOINT before_duplicate');
    }
    await client.query('RELEASE SAVEPOINT before_duplicate');

    assert.ok(uniqueViolation,
      'Duplicate file_hash in same workspace must raise an error');
    assert.equal(uniqueViolation.code, '23505',
      `Expected UNIQUE violation (23505); got "${uniqueViolation.code}": ${uniqueViolation.message}`);
    assert.ok(
      uniqueViolation.constraint?.includes('idx_import_batches_workspace_file_hash'),
      `Expected constraint idx_import_batches_workspace_file_hash; got "${uniqueViolation.constraint}"`,
    );

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('TC-AUD-005: same file_hash in different workspaces is allowed (partial index is workspace-scoped)', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();
  const wsA = uuid(); const ownerA = uuid();
  const wsB = uuid(); const ownerB = uuid();
  const sharedHash = sha256hex();

  try {
    await client.query('BEGIN');

    for (const [ws, owner, email] of [
      [wsA, ownerA, `hash-ws-a-${wsA}@test.test`],
      [wsB, ownerB, `hash-ws-b-${wsB}@test.test`],
    ]) {
      await client.query(
        `INSERT INTO raf.app_users (id, email, password_hash) VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
        [owner, email],
      );
      await client.query(
        `INSERT INTO raf.workspaces (id, name, owner_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [ws, `WS ${ws}`, owner],
      );
    }

    // Insert same hash into workspace A
    await client.query(
      `INSERT INTO raf.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', now(), now())`,
      [uuid(), wsA, sharedHash],
    );

    // Insert same hash into workspace B — must succeed (different workspace)
    await client.query(
      `INSERT INTO raf.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', now(), now())`,
      [uuid(), wsB, sharedHash],
    );

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('TC-AUD-005: NULL file_hash allows multiple rows per workspace (WHERE IS NOT NULL partial index)', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();
  const wsId = uuid();
  const ownerId = uuid();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO raf.app_users (id, email, password_hash) VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
      [ownerId, `null-hash-${wsId}@test.test`],
    );
    await client.query(
      `INSERT INTO raf.workspaces (id, name, owner_user_id) VALUES ($1, 'NullHashWS', $2) ON CONFLICT DO NOTHING`,
      [wsId, ownerId],
    );

    // Two rows with NULL file_hash in the same workspace — both must succeed
    await client.query(
      `INSERT INTO raf.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
       VALUES ($1, $2, NULL, '{}', now(), now())`,
      [uuid(), wsId],
    );
    await client.query(
      `INSERT INTO raf.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
       VALUES ($1, $2, NULL, '{}', now(), now())`,
      [uuid(), wsId],
    );

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

// =========================================================================
// TC-AUD-005-APP — Idempotency through raf_app runtime role
// =========================================================================
//
// Verify the file-hash idempotency guard operates correctly through the
// actual raf_app runtime connection with RLS enforcement active.

const appConnectionString = process.env.POSTGRES_CONNECTION_STRING_APP;
const shouldRunAppTests = Boolean(appConnectionString)
  && Boolean(connectionString)
  && process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true'
  && process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const maybeAppTest = shouldRunAppTests ? test : test.skip;

/**
 * Run a query inside a transaction with raf_app's workspace context set.
 */
async function asRafAppInWorkspace(client, workspaceId, callback) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('raf.workspace_id', $1, true)", [workspaceId]);
  try {
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

maybeAppTest('TC-AUD-005-APP: raf_app role is correctly configured (not superuser, not BYPASSRLS)', async () => {
  const appPool = new Pool({ connectionString: appConnectionString, ssl: sslOption });
  const appClient = await appPool.connect();

  try {
    // Prove raf_app is the current user
    const userResult = await appClient.query('SELECT current_user');
    assert.equal(
      userResult.rows[0].current_user,
      'raf_app',
      'Expected current_user to be raf_app',
    );

    // Verify raf_app is not a superuser
    const superResult = await appClient.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raf_app'`,
    );
    assert.ok(superResult.rows[0], 'raf_app role not found');
    assert.equal(
      superResult.rows[0].rolsuper,
      false,
      'raf_app must not be a superuser',
    );
    assert.equal(
      superResult.rows[0].rolbypassrls,
      false,
      'raf_app must not have BYPASSRLS',
    );
  } finally {
    appClient.release();
    await appPool.end();
  }
});

maybeAppTest('TC-AUD-005-APP: file_hash idempotency enforced through raf_app (same workspace)', async () => {
  const adminPool = new Pool({ connectionString, ssl: sslOption });
  const appPool = new Pool({ connectionString: appConnectionString, ssl: sslOption });

  const wsId = uuid();
  const ownerId = uuid();
  const fileHash = sha256hex();

  try {
    // Setup: create workspace and owner as admin (BYPASSRLS)
    const adminClient = await adminPool.connect();
    await adminClient.query('BEGIN');
    await adminClient.query(
      `INSERT INTO raf.app_users (id, email, password_hash)
       VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
      [ownerId, `app-test-${wsId}@test.test`],
    );
    await adminClient.query(
      `INSERT INTO raf.workspaces (id, name, owner_user_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [wsId, `AppTest-${wsId}`, ownerId],
    );
    await adminClient.query('COMMIT');
    adminClient.release();

    // Test through raf_app: first insert must succeed
    const appClient = await appPool.connect();
    let firstInsertId;
    try {
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('raf.workspace_id', $1, true)", [wsId]);

      const insertResult = await appClient.query(
        `INSERT INTO raf.import_batches
         (id, workspace_id, file_hash, source, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, 'test', '{}', now(), now())
         RETURNING id`,
        [firstInsertId = uuid(), wsId, fileHash],
      );
      assert.ok(insertResult.rows[0], 'First insert must succeed');
      await appClient.query('COMMIT');
    } catch (err) {
      await appClient.query('ROLLBACK');
      throw err;
    }

    // Test through raf_app: duplicate insert must fail with 23505
    let duplicateError = null;
    try {
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('raf.workspace_id', $1, true)", [wsId]);
      await appClient.query('SAVEPOINT before_dup');

      try {
        await appClient.query(
          `INSERT INTO raf.import_batches
           (id, workspace_id, file_hash, source, raw_json, created_at, updated_at)
           VALUES ($1, $2, $3, 'test', '{}', now(), now())`,
          [uuid(), wsId, fileHash],
        );
      } catch (err) {
        duplicateError = err;
        await appClient.query('ROLLBACK TO SAVEPOINT before_dup');
      }
      await appClient.query('RELEASE SAVEPOINT before_dup');
      await appClient.query('COMMIT');
    } catch (err) {
      await appClient.query('ROLLBACK');
      if (err === duplicateError) throw err;
      throw new Error(`Unexpected error: ${err.message}`);
    }

    assert.ok(duplicateError, 'Duplicate insert must raise an error');
    assert.equal(duplicateError.code, '23505', `Expected UNIQUE violation (23505), got ${duplicateError.code}`);
    assert.ok(
      duplicateError.constraint?.includes('idx_import_batches_workspace_file_hash'),
      `Expected constraint idx_import_batches_workspace_file_hash, got ${duplicateError.constraint}`,
    );

    appClient.release();
  } finally {
    // Cleanup
    const adminClient = await adminPool.connect();
    await adminClient.query(
      `DELETE FROM raf.workspaces WHERE id = $1`,
      [wsId],
    );
    adminClient.release();
    await adminPool.end();
    await appPool.end();
  }
});

maybeAppTest('TC-AUD-005-APP: file_hash uniqueness is scoped to workspace (cross-workspace isolation)', async () => {
  const adminPool = new Pool({ connectionString, ssl: sslOption });
  const appPool = new Pool({ connectionString: appConnectionString, ssl: sslOption });

  const wsA = uuid(); const ownerA = uuid();
  const wsB = uuid(); const ownerB = uuid();
  const sharedHash = sha256hex();

  try {
    // Setup: create two workspaces
    const adminClient = await adminPool.connect();
    await adminClient.query('BEGIN');

    for (const [ws, owner, email] of [
      [wsA, ownerA, `app-wsA-${wsA}@test.test`],
      [wsB, ownerB, `app-wsB-${wsB}@test.test`],
    ]) {
      await adminClient.query(
        `INSERT INTO raf.app_users (id, email, password_hash)
         VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
        [owner, email],
      );
      await adminClient.query(
        `INSERT INTO raf.workspaces (id, name, owner_user_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [ws, `AppWS-${ws}`, owner],
      );
    }
    await adminClient.query('COMMIT');
    adminClient.release();

    // Insert into workspace A through raf_app
    const appClientA = await appPool.connect();
    await appClientA.query('BEGIN');
    await appClientA.query("SELECT set_config('raf.workspace_id', $1, true)", [wsA]);
    await appClientA.query(
      `INSERT INTO raf.import_batches
       (id, workspace_id, file_hash, source, raw_json, created_at, updated_at)
       VALUES ($1, $2, $3, 'test', '{}', now(), now())`,
      [uuid(), wsA, sharedHash],
    );
    await appClientA.query('COMMIT');
    appClientA.release();

    // Insert same hash into workspace B through raf_app — must succeed
    const appClientB = await appPool.connect();
    await appClientB.query('BEGIN');
    await appClientB.query("SELECT set_config('raf.workspace_id', $1, true)", [wsB]);
    const insertB = await appClientB.query(
      `INSERT INTO raf.import_batches
       (id, workspace_id, file_hash, source, raw_json, created_at, updated_at)
       VALUES ($1, $2, $3, 'test', '{}', now(), now())
       RETURNING id`,
      [uuid(), wsB, sharedHash],
    );
    await appClientB.query('COMMIT');
    appClientB.release();

    assert.ok(insertB.rows[0], 'Insert into workspace B with same hash must succeed');
  } finally {
    // Cleanup
    const adminClient = await adminPool.connect();
    await adminClient.query(
      `DELETE FROM raf.workspaces WHERE id IN ($1, $2)`,
      [wsA, wsB],
    );
    adminClient.release();
    await adminPool.end();
    await appPool.end();
  }
});
