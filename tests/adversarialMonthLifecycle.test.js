import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import {
  createMonthlyReview,
  updateMonthlyReview,
  deleteMonthlyReview,
  listMonthlyReviews,
  MonthlyReviewHttpError,
} from '../lib/monthlyReviews/monthlyReviews.js';

const HH_A = 'household_p6_lifecycle_a';
const HH_B = 'household_p6_lifecycle_b';

async function insertAllocationTx(db, householdId, transactionDate) {
  return db.transaction(async (tx) => {
    return tx.insertTransaction({
      householdId,
      transactionDate,
      description: 'Monthly review allocation: savings',
      amount: '100.00',
      direction: 'debit',
      categoryId: null,
      source: 'review',
    });
  });
}

// ─── Section 1: Basic CRUD Lifecycle ──────────────────────────────────────────

test('1.1 — createMonthlyReview creates a review for a given month', async () => {
  const db = createInMemoryDb();
  const review = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-01-01' },
  });
  assert.ok(review.id, 'Review was created with an id');
  assert.ok(String(review.reviewMonth).startsWith('2026-01'), 'Review month is 2026-01');
});

test('1.2 — createMonthlyReview throws 400 for mid-month reviewMonth (not first of month)', async () => {
  const db = createInMemoryDb();
  const err = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-02-17' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Throws MonthlyReviewHttpError');
  assert.strictEqual(err.status, 400, 'HTTP 400 — reviewMonth must be first of month');
});

test('1.3 — updateMonthlyReview updates notes on an existing review', async () => {
  const db = createInMemoryDb();
  const created = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-03-01' },
  });
  const updated = await updateMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: created.id,
    input: { notes: 'Tight month.' },
  });
  assert.ok(updated, 'Update returned a result');
});

test('1.4 — deleteMonthlyReview removes the review and it no longer appears in list', async () => {
  const db = createInMemoryDb();
  const created = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-04-01' },
  });
  const result = await deleteMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: created.id,
  });
  assert.ok(result.review, 'Deleted review returned in result');
  const { items } = await listMonthlyReviews({ db, householdId: HH_A });
  assert.strictEqual(items.length, 0, 'No reviews remain after delete');
});

test('1.5 — listMonthlyReviews returns all reviews for the household', async () => {
  const db = createInMemoryDb();
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-01-01' } });
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-02-01' } });
  const { items } = await listMonthlyReviews({ db, householdId: HH_A });
  assert.strictEqual(items.length, 2, 'Both reviews returned');
});

// ─── Section 2: Duplicate Prevention ──────────────────────────────────────────

test('2.1 — createMonthlyReview throws 409 when a review for the same month already exists', async () => {
  const db = createInMemoryDb();
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-05-01' } });
  const err = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-05-01' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Throws MonthlyReviewHttpError');
  assert.strictEqual(err.status, 409, 'HTTP 409 — duplicate month review');
});

test('2.2 — createMonthlyReview throws 400 when reviewMonth is missing', async () => {
  const db = createInMemoryDb();
  const err = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: {},
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Throws MonthlyReviewHttpError');
  assert.strictEqual(err.status, 400, 'HTTP 400 — reviewMonth required');
});

// ─── Section 3: Missing Required Input ────────────────────────────────────────

test('3.1 — createMonthlyReview throws 400 when householdId is empty', async () => {
  const db = createInMemoryDb();
  const err = await createMonthlyReview({
    db,
    householdId: '',
    input: { reviewMonth: '2026-01-01' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Throws MonthlyReviewHttpError');
  assert.strictEqual(err.status, 400, 'HTTP 400 — householdId required');
});

test('3.2 — updateMonthlyReview throws 404 for non-existent reviewId', async () => {
  const db = createInMemoryDb();
  const err = await updateMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: 'review_nonexistent_00001',
    input: { notes: 'test' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Throws MonthlyReviewHttpError');
  assert.strictEqual(err.status, 404, 'HTTP 404 — review not found');
});

test('3.3 — deleteMonthlyReview throws 400 when reviewId is empty', async () => {
  const db = createInMemoryDb();
  const err = await deleteMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: '',
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Throws MonthlyReviewHttpError');
  assert.strictEqual(err.status, 400, 'HTTP 400 — reviewId required');
});

// ─── Section 4: Tenant Isolation ──────────────────────────────────────────────

test('4.1 — Household A reviews are not visible to household B', async () => {
  const db = createInMemoryDb();
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-07-01' } });
  const { items } = await listMonthlyReviews({ db, householdId: HH_B });
  assert.strictEqual(items.length, 0, 'SECURITY_DEFECT: Household B must not see Household A reviews');
});

test('4.2 — deleteMonthlyReview for another household\'s review returns 404', async () => {
  const db = createInMemoryDb();
  const reviewA = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-08-01' },
  });
  const err = await deleteMonthlyReview({
    db,
    householdId: HH_B,
    reviewId: reviewA.id,
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Cross-tenant delete must throw');
  assert.strictEqual(err.status, 404, 'SECURITY_DEFECT: cross-tenant reviewId returns 404');
});

test('4.3 — updateMonthlyReview for another household\'s review returns 404', async () => {
  const db = createInMemoryDb();
  const reviewA = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth: '2026-09-01' },
  });
  const err = await updateMonthlyReview({
    db,
    householdId: HH_B,
    reviewId: reviewA.id,
    input: { notes: 'should not apply' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError, 'Cross-tenant update must throw');
  assert.strictEqual(err.status, 404, 'SECURITY_DEFECT: cross-tenant reviewId returns 404');
});

// ─── Section 5: Delete Reverts Allocation Transactions ────────────────────────

test('5.1 — deleteMonthlyReview reverts "Monthly review allocation: " transactions', async () => {
  const db = createInMemoryDb();
  const reviewMonth = '2026-10-01';
  const review = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth },
  });
  await insertAllocationTx(db, HH_A, reviewMonth);
  const result = await deleteMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: review.id,
  });
  assert.ok(Array.isArray(result.revertedTransactions), 'revertedTransactions is an array');
  assert.strictEqual(result.revertedTransactions.length, 1, 'One allocation transaction reverted');
});

