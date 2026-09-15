import { parseMoneyToCents } from '../raf/reporting.js';
import { indexSplitsByTransactionId } from '../transactions/transactionSplits.js';

function buildActiveBucketContext({ buckets, categoryLookupById = new Map() }) {
  const activeBucketIdBySlug = new Map(buckets.map((bucket) => [bucket.slug, bucket.id]));
  const activeBucketById = new Map(buckets.map((bucket) => [bucket.id, bucket]));

  function resolveActiveBucketId(bucketId) {
    if (!bucketId) {
      return null;
    }

    if (activeBucketById.has(bucketId)) {
      return bucketId;
    }

    const originalBucket = categoryLookupById.get(bucketId) ?? null;
    if (!originalBucket?.slug) {
      return null;
    }

    return activeBucketIdBySlug.get(originalBucket.slug) ?? null;
  }

  return {
    resolveActiveBucketId,
  };
}

/**
 * Build a Map<bucketId, reservedCents> for all active goals.
 *
 * Attribution precedence (mirrors sumGoalLinkedTransactionCents in goals.js):
 *  1. Transactions with splits: use split.linkedGoalId amounts (not the parent).
 *  2. Transactions without splits: use transaction.linkedGoalId.
 *
 * @param {object} params
 * @param {Array} params.goals
 * @param {Array} params.buckets
 * @param {Array} params.transactions
 * @param {Array} [params.importedTransactions]
 * @param {Map<string,object>} [params.categoryLookupById]
 * @param {Map<string,Array>} [params.splitsByTransactionId] — from indexSplitsByTransactionId()
 */
export function buildGoalReservedByBucketId({
  goals,
  buckets,
  transactions,
  importedTransactions = [],
  categoryLookupById = new Map(),
  splitsByTransactionId = new Map(),
}) {
  const activeGoals = goals.filter((goal) => goal.active !== false);
  const activeGoalIds = new Set(activeGoals.map((goal) => goal.id));
  const { resolveActiveBucketId } = buildActiveBucketContext({ buckets, categoryLookupById });
  const bucketIdByGoalId = new Map(
    activeGoals.map((goal) => [goal.id, resolveActiveBucketId(goal.bucketId ?? goal.bucket_id ?? null)]),
  );
  const reservedByBucketId = new Map(buckets.map((bucket) => [bucket.id, 0]));
  const countedTransactionIds = new Set();

  for (const transaction of transactions) {
    const splits = splitsByTransactionId.get(transaction.id) ?? [];

    if (splits.length > 0) {
      // Splits take precedence — attribute by split.linkedGoalId.
      countedTransactionIds.add(transaction.id);
      for (const split of splits) {
        if (!split.linkedGoalId || !activeGoalIds.has(split.linkedGoalId)) continue;
        const bucketId = bucketIdByGoalId.get(split.linkedGoalId);
        if (!bucketId || !reservedByBucketId.has(bucketId)) continue;
        const amountCents = Math.abs(parseMoneyToCents(split.amount ?? '0.00'));
        reservedByBucketId.set(bucketId, reservedByBucketId.get(bucketId) + amountCents);
      }
      continue;
    }

    if (!transaction.linkedGoalId || !activeGoalIds.has(transaction.linkedGoalId)) {
      continue;
    }

    const bucketId = bucketIdByGoalId.get(transaction.linkedGoalId);
    if (!bucketId || !reservedByBucketId.has(bucketId)) {
      continue;
    }

    countedTransactionIds.add(transaction.id);
    const amountCents = Math.abs(parseMoneyToCents(transaction.amount ?? '0.00'));
    reservedByBucketId.set(bucketId, reservedByBucketId.get(bucketId) + amountCents);
  }

  for (const row of importedTransactions) {
    if (
      !row.linkedGoalId
      || !activeGoalIds.has(row.linkedGoalId)
      || row.status === 'ignored'
      || row.classificationType !== 'goal_funding'
    ) {
      continue;
    }

    if (row.linkedTransactionId && countedTransactionIds.has(row.linkedTransactionId)) {
      continue;
    }

    const bucketId = bucketIdByGoalId.get(row.linkedGoalId);
    if (!bucketId || !reservedByBucketId.has(bucketId)) {
      continue;
    }

    reservedByBucketId.set(bucketId, reservedByBucketId.get(bucketId) + Math.abs(parseMoneyToCents(row.amount ?? '0.00')));
  }

  return reservedByBucketId;
}

/**
 * Sum cents attributed to a single goal from transactions and their splits.
 *
 * Attribution precedence mirrors goals.js sumGoalLinkedTransactionCents.
 *
 * @param {string} goalId
 * @param {Array} transactions
 * @param {Array} [importedTransactions]
 * @param {Map<string,Array>} [splitsByTransactionId]
 */
export function sumGoalLinkedContributionCents(goalId, transactions, importedTransactions = [], splitsByTransactionId = new Map()) {
  const countedTransactionIds = new Set();

  const transactionTotal = transactions.reduce((total, transaction) => {
    const splits = splitsByTransactionId.get(transaction.id) ?? [];

    if (splits.length > 0) {
      // Splits take precedence.
      countedTransactionIds.add(transaction.id);
      const splitAmount = splits
        .filter((split) => split.linkedGoalId === goalId)
        .reduce((sum, split) => sum + Math.abs(parseMoneyToCents(split.amount ?? '0.00')), 0);
      return total + splitAmount;
    }

    if (transaction.linkedGoalId !== goalId) {
      return total;
    }

    countedTransactionIds.add(transaction.id);
    return total + Math.abs(parseMoneyToCents(transaction.amount ?? '0.00'));
  }, 0);

  const importedFallbackTotal = importedTransactions.reduce((total, row) => {
    if (row.linkedGoalId !== goalId || row.status === 'ignored' || row.classificationType !== 'goal_funding') {
      return total;
    }

    if (row.linkedTransactionId && countedTransactionIds.has(row.linkedTransactionId)) {
      return total;
    }

    return total + Math.abs(parseMoneyToCents(row.amount ?? '0.00'));
  }, 0);

  return transactionTotal + importedFallbackTotal;
}

export { indexSplitsByTransactionId };
