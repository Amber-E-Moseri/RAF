/**
 * Atomic Buffer Close — Real PostgreSQL Certification
 *
 * Proves that buffer disposition and month close are atomic: either both
 * commit or neither commits. This is the PostgreSQL-level proof required
 * for Wave C certification.
 *
 * These tests exercise the ACTUAL application code path (closeMonth) against
 * a real disposable PostgreSQL 16 instance using the raf_app runtime role.
 *
 * Failure injection throws INSIDE the transaction callback AFTER the financial
 * write but BEFORE insertMonthClose. PostgreSQL's own ROLLBACK (triggered by
 * createPostgresDb.transaction()'s catch block) undoes the financial write.
 * NO manual cleanup is performed between injection and assertion.
 *
 * Gate conditions (all required):
 *   DATABASE_URL                   — privileged owner connection (for setup + fresh assertion reads)
 *   POSTGRES_CONNECTION_STRING_APP — raf_app role connection (for the actual close operation)
 *   RAF_RUN_POSTGRES_RLS_TESTS     — must be 'true'
 *   RAF_CONFIRM_NON_PRODUCTION_DB  — must be 'true'
 *
 * @group postgres-atomicity
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { createPostgresDb } from '../lib/server/postgresDb.js';
import {
  closeMonth,
  getMonthLifecycleState,
  LifecycleState,
  MonthlyReviewHttpError,
} from '../lib/monthlyReviews/monthlyLifecycle.js';

// ── Environment gate ──────────────────────────────────────────────────────────

const ownerUrl = process.env.DATABASE_URL?.replace(/^["']|["']$/g, '');
const appUrl   = process.env.POSTGRES_CONNECTION_STRING_APP?.replace(/^["']|["']$/g, '');
const rlsFlag  = process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true';
const nonProd  = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const shouldRun = Boolean(ownerUrl && appUrl && rlsFlag && nonProd);
const maybeTest = shouldRun ? test : test.skip;

const ssl = process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
  ? false
  : { rejectUnauthorized: false };

// ── Shared pools ──────────────────────────────────────────────────────────────

let ownerPool;
let appDb;

before(() => {
  if (!shouldRun) return;
  ownerPool = new Pool({ connectionString: ownerUrl, ssl });
  appDb = createPostgresDb({ connectionString: appUrl, ssl: ssl === false ? false : true });
});

after(async () => {
  if (ownerPool) await ownerPool.end().catch(() => {});
  if (appDb) await appDb.close().catch(() => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function uuid() { return crypto.randomUUID(); }

/**
 * Returns an app-role db whose transaction() injects workspaceId into the
 * security context. This mirrors what withSecurityContext() does in routerLoader.js
 * for production route handlers.
 */
function withSecurity(db, workspaceId) {
  return {
    ...db,
    transaction: (callback) => db.transaction(callback, { workspaceId }),
  };
}

/**
 * Returns an app-role db that wraps insertMonthClose to throw AFTER any
 * financial write has already executed on the same transaction. The throw
 * propagates to createPostgresDb.transaction()'s catch block which issues
 * real PostgreSQL ROLLBACK — no manual cleanup.
 */
function withInjectFailAtClose(db) {
  return {
    ...db,
    transaction: (callback, ctx) => db.transaction(async (tx) => callback({
      ...tx,
      async insertMonthClose() {
        throw new Error('INJECTED_FAILURE_AFTER_FINANCIAL_WRITE_BEFORE_CLOSE_COMMIT');
      },
    }), ctx),
  };
}

/**
 * Seeds a disposable workspace and returns the ownerDb + householdId.
 * The buffer allocation category is seeded with $100 income → $0 spent,
 * so remainingCents = 100_00.
 *
 * Caller must call ownerDb.close() when done.
 */
async function seedWorkspaceWithBuffer(label) {
  const ownerDb = createPostgresDb({ connectionString: ownerUrl, ssl: ssl === false ? false : true });
  const ownerUserId = uuid();
  const period = '2026-07-01';

  let workspace;
  let bufferCatId;

  await ownerDb.transaction(async (tx) => {
    workspace = await tx.createWorkspace({ ownerUserId, name: `Test ${label}` });
  });

  const householdId = workspace.id;

  await ownerDb.transaction(async (tx) => {
    const cats = await tx.listAllocationCategories({ householdId, asOf: period });
    const buf = cats.find((c) => c.isBuffer === true && c.isActive !== false);
    bufferCatId = buf?.id ?? null;
  });

  if (!bufferCatId) throw new Error(`No buffer category for workspace ${householdId}`);

  // Seed $100 income allocated to buffer — 0 transactions → remaining = $100
  await ownerDb.transaction(async (tx) => {
    const entry = await tx.insertIncomeEntry({
      householdId,
      receivedDate: period,
      amount: '100.00',
      sourceName: 'Test Income',
    });
    await tx.insertIncomeAllocations([{
      householdId,
      incomeEntryId: entry.id,
      allocationCategoryId: bufferCatId,
      allocatedAmount: '100.00',
    }]);
  });

  return { householdId, bufferCatId, period, ownerDb };
}

