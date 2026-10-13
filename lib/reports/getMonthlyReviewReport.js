import { computeMonthlyReviewSnapshot, formatCents, monthStart, parseMoneyToCents, unwrapRows, listAllTransactionsInRange } from '../raf/reporting.js';
import { monthBounds, monthRangeFor, parseYearMonth } from '../dates.js';
import { buildGoalReservedByBucketId } from './goalContributions.js';

export class MonthlyReviewReportHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MonthlyReviewReportHttpError';
    this.status = status;
  }
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Report DB adapter must implement transaction().');
  }
}

function normalizeReviewMonth(value) {
  let normalized;
  try {
    normalized = monthStart(value);
  } catch {
    throw new MonthlyReviewReportHttpError(400, 'month must be a valid ISO date');
  }

  if (String(value).trim() !== normalized) {
    throw new MonthlyReviewReportHttpError(400, 'month must be the first day of the month');
  }

  return normalized;
}

async function resolveReviewMonth({ tx, householdId, month, year, periodMonth }) {
  const parsedPeriod = parseYearMonth(year, periodMonth);
  if (parsedPeriod) {
    return monthBounds(parsedPeriod.year, parsedPeriod.month).start;
  }

  if (month) {
    return normalizeReviewMonth(month);
  }

  const household = await tx.getHousehold({ householdId });
  if (!household) {
    throw new MonthlyReviewReportHttpError(404, 'household not found');
  }

  return monthStart(household.activeMonth);
}

function formatDistributions(distributions, surplusSplitRules) {
  return [...surplusSplitRules]
    .filter((rule) => rule.isActive !== false)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
    .map((rule) => ({
      slug: rule.slug,
      label: rule.label ?? rule.slug,
      amount: distributions[rule.slug] ?? '0.00',
      splitPercent: typeof rule.splitPercent === 'string' ? rule.splitPercent : Number(rule.splitPercent ?? 0).toFixed(4),
      destinationType: rule.destinationType ?? 'bucket',
      destinationBucketSlug: rule.destinationBucketSlug ?? null,
      destinationGoalId: rule.destinationGoalId ?? null,
      destinationDebtId: rule.destinationDebtId ?? null,
    }));
}

function buildCategorySummaries({ allocationCategories, incomeAllocations, transactions, goalReservedByBucketId }) {
  const allocationCategoriesById = new Map(allocationCategories.map((category) => [category.id, category]));
  const allocatedByBucketId = new Map();
  const addedByBucketId = new Map();
  const spentByBucketId = new Map();

  for (const allocation of incomeAllocations) {
    const bucketId = allocation.allocationCategoryId ?? allocation.categoryId ?? null;
    if (!bucketId || !allocationCategoriesById.has(bucketId)) {
      continue;
    }

    allocatedByBucketId.set(bucketId, (allocatedByBucketId.get(bucketId) ?? 0) + parseMoneyToCents(allocation.allocatedAmount ?? allocation.amount));
  }

  for (const transaction of transactions) {
    const bucketId = transaction.categoryId ?? null;
    if (!bucketId || !allocationCategoriesById.has(bucketId)) {
      continue;
    }

    const amountCents = Math.abs(parseMoneyToCents(transaction.amount ?? '0.00'));
    if (transaction.direction === 'credit') {
      addedByBucketId.set(bucketId, (addedByBucketId.get(bucketId) ?? 0) + amountCents);
      continue;
    }

    if (transaction.linkedGoalId) {
      continue;
    }

    spentByBucketId.set(bucketId, (spentByBucketId.get(bucketId) ?? 0) + amountCents);
  }

  return allocationCategories
    .filter((category) => category.isActive !== false)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || String(left.slug ?? '').localeCompare(String(right.slug ?? '')))
    .map((category) => {
      const allocatedCents = allocatedByBucketId.get(category.id) ?? 0;
      const addedCents = addedByBucketId.get(category.id) ?? 0;
      const spentCents = spentByBucketId.get(category.id) ?? 0;
      const goalContributionCents = goalReservedByBucketId.get(category.id) ?? 0;
      const overageCents = Math.max((spentCents + goalContributionCents) - (allocatedCents + addedCents), 0);
      const availableCents = Math.max((allocatedCents + addedCents) - spentCents - goalContributionCents, 0);

      return {
        bucketId: category.id,
        bucketName: category.label ?? category.slug,
        slug: category.slug,
        allocated: formatCents(allocatedCents),
        added: formatCents(addedCents),
        spent: formatCents(spentCents),
        goalContributions: formatCents(goalContributionCents),
        available: formatCents(availableCents),
        overused: overageCents > 0,
        overageAmount: formatCents(overageCents),
        _overageCents: overageCents,
      };
    });
}

function sumDistributionCents(distributions, predicate) {
  return distributions.reduce((sum, distribution) => {
    if (!predicate(distribution)) {
      return sum;
    }

    return sum + parseMoneyToCents(distribution.amount ?? '0.00');
  }, 0);
}

