import { z } from 'zod';
import { parseMoneyToCents } from '../raf/reporting.js';

const splitRowSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'amount must be a positive decimal'),
  categoryId: z.string().nullable().optional(),
  description: z.string().default(''),
  linkedGoalId: z.string().nullable().optional().default(null),
});

const setSplitsSchema = z.object({
  splits: z.array(splitRowSchema).min(2, 'a split requires at least two rows'),
});

export class TransactionSplitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TransactionSplitError';
    this.status = status;
  }
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Transaction split DB adapter must implement transaction().');
  }
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : (rows?.items ?? []);
}

async function ensureSplitCategoriesBelongToWorkspace({ tx, householdId, splits }) {
  const categoryIds = [...new Set(splits.map((split) => split.categoryId).filter(Boolean))];
  if (categoryIds.length === 0) {
    return;
  }

  if (typeof tx.listAllocationCategories !== 'function') {
    throw new TransactionSplitError('Split category ownership cannot be verified', 500);
  }

  const categories = normalizeRows(await tx.listAllocationCategories({ householdId, includeSuperseded: true }));
  const workspaceCategoryIds = new Set(categories.map((category) => category.id));
  const invalidCategoryId = categoryIds.find((categoryId) => !workspaceCategoryIds.has(categoryId));
  if (invalidCategoryId) {
    throw new TransactionSplitError(`Split category does not belong to this workspace: ${invalidCategoryId}`, 422);
  }
}

async function ensureSplitGoalsBelongToWorkspace({ tx, householdId, splits }) {
  const goalIds = [...new Set(splits.map((split) => split.linkedGoalId).filter(Boolean))];
  if (goalIds.length === 0) {
    return;
  }

  if (typeof tx.getGoalById !== 'function') {
    throw new TransactionSplitError('Split goal ownership cannot be verified', 500);
  }

  for (const goalId of goalIds) {
    const goal = await tx.getGoalById({ householdId, goalId });
    if (!goal) {
      throw new TransactionSplitError(`Split goal does not belong to this workspace: ${goalId}`, 422);
    }

    if (goal.active === false) {
      throw new TransactionSplitError(`Cannot attribute split to an inactive goal: ${goalId}`, 422);
    }

    const splitsForGoal = splits.filter((split) => split.linkedGoalId === goalId && split.categoryId);
    for (const split of splitsForGoal) {
      const bucketId = goal.bucketId ?? goal.bucket_id;
      if (bucketId && split.categoryId !== bucketId) {
        throw new TransactionSplitError(
          `Split goal ${goalId} bucket does not match split category ${split.categoryId}`,
          422,
        );
      }
    }
  }
}

export async function listTransactionSplits({ db, householdId, transactionId }) {
  if (!householdId) {
    throw new TransactionSplitError('householdId is required');
  }
  if (!transactionId) {
    throw new TransactionSplitError('transactionId is required');
  }

  requireDbContract(db);
  return db.transaction(async (tx) => {
    const transaction = await tx.getTransactionById({ householdId, transactionId });
    if (!transaction) {
      throw new TransactionSplitError('Transaction not found', 404);
    }
    if (typeof tx.listTransactionSplits !== 'function') {
      return [];
    }
    return tx.listTransactionSplits({ householdId, transactionId });
  });
}

/**
 * Replace all splits for a transaction atomically.
 *
 * Invariant enforced: sum(split.amount) must exactly equal the canonical
 * transaction amount. There is no implicit remainder.
 *
 * Calling setTransactionSplits with an empty splits array is rejected;
 * use clearTransactionSplits to remove all splits.
 */
export async function setTransactionSplits({ db, householdId, transactionId, splits }) {
  if (!householdId) {
    throw new TransactionSplitError('householdId is required');
  }
  if (!transactionId) {
    throw new TransactionSplitError('transactionId is required');
  }

  requireDbContract(db);
  const parsed = setSplitsSchema.safeParse({ splits });
  if (!parsed.success) {
    throw new TransactionSplitError(parsed.error.issues[0]?.message ?? 'Invalid splits');
  }

  return db.transaction(async (tx) => {
    const transaction = await tx.getTransactionById({ householdId, transactionId });
    if (!transaction) {
      throw new TransactionSplitError('Transaction not found', 404);
    }
    if (transaction.direction !== 'debit') {
      throw new TransactionSplitError('Only debit transactions may be split');
    }

    const canonicalCents = parseMoneyToCents(transaction.amount);
    const splitCents = parsed.data.splits.reduce(
      (sum, row) => sum + parseMoneyToCents(row.amount),
      0,
    );
    if (splitCents !== canonicalCents) {
      throw new TransactionSplitError(
        `Split total (${splitCents} cents) must equal transaction amount (${canonicalCents} cents)`,
      );
    }

    await ensureSplitCategoriesBelongToWorkspace({ tx, householdId, splits: parsed.data.splits });
    await ensureSplitGoalsBelongToWorkspace({ tx, householdId, splits: parsed.data.splits });
    await tx.deleteTransactionSplits({ householdId, transactionId });
    const rows = await Promise.all(
      parsed.data.splits.map((row) =>
        tx.insertTransactionSplit({
          householdId,
          transactionId,
          amount: row.amount,
          categoryId: row.categoryId ?? null,
          description: row.description,
          linkedGoalId: row.linkedGoalId ?? null,
        }),
      ),
    );
    return rows;
  });
}

/**
 * Remove all splits for a transaction, reverting to parent-level attribution.
 */
export async function clearTransactionSplits({ db, householdId, transactionId }) {
  if (!householdId) {
    throw new TransactionSplitError('householdId is required');
  }
  if (!transactionId) {
    throw new TransactionSplitError('transactionId is required');
  }

  requireDbContract(db);
  return db.transaction(async (tx) => {
    const transaction = await tx.getTransactionById({ householdId, transactionId });
    if (!transaction) {
      throw new TransactionSplitError('Transaction not found', 404);
    }
    await tx.deleteTransactionSplits({ householdId, transactionId });
  });
}

/**
 * Build a Map<transactionId, SplitRow[]> from a flat split list.
 * Used by reporting functions to resolve split attribution in-process.
 */
export function indexSplitsByTransactionId(splits) {
  const map = new Map();
  for (const split of splits) {
    const key = split.transactionId;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(split);
  }
  return map;
}