// ── Phase C: Role & version ───────────────────────────────────────────────────

maybeTest('C-PG-0: Record PostgreSQL version and raf_app role posture', async () => {
  const client = await ownerPool.connect();
  try {
    const ver = await client.query('SELECT version()');
    const role = await client.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
       FROM pg_roles WHERE rolname = 'raf_app'`,
    );
    const r = role.rows[0];
    assert.ok(ver.rows[0].version.includes('PostgreSQL'), 'PostgreSQL version readable');
    assert.ok(r, 'raf_app role exists');
    assert.strictEqual(r.rolsuper, false, 'raf_app must be NOSUPERUSER');
    assert.strictEqual(r.rolbypassrls, false, 'raf_app must be NOBYPASSRLS');
    assert.strictEqual(r.rolcreaterole, false, 'raf_app must be NOCREATEROLE');
  } finally {
    client.release();
  }
});

// ── Phase D: Goal commit ──────────────────────────────────────────────────────

maybeTest('C-PG-1: Goal disposition commits atomically with month close', async () => {
  const { householdId, period, ownerDb } = await seedWorkspaceWithBuffer('pg-goal-commit');
  let goalId;
  try {
    // Seed goal using owner connection
    await ownerDb.transaction(async (tx) => {
      const g = await tx.insertGoal({ householdId, name: 'Vacation', targetAmount: '2000.00', active: true });
      goalId = g.id;
    });

    // Close using app role + security context — no client-supplied amount
    const securedDb = withSecurity(appDb, householdId);
    const result = await closeMonth({
      db: securedDb,
      householdId,
      period,
      userId: 'test-user-pg-1',
      bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId },
    });

    assert.strictEqual(result.state, LifecycleState.CLOSED);

    // Server derives $100 from authoritative buffer state; client sent no amount
    assert.deepStrictEqual(result.bufferDisposition, {
      type: 'apply_to_goal',
      amount: '100.00',
      targetId: goalId,
    }, 'Server-derived amount must be exactly $100 (authoritative buffer remaining)');

    // Verify via fresh owner reads
    const client = await ownerPool.connect();
    try {
      const closes = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1 AND status = 'CLOSED'`,
        [householdId],
      );
      assert.strictEqual(closes.rows.length, 1, 'Exactly one CLOSED month close row');

      const goalTxs = await client.query(
        `SELECT raw_json FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(goalTxs.rows.length, 1, 'Exactly one disposition transaction');
      const txJson = goalTxs.rows[0].raw_json;
      assert.strictEqual(txJson.amount, '100.00', 'Disposition amount exactly $100');
      assert.strictEqual(txJson.linkedGoalId, goalId, 'Transaction linked to correct goal');
    } finally {
      client.release();
    }
  } finally {
    await ownerDb.close().catch(() => {});
  }
});

// ── Phase D: Goal rollback ────────────────────────────────────────────────────

maybeTest('C-PG-2: Goal disposition rolls back atomically when close persistence fails', async () => {
  const { householdId, period, ownerDb } = await seedWorkspaceWithBuffer('pg-goal-rollback');
  let goalId;
  try {
    await ownerDb.transaction(async (tx) => {
      const g = await tx.insertGoal({ householdId, name: 'Vacation', targetAmount: '2000.00', active: true });
      goalId = g.id;
    });

    // Failure injection: insertMonthClose throws AFTER financial write
    // createPostgresDb.transaction() catch block issues real PostgreSQL ROLLBACK
    const failDb = withInjectFailAtClose(withSecurity(appDb, householdId));
    const err = await closeMonth({
      db: failDb,
      householdId,
      period,
      userId: 'test-user-pg-2',
      bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId },
    }).catch((e) => e);

    assert.ok(err instanceof Error, 'Injection error propagated');
    assert.ok(err.message.includes('INJECTED'), 'Correct injection error');

    // ── Verify with fresh owner reads: NO manual cleanup was done ──────────────
    const client = await ownerPool.connect();
    try {
      const closes = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(closes.rows.length, 0, 'NO month close row must survive rollback');

      const dispTxs = await client.query(
        `SELECT id FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(dispTxs.rows.length, 0, 'NO disposition transaction must survive PostgreSQL rollback');

      const reviews = await client.query(
        `SELECT id FROM raf.monthly_reviews WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(reviews.rows.length, 0, 'NO monthly_review row must survive rollback');
    } finally {
      client.release();
    }

    // Verify month remains open via application path
    const securedDb = withSecurity(appDb, householdId);
    const state = await getMonthLifecycleState({ db: securedDb, householdId, period });
    assert.strictEqual(state.state, LifecycleState.OPEN, 'Month must remain OPEN after rollback');

    // ── Retry normally — must succeed with exactly $100 ─────────────────────
    const retryResult = await closeMonth({
      db: securedDb,
      householdId,
      period,
      userId: 'test-user-pg-2-retry',
      bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId },
    });
    assert.strictEqual(retryResult.state, LifecycleState.CLOSED);
    assert.strictEqual(retryResult.bufferDisposition.amount, '100.00', 'Retry disposition exactly $100');

    // Final fresh check — exactly one effect total
    const client2 = await ownerPool.connect();
    try {
      const finalTxs = await client2.query(
        `SELECT id FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(finalTxs.rows.length, 1, 'Exactly one disposition transaction total after retry');

      const finalCloses = await client2.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1 AND status = 'CLOSED'`,
        [householdId],
      );
      assert.strictEqual(finalCloses.rows.length, 1, 'Exactly one CLOSED month close after retry');
    } finally {
      client2.release();
    }
  } finally {
    await ownerDb.close().catch(() => {});
  }
});

// ── Phase E: Debt commit ──────────────────────────────────────────────────────

maybeTest('C-PG-3: Debt disposition commits atomically with month close', async () => {
  const { householdId, period, ownerDb } = await seedWorkspaceWithBuffer('pg-debt-commit');
  let debtId;
  try {
    await ownerDb.transaction(async (tx) => {
      const d = await tx.insertDebt({ householdId, name: 'Car Loan', startingBalance: '10000.00', minimumPayment: '300.00' });
      debtId = d.id;
    });

    const securedDb = withSecurity(appDb, householdId);
    const result = await closeMonth({
      db: securedDb,
      householdId,
      period,
      userId: 'test-user-pg-3',
      bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId },
    });

    assert.strictEqual(result.state, LifecycleState.CLOSED);
    assert.deepStrictEqual(result.bufferDisposition, {
      type: 'apply_to_debt',
      amount: '100.00',
      targetId: debtId,
    });

    const client = await ownerPool.connect();
    try {
      const closes = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1 AND status = 'CLOSED'`,
        [householdId],
      );
      assert.strictEqual(closes.rows.length, 1, 'Exactly one month close');

      const payments = await client.query(
        `SELECT raw_json FROM raf.debt_payments WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(payments.rows.length, 1, 'Exactly one debt payment');
      assert.strictEqual(payments.rows[0].raw_json.amount, '100.00', 'Payment amount exactly $100');
      assert.strictEqual(payments.rows[0].raw_json.debtId, debtId, 'Payment linked to correct debt');

      const dispTxs = await client.query(
        `SELECT id FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(dispTxs.rows.length, 1, 'Exactly one disposition transaction');
    } finally {
      client.release();
    }
  } finally {
    await ownerDb.close().catch(() => {});
  }
});

