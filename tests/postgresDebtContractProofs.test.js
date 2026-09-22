/**
 * Track B / B3.10 — PostgreSQL debt contract proofs.
 *
 * Proves the live schema and constraints for the debt payment reconciliation
 * and debt adjustment subsystems at the database layer.
 *
 * Proofs covered:
 *   B — raf.debt_payment_reconciliations table schema and constraints exist
 *   C — status CHECK rejects invalid values
 *   D — unordered-pair uniqueness index prevents (A,B) and (B,A) coexisting
 *
 * Proof A (debt_adjustments CHECK constraint) is covered by
 *   tests/debtAdjustmentConstraint.test.js which runs in the same postgres job.
 * Proof of workspace isolation on debts is covered by
 *   tests/branchERlsEnforcement.test.js Phase 7.
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

maybeTest('B3 Proof B: raf.debt_payment_reconciliations table exists with required columns', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'raf' AND table_name = 'debt_payment_reconciliations'
      ORDER BY ordinal_position
    `);

    assert.ok(rows.length > 0, 'raf.debt_payment_reconciliations must exist with columns');

    const cols = new Map(rows.map((r) => [r.column_name, r]));

    for (const required of [
      'id', 'workspace_id', 'primary_payment_id', 'duplicate_payment_id',
      'status', 'match_type', 'created_at', 'updated_at',
    ]) {
      assert.ok(cols.has(required),
        `raf.debt_payment_reconciliations must have column "${required}"; got: ${[...cols.keys()].join(', ')}`);
    }

    assert.equal(cols.get('workspace_id')?.is_nullable, 'NO',
      'workspace_id must be NOT NULL');
    assert.equal(cols.get('status')?.is_nullable, 'NO',
      'status must be NOT NULL');
    assert.equal(cols.get('match_type')?.is_nullable, 'NO',
      'match_type must be NOT NULL');
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('B3 Proof C: debt_payment_reconciliations.status CHECK rejects invalid values', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();
  const wsId = uuid();
  const ownerId = uuid();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO raf.app_users (id, email, password_hash) VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
      [ownerId, `debt-proof-c-${wsId}@test.test`],
    );
    await client.query(
      `INSERT INTO raf.workspaces (id, name, owner_user_id) VALUES ($1, 'DebtProofWS', $2) ON CONFLICT DO NOTHING`,
      [wsId, ownerId],
    );

    // Valid status 'confirmed' — must succeed
    const p1 = uuid(); const p2 = uuid();
    await client.query(
      `INSERT INTO raf.debt_payment_reconciliations
         (workspace_id, primary_payment_id, duplicate_payment_id, status, match_type)
       VALUES ($1, $2, $3, 'confirmed', 'EXACT_MATCH')`,
      [wsId, p1, p2],
    );

    // Invalid status — must be rejected by CHECK constraint
    let checkViolation = null;
    await client.query('SAVEPOINT before_invalid_status');
    try {
      await client.query(
        `INSERT INTO raf.debt_payment_reconciliations
           (workspace_id, primary_payment_id, duplicate_payment_id, status, match_type)
         VALUES ($1, $2, $3, 'invalid_status', 'EXACT_MATCH')`,
        [wsId, uuid(), uuid()],
      );
    } catch (err) {
      checkViolation = err;
      await client.query('ROLLBACK TO SAVEPOINT before_invalid_status');
    }
    await client.query('RELEASE SAVEPOINT before_invalid_status');

    assert.ok(checkViolation,
      'status="invalid_status" must be rejected by CHECK constraint');
    assert.equal(checkViolation.code, '23514',
      `Expected check_violation (23514); got "${checkViolation.code}": ${checkViolation.message}`);

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

maybeTest('B3 Proof D: idx_debt_payment_reconciliations_unordered_pair prevents reversed pair (A,B) when (B,A) exists', async () => {
  const pool = new Pool({ connectionString, ssl: sslOption });
  const client = await pool.connect();
  const wsId = uuid();
  const ownerId = uuid();
  const pA = uuid();
  const pB = uuid();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO raf.app_users (id, email, password_hash) VALUES ($1, $2, 'test-hash') ON CONFLICT DO NOTHING`,
      [ownerId, `debt-proof-d-${wsId}@test.test`],
    );
    await client.query(
      `INSERT INTO raf.workspaces (id, name, owner_user_id) VALUES ($1, 'DebtProofDWS', $2) ON CONFLICT DO NOTHING`,
      [wsId, ownerId],
    );

    // Insert (primary=pA, duplicate=pB) — must succeed
    await client.query(
      `INSERT INTO raf.debt_payment_reconciliations
         (workspace_id, primary_payment_id, duplicate_payment_id, status, match_type)
       VALUES ($1, $2, $3, 'confirmed', 'POSSIBLE_MATCH')`,
      [wsId, pA, pB],
    );

    // Insert (primary=pB, duplicate=pA) — reversed pair — must be rejected
    let uniqueViolation = null;
    await client.query('SAVEPOINT before_reversed_pair');
    try {
      await client.query(
        `INSERT INTO raf.debt_payment_reconciliations
           (workspace_id, primary_payment_id, duplicate_payment_id, status, match_type)
         VALUES ($1, $2, $3, 'rejected', 'POSSIBLE_MATCH')`,
        [wsId, pB, pA],
      );
    } catch (err) {
      uniqueViolation = err;
      await client.query('ROLLBACK TO SAVEPOINT before_reversed_pair');
    }
    await client.query('RELEASE SAVEPOINT before_reversed_pair');

    assert.ok(uniqueViolation,
      'Reversed reconciliation pair (B,A) when (A,B) exists must be rejected');
    assert.equal(uniqueViolation.code, '23505',
      `Expected UNIQUE violation (23505); got "${uniqueViolation.code}": ${uniqueViolation.message}`);

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});
