import {
  buildDashboardPeriods,
  computeBucketBalancesSnapshot,
  computeMonthlyBucketProgressSnapshot,
  formatCents,
  monthStart,
  parseMoneyToCents,
  unwrapRows,
} from '../raf/reporting.js';
import { monthBounds, parseYearMonth } from '../dates.js';
import { buildGoalReservedByBucketId, sumGoalLinkedContributionCents } from './goalContributions.js';
import { indexSplitsByTransactionId } from '../transactions/transactionSplits.js';

export class ReportHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ReportHttpError';
    this.status = status;
  }
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Report DB adapter must implement transaction().');
  }
}

function normalizeMonthQuery(value, fieldName) {
  try {
    return monthStart(value);
  } catch {
    throw new ReportHttpError(400, `${fieldName} must be a valid ISO date`);
  }
}

async function resolvePeriod({ tx, householdId, from, to, year, month }) {
  const parsedPeriod = parseYearMonth(year, month);
  if (parsedPeriod) {
    const bounds = monthBounds(parsedPeriod.year, parsedPeriod.month);
    return {
      from: bounds.start,
      to: bounds.start,
      snapshotAsOf: bounds.end,
    };
  }

  if (from && to) {
    const normalizedTo = normalizeMonthQuery(to, 'to');
    return {
      from: normalizeMonthQuery(from, 'from'),
      to: normalizedTo,
      snapshotAsOf: String(to).trim(),
    };
  }

  const household = await tx.getHousehold({ householdId });
  if (!household) {
    throw new ReportHttpError(404, 'household not found');
  }

  const activeMonthStart = monthStart(household.activeMonth);
  const [activeYear, activeMonthNum] = activeMonthStart.split('-').map(Number);
  const activeBounds = monthBounds(activeYear, activeMonthNum);
  return {
    from: activeMonthStart,
    to: activeMonthStart,
    snapshotAsOf: activeBounds.end,
  };
}

function formatUpcomingFixedBill(fixedBill) {
  return {
    id: fixedBill.id,
    name: fixedBill.name,
    category_slug: fixedBill.categorySlug,
    expected_amount: fixedBill.expectedAmount,
    due_day_of_month: fixedBill.dueDayOfMonth,
  };
}

function addMoneyStrings(left, right) {
  const [leftWhole, leftFraction = ''] = String(left).split('.');
  const [rightWhole, rightFraction = ''] = String(right).split('.');
  const totalCents = (Number(leftWhole) * 100 + Number((leftFraction + '00').slice(0, 2)))
    + (Number(rightWhole) * 100 + Number((rightFraction + '00').slice(0, 2)));

  return `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, '0')}`;
}

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

function buildGoalProgress({ goals, bucketBalances, transactions, importedTransactions, categoryLookupById = new Map(), splitsByTransactionId = new Map() }) {
  const bucketBalancesById = new Map(bucketBalances.map((bucket) => [bucket.bucket_id, bucket]));
  const activeBuckets = bucketBalances.map((bucket) => ({
    id: bucket.bucket_id,
    slug: bucket.slug,
    label: bucket.bucket_name,
  }));
  const { resolveActiveBucketId } = buildActiveBucketContext({ buckets: activeBuckets, categoryLookupById });

  return goals
    .filter((goal) => goal.active !== false)
    .map((goal) => {
      const resolvedBucketId = resolveActiveBucketId(goal.bucketId);
      const bucket = resolvedBucketId ? bucketBalancesById.get(resolvedBucketId) : null;
      const originalBucket = categoryLookupById.get(goal.bucketId) ?? null;

      const goalContributionCents = Math.max(sumGoalLinkedContributionCents(goal.id, transactions, importedTransactions, splitsByTransactionId), 0);
      const reservedAmount = formatCents(goalContributionCents);
      const targetAmount = goal.targetAmount;
      const reservedAmountCents = goalContributionCents;
      const targetAmountCents = parseMoneyToCents(targetAmount);
      const remainingAmountCents = Math.max(targetAmountCents - reservedAmountCents, 0);
      const unclampedProgressPercent = targetAmountCents === 0 ? 0 : Number(((reservedAmountCents / targetAmountCents) * 100).toFixed(2));

      return {
        goal_id: goal.id,
        goal_name: goal.name,
        bucket_id: resolvedBucketId ?? goal.bucketId,
        bucket: bucket?.bucket_name ?? originalBucket?.label ?? null,
        bucket_name: bucket?.bucket_name ?? originalBucket?.label ?? null,
        bucket_balance: bucket?.balance ?? '0.00',
        target_amount: targetAmount,
        reserved_amount: reservedAmount,
        current_amount: reservedAmount,
        remaining_amount: formatCents(remainingAmountCents),
        progress_percent: Math.min(unclampedProgressPercent, 100),
      };
    })
    .filter((item) => item !== null);
}