// ── Phase E: Debt rollback ────────────────────────────────────────────────────

maybeTest('C-PG-4: Debt disposition + payment roll back when close persistence fails', async () => {
  const { householdId, period, ownerDb } = await seedWorkspaceWithBuffer('pg-debt-rollback');
  let debtId;
  try {
    await ownerDb.transaction(async (tx) => {
      const d = await tx.insertDebt({ householdId, name: 'Car Loan', startingBalance: '10000.00', minimumPayment: '300.00' });
      debtId = d.id;
    });

    const failDb = withInjectFailAtClose(withSecurity(appDb, householdId));
    const err = await closeMonth({
      db: failDb,
      householdId,
      period,
      userId: 'test-user-pg-4',
      bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId },
    }).catch((e) => e);

    assert.ok(err instanceof Error);
    assert.ok(err.message.includes('INJECTED'));

    // Fresh reads — NO manual cleanup performed
    const client = await ownerPool.connect();
    try {
      const closes = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(closes.rows.length, 0, 'NO close row after rollback');

      const payments = await client.query(
        `SELECT id FROM raf.debt_payments WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(payments.rows.length, 0, 'NO debt payment after rollback');

      const dispTxs = await client.query(
        `SELECT id FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(dispTxs.rows.length, 0, 'NO disposition transaction after rollback');
    } finally {
      client.release();
    }

    const securedDb = withSecurity(appDb, householdId);
    const state = await getMonthLifecycleState({ db: securedDb, householdId, period });
    assert.strictEqual(state.state, LifecycleState.OPEN, 'Month remains OPEN after rollback');

    // Retry
    const retryResult = await closeMonth({
      db: securedDb,
      householdId,
      period,
      userId: 'test-user-pg-4-retry',
      bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId },
    });
    assert.strictEqual(retryResult.state, LifecycleState.CLOSED);
    assert.strictEqual(retryResult.bufferDisposition.amount, '100.00');

    const client2 = await ownerPool.connect();
    try {
      const finalPayments = await client2.query(
        `SELECT id FROM raf.debt_payments WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(finalPayments.rows.length, 1, 'Exactly one payment total after retry');

      const finalCloses = await client2.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1 AND status = 'CLOSED'`,
        [householdId],
      );
      assert.strictEqual(finalCloses.rows.length, 1, 'Exactly one close total after retry');
    } finally {
      client2.release();
    }
  } finally {
    await ownerDb.close().catch(() => {});
  }
});

