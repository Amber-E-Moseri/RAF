/**
 * Financial Inbox Phase 1 — canonical transaction review
 * 22-case adversarial matrix covering eligibility, server-authority, atomicity, isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveReviewEligibility,
  markTransactionReviewed,
  markTransactionUnreviewed,
  bulkMarkTransactionsReviewed,
  TransactionReviewError,
} from '../lib/transactions/transactionReview.js';

// ─── DB Double ────────────────────────────────────────────────────────────────

function makeTransaction(overrides = {}) {
  return {
    id: 'txn-1',
    householdId: 'hh-1',
    transactionDate: '2026-09-01',
    description: 'Costco',
    merchant: 'Costco',
    amount: '127.40',
    direction: 'debit',
    categoryId: 'cat-groceries',
    linkedDebtId: null,
    linkedGoalId: null,
    source: 'manual',
    reviewedAt: null,
    reviewedBy: null,
    ...overrides,
  };
}

function createDbDouble({ transactions = [], splits = [] } = {}) {
  const state = {
    transactions: transactions.map((t) => ({ ...t })),
    splits: splits.map((s) => ({ ...s })),
  };

  const tx = {
    async getTransactionById({ householdId, transactionId }) {
      return state.transactions.find(
        (t) => t.householdId === householdId && t.id === transactionId,
      ) ?? null;
    },
    async listTransactionSplits({ householdId, transactionId }) {
      return state.splits.filter(
        (s) => s.householdId === householdId && s.transactionId === transactionId,
      );
    },
    async markTransactionReviewed({ householdId, transactionId, reviewedAt, reviewedBy }) {
      const row = state.transactions.find((t) => t.householdId === householdId && t.id === transactionId);
      if (!row) return null;
      Object.assign(row, { reviewedAt, reviewedBy });
      return { ...row };
    },
    async markTransactionUnreviewed({ householdId, transactionId }) {
      const row = state.transactions.find((t) => t.householdId === householdId && t.id === transactionId);
      if (!row) return null;
      Object.assign(row, { reviewedAt: null, reviewedBy: null });
      return { ...row };
    },
    async bulkMarkTransactionsReviewed({ householdId, transactionIds, reviewedAt, reviewedBy }) {
      for (const transactionId of transactionIds) {
        const row = state.transactions.find((t) => t.householdId === householdId && t.id === transactionId);
        if (row) Object.assign(row, { reviewedAt, reviewedBy });
      }
    },
  };

  const db = {
    async transaction(callback) {
      return callback(tx);
    },
    state,
  };

  return db;
}

// ─── 1. Eligibility derivation ────────────────────────────────────────────────

describe('deriveReviewEligibility', () => {
  it('1. ordinary debit with category is eligible', () => {
    const t = makeTransaction({ direction: 'debit', categoryId: 'cat-1', linkedDebtId: null, linkedGoalId: null });
    assert.deepEqual(deriveReviewEligibility(t, []), { eligible: true, reasons: [] });
  });

  it('2. ordinary debit without category is ineligible (unresolved_category)', () => {
    const t = makeTransaction({ direction: 'debit', categoryId: null, linkedDebtId: null, linkedGoalId: null });
    const { eligible, reasons } = deriveReviewEligibility(t, []);
    assert.equal(eligible, false);
    assert.deepEqual(reasons, ['unresolved_category']);
  });

  it('3. debt payment (debit + linkedDebtId) is always eligible', () => {
    const t = makeTransaction({ direction: 'debit', categoryId: null, linkedDebtId: 'debt-1', linkedGoalId: null });
    assert.deepEqual(deriveReviewEligibility(t, []), { eligible: true, reasons: [] });
  });

  it('4. goal-funded debit (linkedGoalId) is always eligible', () => {
    const t = makeTransaction({ direction: 'debit', categoryId: 'cat-1', linkedGoalId: 'goal-1', linkedDebtId: null });
    assert.deepEqual(deriveReviewEligibility(t, []), { eligible: true, reasons: [] });
  });

  it('5. credit transaction is always eligible (no category requirement)', () => {
    const t = makeTransaction({ direction: 'credit', categoryId: null, linkedDebtId: null, linkedGoalId: null });
    assert.deepEqual(deriveReviewEligibility(t, []), { eligible: true, reasons: [] });
  });

  it('6. split parent where all splits have categories is eligible', () => {
    const t = makeTransaction({ categoryId: null, linkedDebtId: null, linkedGoalId: null });
    const splits = [
      { id: 'sp-1', transactionId: t.id, amount: '50.00', categoryId: 'cat-food' },
      { id: 'sp-2', transactionId: t.id, amount: '77.40', categoryId: 'cat-home' },
    ];
    assert.deepEqual(deriveReviewEligibility(t, splits), { eligible: true, reasons: [] });
  });

  it('7. split parent with uncategorized split is ineligible (unresolved_split)', () => {
    const t = makeTransaction({ categoryId: null });
    const splits = [
      { id: 'sp-1', transactionId: t.id, amount: '50.00', categoryId: 'cat-food' },
      { id: 'sp-2', transactionId: t.id, amount: '77.40', categoryId: null },
    ];
    const { eligible, reasons } = deriveReviewEligibility(t, splits);
    assert.equal(eligible, false);
    assert.deepEqual(reasons, ['unresolved_split']);
  });
});

// ─── 2. markTransactionReviewed ───────────────────────────────────────────────

describe('markTransactionReviewed', () => {
  it('8. eligible transaction can be marked reviewed', async () => {
    const txn = makeTransaction({ categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [txn] });
    const result = await markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: 'user-abc' });
    assert.ok(result.reviewedAt, 'reviewedAt must be set');
  });

  it('9. server supplies reviewedAt (not from client)', async () => {
    const txn = makeTransaction({ categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [txn] });
    const before = new Date().toISOString();
    const result = await markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: 'user-abc' });
    const after = new Date().toISOString();
    assert.ok(result.reviewedAt >= before && result.reviewedAt <= after, 'reviewedAt must be a server timestamp');
  });

  it('10. reviewedBy reflects userId from trusted context', async () => {
    const txn = makeTransaction({ categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [txn] });
    const result = await markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: 'user-abc' });
    assert.equal(result.reviewedBy, 'user-abc');
  });

  it('11. missing actor (userId null) is rejected with 400', async () => {
    const txn = makeTransaction({ categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [txn] });
    await assert.rejects(
      () => markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: null }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  it('12. ineligible transaction (no category) is rejected with 409', async () => {
    const txn = makeTransaction({ categoryId: null, linkedDebtId: null, linkedGoalId: null, direction: 'debit' });
    const db = createDbDouble({ transactions: [txn] });
    await assert.rejects(
      () => markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: 'user-abc' }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('13. transaction not found returns 404', async () => {
    const db = createDbDouble({ transactions: [] });
    await assert.rejects(
      () => markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-missing', userId: 'user-abc' }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('14. cross-workspace transaction (wrong household) returns 404', async () => {
    const txn = makeTransaction({ householdId: 'hh-other' });
    const db = createDbDouble({ transactions: [txn] });
    await assert.rejects(
      () => markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: 'user-abc' }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

// ─── 3. markTransactionUnreviewed ─────────────────────────────────────────────

describe('markTransactionUnreviewed', () => {
  it('15. reviewed transaction can be unreviewed', async () => {
    const txn = makeTransaction({ categoryId: 'cat-1', reviewedAt: '2026-09-14T10:00:00.000Z', reviewedBy: 'user-abc' });
    const db = createDbDouble({ transactions: [txn] });
    const result = await markTransactionUnreviewed({ db, householdId: 'hh-1', transactionId: 'txn-1' });
    assert.equal(result.reviewedAt, null);
    assert.equal(result.reviewedBy, null);
  });

  it('16. unreview on non-existent transaction returns 404', async () => {
    const db = createDbDouble({ transactions: [] });
    await assert.rejects(
      () => markTransactionUnreviewed({ db, householdId: 'hh-1', transactionId: 'txn-missing' }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

// ─── 4. bulkMarkTransactionsReviewed ─────────────────────────────────────────

describe('bulkMarkTransactionsReviewed', () => {
  it('17. bulk review succeeds for all eligible transactions atomically', async () => {
    const t1 = makeTransaction({ id: 'txn-1', categoryId: 'cat-1' });
    const t2 = makeTransaction({ id: 'txn-2', categoryId: 'cat-2' });
    const db = createDbDouble({ transactions: [t1, t2] });
    const result = await bulkMarkTransactionsReviewed({
      db, householdId: 'hh-1', transactionIds: ['txn-1', 'txn-2'], userId: 'user-abc',
    });
    assert.deepEqual(result.reviewedIds, ['txn-1', 'txn-2']);
    assert.ok(result.reviewedAt);
    assert.equal(db.state.transactions.find((t) => t.id === 'txn-1').reviewedAt, result.reviewedAt);
    assert.equal(db.state.transactions.find((t) => t.id === 'txn-2').reviewedAt, result.reviewedAt);
  });

  it('18. bulk rejects entire batch if any transaction is cross-workspace (404)', async () => {
    const t1 = makeTransaction({ id: 'txn-1', categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [t1] });
    await assert.rejects(
      () => bulkMarkTransactionsReviewed({
        db, householdId: 'hh-1', transactionIds: ['txn-1', 'txn-cross'], userId: 'user-abc',
      }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 404);
        return true;
      },
    );
    // t1 must NOT be written (all-or-nothing)
    assert.equal(db.state.transactions.find((t) => t.id === 'txn-1').reviewedAt, null);
  });

  it('19. bulk rejects entire batch if third item is ineligible (all-or-nothing)', async () => {
    const t1 = makeTransaction({ id: 'txn-1', categoryId: 'cat-1' });
    const t2 = makeTransaction({ id: 'txn-2', categoryId: 'cat-2' });
    const t3 = makeTransaction({ id: 'txn-3', categoryId: null, linkedDebtId: null, linkedGoalId: null });
    const db = createDbDouble({ transactions: [t1, t2, t3] });
    await assert.rejects(
      () => bulkMarkTransactionsReviewed({
        db, householdId: 'hh-1', transactionIds: ['txn-1', 'txn-2', 'txn-3'], userId: 'user-abc',
      }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 409);
        return true;
      },
    );
    // None should be written
    assert.equal(db.state.transactions.find((t) => t.id === 'txn-1').reviewedAt, null);
    assert.equal(db.state.transactions.find((t) => t.id === 'txn-2').reviewedAt, null);
  });

  it('20. bulk rejects missing actor (userId null) with 400', async () => {
    const txn = makeTransaction({ categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [txn] });
    await assert.rejects(
      () => bulkMarkTransactionsReviewed({
        db, householdId: 'hh-1', transactionIds: ['txn-1'], userId: null,
      }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  it('21. bulk enforces 50-transaction limit', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `txn-${i}`);
    const db = createDbDouble({ transactions: [] });
    await assert.rejects(
      () => bulkMarkTransactionsReviewed({ db, householdId: 'hh-1', transactionIds: ids, userId: 'user-abc' }),
      (err) => {
        assert.ok(err instanceof TransactionReviewError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  it('22. bulk deduplicates duplicate IDs in input', async () => {
    const t1 = makeTransaction({ id: 'txn-1', categoryId: 'cat-1' });
    const db = createDbDouble({ transactions: [t1] });
    const result = await bulkMarkTransactionsReviewed({
      db, householdId: 'hh-1', transactionIds: ['txn-1', 'txn-1', 'txn-1'], userId: 'user-abc',
    });
    assert.deepEqual(result.reviewedIds, ['txn-1']);
    assert.ok(result.reviewedAt);
  });
});

// ─── 5. Financial non-mutation gate ──────────────────────────────────────────

describe('financial non-mutation proof', () => {
  it('review does not mutate financial fields (amount, direction, categoryId, linkedDebtId, linkedGoalId)', async () => {
    const original = makeTransaction({
      amount: '200.00',
      direction: 'debit',
      categoryId: 'cat-original',
      linkedDebtId: 'debt-original',
      linkedGoalId: null,
    });
    const db = createDbDouble({ transactions: [original] });
    const result = await markTransactionReviewed({ db, householdId: 'hh-1', transactionId: 'txn-1', userId: 'user-abc' });
    assert.equal(result.amount, '200.00');
    assert.equal(result.direction, 'debit');
    assert.equal(result.categoryId, 'cat-original');
    assert.equal(result.linkedDebtId, 'debt-original');
    assert.equal(result.linkedGoalId, null);
  });
});
