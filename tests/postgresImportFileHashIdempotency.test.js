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