// ── Phase F: return_to_plan ───────────────────────────────────────────────────

maybeTest('C-PG-5: return_to_plan is metadata-only — no financial transaction created', async () => {
  const { householdId, period, ownerDb } = await seedWorkspaceWithBuffer('pg-return-to-plan');
  try {
    const securedDb = withSecurity(appDb, householdId);
    const result = await closeMonth({
      db: securedDb,
      householdId,
      period,
      userId: 'test-user-pg-5',
      bufferDispositionInput: { type: 'return_to_plan' },
    });

    assert.strictEqual(result.state, LifecycleState.CLOSED);
    assert.strictEqual(result.bufferDisposition.type, 'return_to_plan');
    assert.strictEqual(result.bufferDisposition.amount, '100.00');

    const client = await ownerPool.connect();
    try {
      const closes = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1 AND status = 'CLOSED'`,
        [householdId],
      );
      assert.strictEqual(closes.rows.length, 1, 'Month closed once');

      const dispTxs = await client.query(
        `SELECT id FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(dispTxs.rows.length, 0, 'return_to_plan creates NO financial transaction');

      const payments = await client.query(
        `SELECT id FROM raf.debt_payments WHERE workspace_id = $1`,
        [householdId],
      );
      assert.strictEqual(payments.rows.length, 0, 'return_to_plan creates NO debt payment');
    } finally {
      client.release();
    }
  } finally {
    await ownerDb.close().catch(() => {});
  }
});

// ── Phase G: Cross-workspace security ────────────────────────────────────────

maybeTest('C-PG-6: WS_A month cannot dispose to WS_B goal (cross-workspace rejection)', async () => {
  const { householdId: wsA, period, ownerDb: ownerDbA } = await seedWorkspaceWithBuffer('pg-xws-goal-a');
  const ownerDbB = createPostgresDb({ connectionString: ownerUrl, ssl: ssl === false ? false : true });
  let wsBId;
  let foreignGoalId;
  try {
    // Create workspace B with a goal
    await ownerDbB.transaction(async (tx) => {
      const ws = await tx.createWorkspace({ ownerUserId: uuid(), name: 'Test WS-B-Goal' });
      wsBId = ws.id;
      const g = await tx.insertGoal({ householdId: wsBId, name: 'Foreign Goal', targetAmount: '500.00', active: true });
      foreignGoalId = g.id;
    });

    // Attempt: WS_A close using WS_B goal — must be rejected
    const securedDbA = withSecurity(appDb, wsA);
    const err = await closeMonth({
      db: securedDbA,
      householdId: wsA,
      period,
      userId: 'test-user-pg-6',
      bufferDispositionInput: { type: 'apply_to_goal', targetId: foreignGoalId },
    }).catch((e) => e);

    assert.ok(err instanceof MonthlyReviewHttpError, 'Cross-workspace goal must throw MonthlyReviewHttpError');
    assert.strictEqual(err.status, 422, 'Must reject with 422');

    // WS_A month remains open
    const stateA = await getMonthLifecycleState({ db: securedDbA, householdId: wsA, period });
    assert.strictEqual(stateA.state, LifecycleState.OPEN, 'WS_A month remains OPEN after cross-workspace rejection');

    // No financial mutation in either workspace
    const client = await ownerPool.connect();
    try {
      const closesA = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1`,
        [wsA],
      );
      assert.strictEqual(closesA.rows.length, 0, 'WS_A has no close row after cross-workspace rejection');

      const goalTxB = await client.query(
        `SELECT id FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [wsBId],
      );
      assert.strictEqual(goalTxB.rows.length, 0, 'WS_B has no disposition transaction');
    } finally {
      client.release();
    }
  } finally {
    await ownerDbA.close().catch(() => {});
    await ownerDbB.close().catch(() => {});
  }
});