function buildMonthlySummary({ incomeEntries, incomeAllocations, transactions, snapshot, formattedDistributions, categorySummaries }) {
  const totalIncomeCents = incomeEntries.reduce((sum, entry) => sum + parseMoneyToCents(entry.amount ?? '0.00'), 0);
  const totalAllocatedCentsRaw = incomeAllocations.reduce((sum, allocation) => sum + parseMoneyToCents(allocation.allocatedAmount ?? allocation.amount ?? '0.00'), 0);
  const totalAllocatedCents = totalAllocatedCentsRaw > 0 ? totalAllocatedCentsRaw : totalIncomeCents;
  const totalSpentCents = transactions.reduce((sum, transaction) => {
    if (transaction.direction !== 'debit') {
      return sum;
    }

    return sum + Math.abs(parseMoneyToCents(transaction.amount ?? '0.00'));
  }, 0);
  const monthResultCents = parseMoneyToCents(snapshot.netSurplus);
  const allocatedToGoalsCents = sumDistributionCents(
    formattedDistributions,
    (distribution) => distribution.destinationType === 'goal',
  );
  const allocatedToDebtCents = sumDistributionCents(
    formattedDistributions,
    (distribution) => distribution.destinationType === 'debt' || distribution.destinationBucketSlug === 'debt_payoff',
  );
  const totalDistributedCents = sumDistributionCents(formattedDistributions, () => true);
  const remainingSurplusCents = monthResultCents > 0 ? Math.max(monthResultCents - totalDistributedCents, 0) : monthResultCents;
  const finalMonthResultCents = remainingSurplusCents;

  const overusedCategories = categorySummaries.filter((category) => category.overused);
  let statusLabel = 'On Budget';
  if (totalSpentCents > totalIncomeCents) {
    statusLabel = 'Deficit Month';
  } else if (totalSpentCents > totalAllocatedCents && overusedCategories.length > 0) {
    statusLabel = remainingSurplusCents >= 0 ? 'Slight Overrun' : 'Over Budget';
  }

  return {
    totalIncome: formatCents(totalIncomeCents),
    totalAllocated: formatCents(totalAllocatedCents),
    totalSpent: formatCents(totalSpentCents),
    monthResult: formatCents(monthResultCents),
    surplusAllocatedToGoals: formatCents(allocatedToGoalsCents),
    surplusAllocatedToDebt: formatCents(allocatedToDebtCents),
    remainingSurplus: formatCents(remainingSurplusCents),
    finalMonthResult: formatCents(finalMonthResultCents),
    statusLabel,
  };
}

export async function getMonthlyReviewReport({ db, householdId, month, year, periodMonth }) {
  if (!householdId) {
    throw new MonthlyReviewReportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  return db.transaction(async (tx) => {
    const reviewMonth = await resolveReviewMonth({ tx, householdId, month, year, periodMonth });
    const [incomeEntries, incomeAllocations, transactions, debtPayments, surplusSplitRules, allocationCategories, goals] = await Promise.all([
      tx.listIncomeEntries({ householdId, ...monthRangeFor(reviewMonth) }),
      tx.listIncomeAllocations({ householdId, ...monthRangeFor(reviewMonth) }),
      listAllTransactionsInRange(tx, { householdId, ...monthRangeFor(reviewMonth) }),
      tx.listDebtPayments({ householdId, ...monthRangeFor(reviewMonth) }),
      tx.listSurplusSplitRules({ householdId }),
      tx.listAllocationCategories({ householdId, asOf: reviewMonth }),
      typeof tx.listGoals === 'function' ? tx.listGoals({ householdId }) : [],
    ]);

    const snapshot = computeMonthlyReviewSnapshot({
      reviewMonth,
      incomeEntries,
      transactions: unwrapRows(transactions),
      debtPayments,
      surplusSplitRules,
    });
    const formattedDistributions = formatDistributions(snapshot.distributions, surplusSplitRules);
    const goalReservedByBucketId = buildGoalReservedByBucketId({
      goals,
      buckets: allocationCategories.map((category) => ({
        id: category.id,
        slug: category.slug,
      })),
      transactions: unwrapRows(transactions),
    });
    const categorySummaries = buildCategorySummaries({
      allocationCategories,
      incomeAllocations,
      transactions: unwrapRows(transactions),
      goalReservedByBucketId,
    });
    const overspendingCategories = categorySummaries
      .filter((category) => category.overused)
      .map((category) => ({
        bucketId: category.bucketId,
        bucketName: category.bucketName,
        slug: category.slug,
        overageAmount: category.overageAmount,
        _overageCents: category._overageCents,
      }));
    const overspendingImpactTotalCents = overspendingCategories.reduce((sum, category) => sum + category._overageCents, 0);
    const monthlySummary = buildMonthlySummary({
      incomeEntries,
      incomeAllocations,
      transactions: unwrapRows(transactions),
      snapshot,
      formattedDistributions,
      categorySummaries,
    });

    return {
      reviewMonth: snapshot.reviewMonth,
      netSurplus: snapshot.netSurplus,
      distributions: formattedDistributions,
      alertStatus: snapshot.alertStatus,
      monthlySummary,
      categorySummaries: categorySummaries.map(({ _overageCents, ...category }) => category),
      overspendingImpact: {
        totalImpact: formatCents(overspendingImpactTotalCents),
        categories: overspendingCategories.map(({ _overageCents, ...category }) => category),
      },
    };
  });
}
