import { z } from 'zod';

import { logAuditEvent } from '../audit/auditLog.js';
import { computeMonthlyReviewSnapshot, parseMoneyToCents, unwrapRows } from '../raf/reporting.js';
import {
  MonthlyReviewHttpError,
  normalizeOptionalNotes,
  normalizeReviewMonth,
  requireDbContract,
} from './shared.js';

const applyMonthlyReviewSchema = z.object({
  reviewMonth: z.string().trim().min(1, 'reviewMonth is required'),
  notes: z.union([z.string(), z.null(), z.undefined()]).optional(),
  splitOverride: z.array(z.object({
    slug: z.string().trim().min(1, 'slug is required'),
    label: z.string().trim().min(1, 'label is required'),
    splitPercent: z.string().trim().min(1, 'splitPercent is required'),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    destinationType: z.enum(['bucket', 'goal', 'debt']),
    destinationBucketSlug: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value == null ? null : value.trim() || null),
    destinationGoalId: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value == null ? null : value.trim() || null),
    destinationDebtId: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value == null ? null : value.trim() || null),
  })).optional(),
});

function parseWithSchema(input) {
  const result = applyMonthlyReviewSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
    throw new MonthlyReviewHttpError(400, `${path} ${issue.message}`);
  }

  return result.data;
}

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

function resolveGoalBucketSlug(goal, allocationCategories) {
  const goalBucketId = goal.bucketId ?? goal.bucket_id ?? null;
  if (!goalBucketId) {
    return null;
  }

  const category = allocationCategories.find((item) => item.id === goalBucketId) ?? null;
  return category?.slug ?? null;
}

function buildAllocationTransactions({ reviewMonth, distributions, surplusSplitRules, allocationCategories, goals = [], debts = [] }) {
  const categoriesBySlug = new Map(allocationCategories.map((category) => [category.slug, category]));
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const debtsById = new Map(debts.map((debt) => [debt.id, debt]));

  return [...surplusSplitRules]
    .filter((rule) => rule.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((rule) => {
      const amount = distributions[rule.slug] ?? '0.00';
      const cents = parseMoneyToCents(amount);
      if (cents <= 0) {
        return null;
      }

      const destinationType = rule.destinationType ?? 'bucket';
      const linkedGoal = destinationType === 'goal' && rule.destinationGoalId
        ? goalsById.get(rule.destinationGoalId) ?? null
        : null;
      const linkedDebt = destinationType === 'debt' && rule.destinationDebtId
        ? debtsById.get(rule.destinationDebtId) ?? null
        : null;
      const bucketSlug = destinationType === 'bucket'
        ? (rule.destinationBucketSlug ?? null)
        : linkedGoal
          ? resolveGoalBucketSlug(linkedGoal, allocationCategories)
          : destinationType === 'debt'
            ? 'debt_payoff'
            : null;
      const category = bucketSlug ? (categoriesBySlug.get(bucketSlug) ?? null) : null;

      if (destinationType === 'bucket' && !category) {
        throw new MonthlyReviewHttpError(422, `surplus destination bucket ${rule.destinationBucketSlug ?? '(missing)'} is unavailable`);
      }

      if (destinationType === 'goal') {
        if (!linkedGoal) {
          throw new MonthlyReviewHttpError(422, `surplus destination goal ${rule.destinationGoalId ?? '(missing)'} is unavailable`);
        }

        if (!category) {
          throw new MonthlyReviewHttpError(422, `goal ${linkedGoal.name ?? linkedGoal.id} is not linked to an active allocation bucket`);
        }
      }

      if (destinationType === 'debt') {
        if (!linkedDebt) {
          throw new MonthlyReviewHttpError(422, `surplus destination debt ${rule.destinationDebtId ?? '(missing)'} is unavailable`);
        }

        if (!category) {
          throw new MonthlyReviewHttpError(422, 'debt payoff bucket is unavailable for surplus allocation');
        }
      }

      return {
        transactionDate: reviewMonth,
        description: `Monthly review allocation: ${rule.label ?? rule.slug}`,
        merchant: null,
        amount,
        direction: 'debit',
        categoryId: category?.id ?? null,
        linkedDebtId: linkedDebt?.id ?? null,
        linkedGoalId: linkedGoal?.id ?? null,
        source: 'manual',
      };
    })
    .filter(Boolean);
}

export async function applyMonthlyReview({ db, householdId, userId, input }) {
  if (!householdId) {
    throw new MonthlyReviewHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(input);
  const reviewMonth = normalizeReviewMonth(parsedInput.reviewMonth);
  const notes = normalizeOptionalNotes(parsedInput.notes);
  const splitOverride = parsedInput.splitOverride ?? null;

  return db.transaction(async (tx) => {
    const existing = await tx.getMonthlyReviewByMonth({ householdId, reviewMonth });
    if (existing) {
      throw new MonthlyReviewHttpError(409, 'monthly review already exists for that month');
    }

    const [incomeEntries, transactions, debtPayments, surplusSplitRules, allocationCategories, goals, debts] = await Promise.all([
      tx.listIncomeEntries({ householdId, from: reviewMonth, to: reviewMonth }),
      tx.listTransactions({ householdId, from: reviewMonth, to: reviewMonth }),
      tx.listDebtPayments({ householdId, from: reviewMonth, to: reviewMonth }),
      tx.listSurplusSplitRules({ householdId }),
      tx.listAllocationCategories({ householdId, asOf: reviewMonth }),
      typeof tx.listGoals === 'function' ? tx.listGoals({ householdId }) : [],
      typeof tx.listDebts === 'function' ? tx.listDebts({ householdId }) : [],
    ]);

    const snapshot = computeMonthlyReviewSnapshot({
      reviewMonth,
      incomeEntries,
      transactions: unwrapRows(transactions),
      debtPayments,
      surplusSplitRules: splitOverride ?? surplusSplitRules,
    });

    const review = await tx.insertMonthlyReview({
      householdId,
      reviewMonth: snapshot.reviewMonth,
      netSurplus: snapshot.netSurplus,
      splitApplied: snapshot.splitApplied,
      distributions: snapshot.distributions,
      alertStatus: snapshot.alertStatus,
      notes,
    });

    const appliedTransactions = [];
    if (parseMoneyToCents(snapshot.netSurplus) > 0) {
      const plannedTransactions = buildAllocationTransactions({
        reviewMonth: snapshot.reviewMonth,
        distributions: snapshot.distributions,
        surplusSplitRules: splitOverride ?? surplusSplitRules,
        allocationCategories,
        goals,
        debts,
      });

      for (const plannedTransaction of plannedTransactions) {
        const created = await tx.insertTransaction({
          householdId,
          ...plannedTransaction,
        });
        if (created.linkedDebtId) {
          await tx.insertDebtPayment({
            householdId,
            debtId: created.linkedDebtId,
            transactionId: created.id,
            paymentDate: created.transactionDate,
            amount: created.amount,
          });
        }
        appliedTransactions.push(formatTransaction(created));
      }
    }

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'monthly_review.applied',
      entityId: review.id,
    });

    return {
      review,
      appliedTransactions,
    };
  });
}

export const __internal = {
  applyMonthlyReviewSchema,
  buildAllocationTransactions,
};
