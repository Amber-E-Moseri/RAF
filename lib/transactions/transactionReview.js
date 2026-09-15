export class TransactionReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TransactionReviewError';
    this.status = status;
  }
}

function isoNow() {
  return new Date().toISOString();
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Transaction review DB adapter must implement transaction().');
  }
}

/**
 * Server-side eligibility check. Returns { eligible, reasons }.
 * Does NOT persist anything.
 *
 * Rules:
 *   - debt payment (debit + linkedDebtId)  → always eligible
 *   - credit transaction                   → always eligible
 *   - goal-funded debit (linkedGoalId)     → always eligible
 *   - split parent (splits present)        → eligible only if every split has a categoryId AND split total = parent amount
 *   - ordinary debit spending              → eligible only if categoryId is set
 */
export function deriveReviewEligibility(transaction, splits = []) {
  const reasons = [];

  if (Array.isArray(splits) && splits.length > 0) {
    if (splits.some((s) => !s.categoryId)) {
      reasons.push('unresolved_split');
    }
    // Defense-in-depth: split totals should be conserved at write time, but verify here too.
    const splitTotal = splits.reduce((sum, s) => sum + parseFloat(s.amount), 0);
    if (Math.abs(splitTotal - parseFloat(transaction.amount)) > 0.001) {
      reasons.push('invalid_split_total');
    }
    return { eligible: reasons.length === 0, reasons };
  }

  if (transaction.linkedDebtId) {
    return { eligible: true, reasons: [] };
  }

  if (transaction.direction === 'credit') {
    return { eligible: true, reasons: [] };
  }

  if (transaction.linkedGoalId) {
    return { eligible: true, reasons: [] };
  }

  if (!transaction.categoryId) {
    reasons.push('unresolved_category');
  }

  return { eligible: reasons.length === 0, reasons };
}

function formatReviewedTransaction(t) {
  return {
    id: t.id,
    transactionDate: t.transactionDate,
    description: t.description,
    merchant: t.merchant ?? null,
    amount: t.amount,
    direction: t.direction,
    categoryId: t.categoryId ?? null,
    linkedDebtId: t.linkedDebtId ?? null,
    linkedGoalId: t.linkedGoalId ?? null,
    source: t.source ?? 'manual',
    reviewedAt: t.reviewedAt ?? null,
    reviewedBy: t.reviewedBy ?? null,
  };
}

async function loadSplits(tx, householdId, transactionId) {
  if (typeof tx.listTransactionSplits !== 'function') {
    return [];
  }
  return tx.listTransactionSplits({ householdId, transactionId });
}

export async function markTransactionReviewed({ db, householdId, transactionId, userId }) {
  if (!householdId) throw new TransactionReviewError(400, 'householdId is required');
  if (!transactionId) throw new TransactionReviewError(400, 'transactionId is required');
  if (!userId) throw new TransactionReviewError(400, 'reviewer identity is required');
  requireDbContract(db);

  return db.transaction(async (tx) => {
    const transaction = await tx.getTransactionById({ householdId, transactionId });
    if (!transaction) throw new TransactionReviewError(404, 'transaction not found');

    const splits = await loadSplits(tx, householdId, transactionId);
    const { eligible, reasons } = deriveReviewEligibility(transaction, splits);
    if (!eligible) {
      throw new TransactionReviewError(409, `transaction cannot be marked reviewed: ${reasons.join(', ')}`);
    }

    const reviewedAt = isoNow();
    const updated = await tx.markTransactionReviewed({ householdId, transactionId, reviewedAt, reviewedBy: userId });
    return formatReviewedTransaction(updated ?? { ...transaction, reviewedAt, reviewedBy: userId });
  });
}

export async function markTransactionUnreviewed({ db, householdId, transactionId }) {
  if (!householdId) throw new TransactionReviewError(400, 'householdId is required');
  if (!transactionId) throw new TransactionReviewError(400, 'transactionId is required');
  requireDbContract(db);

  return db.transaction(async (tx) => {
    const transaction = await tx.getTransactionById({ householdId, transactionId });
    if (!transaction) throw new TransactionReviewError(404, 'transaction not found');

    const updated = await tx.markTransactionUnreviewed({ householdId, transactionId });
    return formatReviewedTransaction(updated ?? { ...transaction, reviewedAt: null, reviewedBy: null });
  });
}

/**
 * Atomically mark a batch of transactions reviewed.
 * ALL-OR-NOTHING: rejects entire batch if any transaction is not found,
 * cross-workspace, or ineligible. Preflight validates all before writing any.
 */
export async function bulkMarkTransactionsReviewed({ db, householdId, transactionIds, userId }) {
  if (!householdId) throw new TransactionReviewError(400, 'householdId is required');
  if (!userId) throw new TransactionReviewError(400, 'reviewer identity is required');
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    throw new TransactionReviewError(400, 'transactionIds must be a non-empty array');
  }

  const uniqueIds = [...new Set(transactionIds)];
  if (uniqueIds.length > 50) {
    throw new TransactionReviewError(400, 'bulk review limited to 50 transactions');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    // Phase 1: load all — getTransactionById scopes to householdId, so null = not found or cross-workspace
    const loaded = await Promise.all(
      uniqueIds.map((id) => tx.getTransactionById({ householdId, transactionId: id })),
    );

    const crossIdx = loaded.findIndex((t) => !t);
    if (crossIdx !== -1) {
      throw new TransactionReviewError(
        404,
        `transaction not found or does not belong to workspace: ${uniqueIds[crossIdx]}`,
      );
    }

    // Phase 2: validate eligibility for all before writing any
    for (const transaction of loaded) {
      const splits = await loadSplits(tx, householdId, transaction.id);
      const { eligible, reasons } = deriveReviewEligibility(transaction, splits);
      if (!eligible) {
        throw new TransactionReviewError(
          409,
          `transaction ${transaction.id} cannot be marked reviewed: ${reasons.join(', ')}`,
        );
      }
    }

    // Phase 3: write all atomically
    const reviewedAt = isoNow();
    if (typeof tx.bulkMarkTransactionsReviewed === 'function') {
      await tx.bulkMarkTransactionsReviewed({ householdId, transactionIds: uniqueIds, reviewedAt, reviewedBy: userId });
    } else {
      for (const transactionId of uniqueIds) {
        await tx.markTransactionReviewed({ householdId, transactionId, reviewedAt, reviewedBy: userId });
      }
    }

    return { reviewedIds: uniqueIds, reviewedAt };
  });
}