maybeTest('C-PG-7: WS_A month cannot dispose to WS_B debt (cross-workspace rejection)', async () => {
  const { householdId: wsA, period, ownerDb: ownerDbA } = await seedWorkspaceWithBuffer('pg-xws-debt-a');
  const ownerDbB = createPostgresDb({ connectionString: ownerUrl, ssl: ssl === false ? false : true });
  let wsBId;
  let foreignDebtId;
  try {
    await ownerDbB.transaction(async (tx) => {
      const ws = await tx.createWorkspace({ ownerUserId: uuid(), name: 'Test WS-B-Debt' });
      wsBId = ws.id;
      const d = await tx.insertDebt({
        householdId: wsBId,
        name: 'Foreign Debt',
        startingBalance: '5000.00',
        minimumPayment: '200.00',
      });
      foreignDebtId = d.id;
    });

    const securedDbA = withSecurity(appDb, wsA);
    const err = await closeMonth({
      db: securedDbA,
      householdId: wsA,
      period,
      userId: 'test-user-pg-7',
      bufferDispositionInput: { type: 'apply_to_debt', targetId: foreignDebtId },
    }).catch((e) => e);

    assert.ok(err instanceof MonthlyReviewHttpError);
    assert.strictEqual(err.status, 422);

    const stateA = await getMonthLifecycleState({ db: securedDbA, householdId: wsA, period });
    assert.strictEqual(stateA.state, LifecycleState.OPEN, 'WS_A remains OPEN');

    const client = await ownerPool.connect();
    try {
      const closesA = await client.query(
        `SELECT id FROM raf.monthly_closes WHERE workspace_id = $1`,
        [wsA],
      );
      assert.strictEqual(closesA.rows.length, 0, 'No close row for WS_A');

      const paymentsB = await client.query(
        `SELECT id FROM raf.debt_payments WHERE workspace_id = $1`,
        [wsBId],
      );
      assert.strictEqual(paymentsB.rows.length, 0, 'No debt payment in WS_B');
    } finally {
      client.release();
    }
  } finally {
    await ownerDbA.close().catch(() => {});
    await ownerDbB.close().catch(() => {});
  }
});

// ── Phase H: Server amount authority ─────────────────────────────────────────

maybeTest('C-PG-8: Client-supplied amount is ignored — server derives $100 from authoritative buffer', async () => {
  const { householdId, period, ownerDb } = await seedWorkspaceWithBuffer('pg-srv-amount');
  let goalId;
  try {
    await ownerDb.transaction(async (tx) => {
      const g = await tx.insertGoal({ householdId, name: 'Test Goal', targetAmount: '5000.00', active: true });
      goalId = g.id;
    });

    const securedDb = withSecurity(appDb, householdId);

    // Client attempts to send amount=$500 — but BufferDispositionCommand has no amount field
    // and closeMonth ignores it; server derives $100 from authoritative state
    const result = await closeMonth({
      db: securedDb,
      householdId,
      period,
      userId: 'test-user-pg-8',
      // Intentionally pass amount in the input to confirm server ignores it
      bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId, amount: '500.00' },
    });

    assert.strictEqual(result.state, LifecycleState.CLOSED);
    // Server MUST derive $100 (the actual remaining buffer), not $500
    assert.strictEqual(result.bufferDisposition.amount, '100.00',
      'Server must derive $100 from authoritative buffer state, ignoring any client-supplied amount');

    const client = await ownerPool.connect();
    try {
      const dispTxs = await client.query(
        `SELECT raw_json FROM raf.transactions WHERE workspace_id = $1 AND raw_json->>'source' = 'buffer_disposition'`,
        [householdId],
      );
      assert.strictEqual(dispTxs.rows.length, 1);
      assert.strictEqual(dispTxs.rows[0].raw_json.amount, '100.00',
        'Financial transaction amount must be $100, not client-supplied $500');
    } finally {
      client.release();
    }
  } finally {
    await ownerDb.close().catch(() => {});
  }
});