export async function getDashboardReport({ db, householdId, from, to, year, month }) {
  if (!householdId) {
    throw new ReportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const { from: normalizedFrom, to: normalizedTo, snapshotAsOf } = await resolvePeriod({
      tx,
      householdId,
      from,
      to,
      year,
      month,
    });

    const [incomeEntries, incomeAllocations, transactions, debtPayments, fixedBills, goals, allocationCategories, allCategories] = await Promise.all([
      tx.listIncomeEntries({ householdId, from: normalizedFrom, to: snapshotAsOf }),
      tx.listIncomeAllocations({ householdId, from: normalizedFrom, to: snapshotAsOf }),
      tx.listTransactions({ householdId, from: normalizedFrom, to: snapshotAsOf }),
      tx.listDebtPayments({ householdId, from: normalizedFrom, to: snapshotAsOf }),
      typeof tx.listFixedBills === 'function' ? tx.listFixedBills({ householdId }) : [],
      typeof tx.listGoals === 'function' ? tx.listGoals({ householdId }) : [],
      tx.listAllocationCategories({ householdId, asOf: snapshotAsOf }),
      tx.listAllocationCategories({ householdId, includeSuperseded: true }),
    ]);
    const [allIncomeAllocations, allTransactionsResult, importedTransactions] = await Promise.all([
      tx.listIncomeAllocations({ householdId, from: '0001-01-01', to: snapshotAsOf }),
      tx.listTransactions({ householdId, from: '0001-01-01', to: snapshotAsOf }),
      typeof tx.listImportedTransactions === 'function' ? tx.listImportedTransactions({ householdId }) : [],
    ]);
    const yearStart = `${normalizedTo.slice(0, 4)}-01-01`;
    const [ytdIncomeAllocations, ytdTransactionsResult, allSplits] = await Promise.all([
      tx.listIncomeAllocations({ householdId, from: yearStart, to: snapshotAsOf }),
      tx.listTransactions({ householdId, from: yearStart, to: snapshotAsOf }),
      typeof tx.listTransactionSplits === 'function'
        ? tx.listTransactionSplits({ householdId, from: '0001-01-01', to: snapshotAsOf })
        : [],
    ]);
    const allTransactions = unwrapRows(allTransactionsResult);
    const ytdTransactions = unwrapRows(ytdTransactionsResult);
    const categoryLookupById = new Map(allCategories.map((category) => [category.id, category]));
    const splitsByTransactionId = indexSplitsByTransactionId(allSplits ?? []);
    const bucketBalances = computeBucketBalancesSnapshot({
      buckets: allocationCategories,
      incomeAllocations: allIncomeAllocations,
      transactions: allTransactions,
      categoryLookupById,
      splitsByTransactionId,
    });
    const currentMonthTransactions = unwrapRows(transactions);
    const monthlyGoalBucketUsage = buildGoalReservedByBucketId({
      goals,
      buckets: allocationCategories,
      transactions: currentMonthTransactions,
      importedTransactions,
      categoryLookupById,
      splitsByTransactionId,
    });
    const monthlyBucketProgress = computeMonthlyBucketProgressSnapshot({
      buckets: allocationCategories,
      incomeAllocations,
      transactions: currentMonthTransactions,
      categoryLookupById,
      goalReservedByBucketId: monthlyGoalBucketUsage,
      splitsByTransactionId,
    });
    const ytdGoalBucketUsage = buildGoalReservedByBucketId({
      goals,
      buckets: allocationCategories,
      transactions: ytdTransactions,
      importedTransactions,
      categoryLookupById,
      splitsByTransactionId,
    });
    const ytdBucketProgress = computeMonthlyBucketProgressSnapshot({
      buckets: allocationCategories,
      incomeAllocations: ytdIncomeAllocations,
      transactions: ytdTransactions,
      categoryLookupById,
      goalReservedByBucketId: ytdGoalBucketUsage,
      splitsByTransactionId,
    });
    const totalToDateGoalBucketUsage = buildGoalReservedByBucketId({
      goals,
      buckets: allocationCategories,
      transactions: allTransactions,
      importedTransactions,
      categoryLookupById,
      splitsByTransactionId,
    });
    const ttdBucketProgress = computeMonthlyBucketProgressSnapshot({
      buckets: allocationCategories,
      incomeAllocations: allIncomeAllocations,
      transactions: allTransactions,
      categoryLookupById,
      goalReservedByBucketId: totalToDateGoalBucketUsage,
      splitsByTransactionId,
    });
    const goalProgress = buildGoalProgress({
      goals,
      bucketBalances,
      transactions: allTransactions,
      importedTransactions,
      categoryLookupById,
      splitsByTransactionId,
    });

    const upcomingFixedBillsThisMonth = fixedBills
      .filter((fixedBill) => fixedBill.active !== false)
      .sort((left, right) =>
        (left.dueDayOfMonth ?? 0) - (right.dueDayOfMonth ?? 0)
        || String(left.categorySlug ?? '').localeCompare(String(right.categorySlug ?? ''))
        || String(left.name ?? '').localeCompare(String(right.name ?? ''))
        || String(left.id ?? '').localeCompare(String(right.id ?? '')))
      .map(formatUpcomingFixedBill);

    const totalExpectedFixedBillsThisMonth = upcomingFixedBillsThisMonth.reduce(
      (sum, fixedBill) => addMoneyStrings(sum, fixedBill.expected_amount),
      '0.00',
    );

    return {
      periods: buildDashboardPeriods({
        from: normalizedFrom,
        to: normalizedTo,
        incomeEntries,
        incomeAllocations,
        transactions: unwrapRows(transactions),
        debtPayments,
      }),
      upcoming_fixed_bills_this_month: upcomingFixedBillsThisMonth,
      total_expected_fixed_bills_this_month: totalExpectedFixedBillsThisMonth,
      bucket_balances: bucketBalances,
      monthly_bucket_progress: monthlyBucketProgress,
      ytd_bucket_progress: ytdBucketProgress,
      ttd_bucket_progress: ttdBucketProgress,
      goal_progress: goalProgress,
    };
  });
}