test('5.2 — deleteMonthlyReview does NOT revert regular (non-allocation) transactions', async () => {
  const db = createInMemoryDb();
  const reviewMonth = '2026-11-01';
  const review = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth },
  });
  await db.transaction(async (tx) => {
    return tx.insertTransaction({
      householdId: HH_A,
      transactionDate: reviewMonth,
      description: 'Grocery purchase',
      amount: '45.00',
      direction: 'debit',
      categoryId: null,
      source: 'manual',
    });
  });
  const result = await deleteMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: review.id,
  });
  assert.strictEqual(result.revertedTransactions.length, 0, 'Regular transactions must NOT be reverted');
});

test('5.3 — deleteMonthlyReview reverts allocation but preserves other transactions', async () => {
  const db = createInMemoryDb();
  const reviewMonth = '2026-12-01';
  const review = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth },
  });
  await insertAllocationTx(db, HH_A, reviewMonth);
  await db.transaction(async (tx) => {
    return tx.insertTransaction({
      householdId: HH_A,
      transactionDate: reviewMonth,
      description: 'Grocery purchase',
      amount: '60.00',
      direction: 'debit',
      categoryId: null,
      source: 'manual',
    });
  });

  const result = await deleteMonthlyReview({
    db,
    householdId: HH_A,
    reviewId: review.id,
  });
  assert.strictEqual(result.revertedTransactions.length, 1, 'Only the allocation transaction was reverted');

  const { items: remaining } = await db.transaction(async (tx) =>
    tx.listTransactions({ householdId: HH_A, from: reviewMonth, to: reviewMonth }),
  );
  const descriptions = remaining.map((t) => t.description);
  assert.ok(descriptions.includes('Grocery purchase'), 'Grocery transaction survives delete');
  assert.ok(!descriptions.includes('Monthly review allocation: savings'), 'Allocation transaction was removed');
});

// ─── Section 6: Date Range Filtering ──────────────────────────────────────────

test('6.1 — listMonthlyReviews with from/to filters by date range', async () => {
  const db = createInMemoryDb();
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-01-01' } });
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-06-01' } });
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-12-01' } });

  const { items } = await listMonthlyReviews({
    db,
    householdId: HH_A,
    from: '2026-01-01',
    to: '2026-06-01',
  });
  assert.strictEqual(items.length, 2, 'Only Jan and Jun returned for Jan–Jun range');
});

test('6.2 — listMonthlyReviews without filter returns all reviews', async () => {
  const db = createInMemoryDb();
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-01-01' } });
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-06-01' } });
  await createMonthlyReview({ db, householdId: HH_A, input: { reviewMonth: '2026-12-01' } });

  const { items } = await listMonthlyReviews({ db, householdId: HH_A });
  assert.strictEqual(items.length, 3, 'All three reviews returned without filter');
});

// ─── Section 7: Review Snapshot Immutability ──────────────────────────────────

test('7.1 — Snapshot fields are recorded at review creation time and do not change automatically', async () => {
  const db = createInMemoryDb();
  const reviewMonth = '2026-01-01';

  const review = await createMonthlyReview({
    db,
    householdId: HH_A,
    input: { reviewMonth },
  });
  const originalNetSurplus = review.netSurplus;

  // Insert a transaction AFTER the review is created
  await db.transaction(async (tx) => {
    return tx.insertTransaction({
      householdId: HH_A,
      transactionDate: '2026-01-20',
      description: 'Late-arriving transaction',
      amount: '500.00',
      direction: 'debit',
      categoryId: null,
      source: 'manual',
    });
  });

  // Re-fetch the review — its snapshot should be unchanged
  const { items } = await listMonthlyReviews({ db, householdId: HH_A });
  const fetched = items.find((r) => r.id === review.id);
  assert.ok(fetched, 'Review is still present');
  assert.strictEqual(
    fetched.netSurplus,
    originalNetSurplus,
    'Snapshot netSurplus must NOT auto-update when a new transaction is added',
  );
});
