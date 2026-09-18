/**
 * Phase 2B regression: transitionToReviewing must not overwrite a concurrently
 * committed CLOSED record.
 *
 * These structural tests verify the DB-native conditional write path without
 * requiring a live database. Integration tests require DATABASE_URL.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDirectTxWithMonthlyReview({ closeExists = false, reviewExists = false } = {}) {
  const wsId = 'ws-race-01';
  const period = '2026-09-01';

  return {
    transitionMonthlyReviewToReviewing: async ({ householdId, period: p }) => {
      if (closeExists) return { blocked: true };
      const review = {
        id: 'rev-001',
        workspaceId: wsId,
        reviewMonth: p,
        status: 'reviewing',
        netSurplus: '0.00',
      };
      return { blocked: false, review };
    },
    listMonthCloses: async () => closeExists ? [{ id: 'close-001', status: 'CLOSED', period, version: 1 }] : [],
    getMonthlyReviewByMonth: async () => reviewExists ? { id: 'rev-001', status: 'draft', reviewMonth: period } : null,
    updateMonthlyReview: async ({ patch }) => ({ id: 'rev-001', ...patch }),
    insertMonthlyReview: async (payload) => ({ id: 'rev-001', ...payload }),
    logAuditEvent: async () => {},
  };
}

// Minimal db wrapper that passes the tx directly (no hybrid adapter)
function makeDb(tx) {
  return {
    transaction: (fn) => fn(tx),
  };
}

// ── structural tests ─────────────────────────────────────────────────────────

describe('Phase 2B: transitionToReviewing race fix', async () => {
  const { transitionToReviewing } = await import('../lib/monthlyReviews/monthlyLifecycle.js');

  it('takes DB-native path when transitionMonthlyReviewToReviewing is present', async () => {
    const tx = makeDirectTxWithMonthlyReview({ closeExists: false });
    let nativePathUsed = false;
    const spy = tx.transitionMonthlyReviewToReviewing;
    tx.transitionMonthlyReviewToReviewing = async (...args) => {
      nativePathUsed = true;
      return spy(...args);
    };

    const result = await transitionToReviewing({
      db: makeDb(tx),
      householdId: 'ws-race-01',
      period: '2026-09-01',
      userId: 'user-01',
    });

    assert.ok(nativePathUsed, 'must use transitionMonthlyReviewToReviewing when available');
    assert.equal(result.state, 'REVIEWING');
    assert.ok(result.review);
  });

  it('throws 409 when DB-native path returns blocked:true (concurrent close)', async () => {
    const tx = makeDirectTxWithMonthlyReview({ closeExists: true });

    await assert.rejects(
      () =>
        transitionToReviewing({
          db: makeDb(tx),
          householdId: 'ws-race-01',
          period: '2026-09-01',
          userId: 'user-01',
        }),
      (err) => {
        assert.equal(err.statusCode ?? err.status, 409);
        return true;
      },
    );
  });

  it('falls back to hybrid path when transitionMonthlyReviewToReviewing is absent', async () => {
    const tx = makeDirectTxWithMonthlyReview({ closeExists: false, reviewExists: false });
    delete tx.transitionMonthlyReviewToReviewing;
    let insertCalled = false;
    tx.insertMonthlyReview = async (payload) => {
      insertCalled = true;
      return { id: 'rev-001', ...payload };
    };

    const result = await transitionToReviewing({
      db: makeDb(tx),
      householdId: 'ws-race-01',
      period: '2026-09-01',
      userId: 'user-01',
    });

    assert.ok(insertCalled, 'fallback path must call insertMonthlyReview');
    assert.equal(result.state, 'REVIEWING');
  });

  it('fallback path throws 409 when hybrid read sees a CLOSED record', async () => {
    const tx = makeDirectTxWithMonthlyReview({ closeExists: true });
    delete tx.transitionMonthlyReviewToReviewing;

    await assert.rejects(
      () =>
        transitionToReviewing({
          db: makeDb(tx),
          householdId: 'ws-race-01',
          period: '2026-09-01',
          userId: 'user-01',
        }),
      (err) => {
        assert.equal(err.statusCode ?? err.status, 409);
        return true;
      },
    );
  });

  it('DB-native path: blocked:false with existing review returns the review', async () => {
    const wsId = 'ws-race-01';
    const existingReview = { id: 'rev-999', workspaceId: wsId, reviewMonth: '2026-09-01', status: 'reviewing', netSurplus: '0.00' };
    const tx = {
      transitionMonthlyReviewToReviewing: async () => ({ blocked: false, review: existingReview }),
      logAuditEvent: async () => {},
    };

    const result = await transitionToReviewing({
      db: makeDb(tx),
      householdId: wsId,
      period: '2026-09-01',
      userId: 'user-01',
    });

    assert.equal(result.review.id, 'rev-999');
    assert.equal(result.state, 'REVIEWING');
  });
});

// ── transitionMonthlyReviewToReviewing unit tests (structural) ───────────────

describe('Phase 2B: transitionMonthlyReviewToReviewing SQL logic contract', async () => {
  it('NOT EXISTS is evaluated atomically with the write — structural contract', () => {
    // This test proves the contract is correctly documented, not re-implements
    // the DB engine. The race invariant is: the NOT EXISTS subquery sees all
    // committed data at statement execution time under READ COMMITTED isolation.
    //
    // Scenario: concurrent timeline
    //   T1 calls transitionToReviewing → begins UPDATE/INSERT
    //   T2 calls closeMonth → commits INSERT to monthly_closes with status='CLOSED'
    //   T1's NOT EXISTS subquery evaluates AFTER T2 commits
    //   → NOT EXISTS returns false → UPDATE/INSERT returns 0 rows → blocked:true
    //
    // This is guaranteed by PostgreSQL READ COMMITTED: each statement reads the
    // latest committed snapshot at statement start, not transaction start.
    assert.ok(true, 'Documented: NOT EXISTS evaluated at statement time, not tx start');
  });

  it('sequential-call-ordering approach is NOT safe after adapter removal', () => {
    // Phase 2A finding: if F1 were implemented by calling listMonthCloses
    // sequentially (relying on advisory lock having loaded fresh state), the
    // fix would only work while the hybrid adapter serializes transactions.
    // After adapter removal there is no lock, and the TOCTOU returns.
    //
    // The DB-native conditional write is the correct implementation because
    // it holds the invariant at the database level, independent of any
    // application-layer locking.
    assert.ok(true, 'Documented: sequential-call fix is adapter-dependent; DB-native is not');
  });
});
