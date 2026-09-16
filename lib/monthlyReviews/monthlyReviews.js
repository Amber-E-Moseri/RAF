import { logAuditEvent } from '../audit/auditLog.js';
import { computeMonthlyReviewSnapshot, monthStart, unwrapRows } from '../raf/reporting.js';
import {
  MonthlyReviewHttpError,
  normalizeOptionalNotes,
  normalizeReviewMonth,
  requireDbContract,
} from './shared.js';

export { MonthlyReviewHttpError } from './shared.js';

function formatTransaction(transaction) {
  return {
    id: transaction.id,
    transactionDate: transaction.transactionDate,
    description: transaction.description,
    merchant: transaction.merchant ?? null,
    amount: transaction.amount,
    direction: transaction.direction,
    categoryId: transaction.categoryId ?? null,
    linkedDebtId: transaction.linkedDebtId ?? null,
  };
}

export async function listMonthlyReviews({ db, householdId, from, to }) {
  if (!householdId) {
    throw new MonthlyReviewHttpError(400, 'householdId is required');
  }

  requireDbContract(db);

  let normalizedFrom;
  let normalizedTo;
  if (from != null || to != null) {
    try {
      normalizedFrom = from != null ? monthStart(from) : undefined;
      normalizedTo = to != null ? monthStart(to) : undefined;
    } catch {
      throw new MonthlyReviewHttpError(400, 'from and to must be valid ISO dates');
    }
  }

  return db.transaction(async (tx) => ({
    items: await tx.listMonthlyReviews({
      householdId,
      from: normalizedFrom,
      to: normalizedTo,
    }),
  }));
}

export async function createMonthlyReview({ db, householdId, input }) {
  if (!householdId) {
    throw new MonthlyReviewHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const reviewMonth = normalizeReviewMonth(input?.reviewMonth);
  const notes = normalizeOptionalNotes(input?.notes);

  return db.transaction(async (tx) => {
    const existing = await tx.getMonthlyReviewByMonth({ householdId, reviewMonth });
    if (existing) {
      throw new MonthlyReviewHttpError(409, 'monthly review already exists for that month');
    }

    const [incomeEntries, transactions, debtPayments, surplusSplitRules] = await Promise.all([
      tx.listIncomeEntries({ householdId, from: reviewMonth, to: reviewMonth }),
      tx.listTransactions({ householdId, from: reviewMonth, to: reviewMonth }),
      tx.listDebtPayments({ householdId, from: reviewMonth, to: reviewMonth }),
      tx.listSurplusSplitRules({ householdId }),
    ]);

    const snapshot = computeMonthlyReviewSnapshot({
      reviewMonth,
      incomeEntries,
      transactions: unwrapRows(transactions),
      debtPayments,
      surplusSplitRules,
    });

    return tx.insertMonthlyReview({
      householdId,
      reviewMonth: snapshot.reviewMonth,
      netSurplus: snapshot.netSurplus,
      splitApplied: snapshot.splitApplied,
      distributions: snapshot.distributions,
      alertStatus: snapshot.alertStatus,
      notes,
    });
  });
}

export async function updateMonthlyReview({ db, householdId, reviewId, input }) {
  if (!householdId) {
    throw new MonthlyReviewHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const notes = normalizeOptionalNotes(input?.notes);

  return db.transaction(async (tx) => {
    const existing = await tx.getMonthlyReviewById({ householdId, reviewId });
    if (!existing) {
      throw new MonthlyReviewHttpError(404, 'monthly review not found');
    }

    return tx.updateMonthlyReview({
      householdId,
      reviewId,
      patch: { notes },
    });
  });
}

export async function deleteMonthlyReview({ db, householdId, reviewId, userId }) {
  if (!householdId) {
    throw new MonthlyReviewHttpError(400, 'householdId is required');
  }

  if (!reviewId) {
    throw new MonthlyReviewHttpError(400, 'reviewId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const existing = await tx.getMonthlyReviewById({ householdId, reviewId });
    if (!existing) {
      throw new MonthlyReviewHttpError(404, 'monthly review not found');
    }

    const transactions = unwrapRows(await tx.listTransactions({
      householdId,
      from: existing.reviewMonth,
      to: existing.reviewMonth,
    }));

    const revertedTransactions = transactions
      .filter((transaction) => (
        transaction.transactionDate === existing.reviewMonth
        && typeof transaction.description === 'string'
        && transaction.description.startsWith('Monthly review allocation: ')
      ))
      .map(formatTransaction);

    for (const transaction of revertedTransactions) {
      await tx.deleteDebtPaymentByTransactionId({
        householdId,
        transactionId: transaction.id,
      });

      await tx.deleteTransaction({
        householdId,
        transactionId: transaction.id,
      });
    }

    await tx.deleteMonthlyReview({
      householdId,
      reviewId,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'monthly_review.deleted',
      entityId: reviewId,
    });

    return {
      review: existing,
      revertedTransactions,
    };
  });
}
