const MONEY_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const FRACTION_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;
const FRACTION_SCALE = 10000;
const SUM_TOLERANCE_BPS = 1;

export function formatCents(cents) {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function parseMoneyToCents(value) {
  const asString = typeof value === 'number' ? value.toFixed(2) : String(value ?? '').trim();
  if (!MONEY_PATTERN.test(asString)) {
    throw new Error(`Invalid money amount: ${value}`);
  }

  const negative = asString.startsWith('-');
  const unsigned = negative ? asString.slice(1) : asString;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function parseFractionToBps(value) {
  const asString = typeof value === 'number' ? value.toFixed(4) : String(value ?? '').trim();
  if (!FRACTION_PATTERN.test(asString)) {
    throw new Error(`Invalid fraction: ${value}`);
  }

  const [whole, fraction = ''] = asString.split('.');
  return Number(whole) * FRACTION_SCALE + Number((fraction + '0000').slice(0, 4));
}

export function sortBySortOrderSlugId(left, right) {
  return (left.sortOrder ?? 0) - (right.sortOrder ?? 0)
    || String(left.slug ?? '').localeCompare(String(right.slug ?? ''))
    || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

export function computeBucketBalancesSnapshot({
  buckets,
  incomeAllocations,
  transactions,
  categoryLookupById = new Map(),
  splitsByTransactionId = new Map(),
}) {
  const activeBuckets = [...buckets]
    .filter((bucket) => bucket.isActive !== false)
    .sort(sortBySortOrderSlugId);

  const activeBucketIdBySlug = new Map(activeBuckets.map((bucket) => [bucket.slug, bucket.id]));
  const allocationCentsByBucketId = new Map(activeBuckets.map((bucket) => [bucket.id, 0]));
  for (const allocation of incomeAllocations) {
    const originalBucketId = allocation.allocationCategoryId ?? allocation.categoryId ?? null;
    const originalBucket = originalBucketId ? categoryLookupById.get(originalBucketId) ?? null : null;
    const bucketId = originalBucket?.slug
      ? activeBucketIdBySlug.get(originalBucket.slug) ?? null
      : originalBucketId;
    if (!bucketId || !allocationCentsByBucketId.has(bucketId)) {
      continue;
    }

    allocationCentsByBucketId.set(
      bucketId,
      allocationCentsByBucketId.get(bucketId) + parseMoneyToCents(allocation.allocatedAmount ?? allocation.amount),
    );
  }

  const transactionDeltaCentsByBucketId = new Map(activeBuckets.map((bucket) => [bucket.id, 0]));
  for (const transaction of transactions) {
    const splits = splitsByTransactionId.get(transaction.id);
    if (splits?.length) {
      // Split attribution replaces parent attribution — iterate child splits only.
      for (const split of splits) {
        const originalBucket = split.categoryId ? categoryLookupById.get(split.categoryId) ?? null : null;
        const bucketId = originalBucket?.slug
          ? activeBucketIdBySlug.get(originalBucket.slug) ?? null
          : split.categoryId;
        if (!bucketId || !transactionDeltaCentsByBucketId.has(bucketId)) continue;
        const splitCents = parseMoneyToCents(split.amount);
        // Splits are always debit portions of the canonical transaction.
        transactionDeltaCentsByBucketId.set(bucketId, transactionDeltaCentsByBucketId.get(bucketId) - splitCents);
      }
      continue;
    }

    const originalBucket = transaction.categoryId ? categoryLookupById.get(transaction.categoryId) ?? null : null;
    const bucketId = originalBucket?.slug
      ? activeBucketIdBySlug.get(originalBucket.slug) ?? null
      : transaction.categoryId;
    if (!bucketId || !transactionDeltaCentsByBucketId.has(bucketId)) {
      continue;
    }

    const amountCents = Math.abs(parseMoneyToCents(transaction.amount));
    const delta = transaction.direction === 'credit' ? amountCents : -amountCents;
    transactionDeltaCentsByBucketId.set(
      bucketId,
      transactionDeltaCentsByBucketId.get(bucketId) + delta,
    );
  }

  const balances = activeBuckets.map((bucket) => {
    const balanceCents = allocationCentsByBucketId.get(bucket.id) + transactionDeltaCentsByBucketId.get(bucket.id);
    return {
      bucket_id: bucket.id,
      bucket_name: bucket.label ?? bucket.slug,
      slug: bucket.slug,
      balance: formatCents(balanceCents),
      _balanceCents: balanceCents,
    };
  });

  const totalBalanceCents = balances.reduce((sum, bucket) => sum + bucket._balanceCents, 0);

  return balances.map((bucket) => ({
    bucket_id: bucket.bucket_id,
    bucket_name: bucket.bucket_name,
    slug: bucket.slug,
    balance: bucket.balance,
    percent_of_total: totalBalanceCents === 0 ? 0 : Number(((bucket._balanceCents / totalBalanceCents) * 100).toFixed(2)),
  }));
}

export function computeMonthlyBucketProgressSnapshot({
  buckets,
  incomeAllocations,
  transactions,
  categoryLookupById = new Map(),
  goalReservedByBucketId = new Map(),
  splitsByTransactionId = new Map(),
}) {
  const activeBuckets = [...buckets]
    .filter((bucket) => bucket.isActive !== false)
    .sort(sortBySortOrderSlugId);

  const activeBucketIdBySlug = new Map(activeBuckets.map((bucket) => [bucket.slug, bucket.id]));
  const allocatedByBucketId = new Map(activeBuckets.map((bucket) => [bucket.id, 0]));
  for (const allocation of incomeAllocations) {
    const originalBucketId = allocation.allocationCategoryId ?? allocation.categoryId ?? null;
    const originalBucket = originalBucketId ? categoryLookupById.get(originalBucketId) ?? null : null;
    const bucketId = originalBucket?.slug
      ? activeBucketIdBySlug.get(originalBucket.slug) ?? null
      : originalBucketId;
    if (!bucketId || !allocatedByBucketId.has(bucketId)) {
      continue;
    }

    allocatedByBucketId.set(
      bucketId,
      allocatedByBucketId.get(bucketId) + parseMoneyToCents(allocation.allocatedAmount ?? allocation.amount),
    );
  }

  const addedByBucketId = new Map(activeBuckets.map((bucket) => [bucket.id, 0]));
  const usedByBucketId = new Map(activeBuckets.map((bucket) => [bucket.id, 0]));
  for (const transaction of transactions) {
    const splits = splitsByTransactionId.get(transaction.id);
    if (splits?.length) {
      // Split attribution replaces parent attribution — iterate child splits only.
      // Splits are always debit portions; credits are never split.
      for (const split of splits) {
        const originalBucket = split.categoryId ? categoryLookupById.get(split.categoryId) ?? null : null;
        const bucketId = originalBucket?.slug
          ? activeBucketIdBySlug.get(originalBucket.slug) ?? null
          : split.categoryId;
        if (!bucketId || !usedByBucketId.has(bucketId)) continue;
        usedByBucketId.set(bucketId, usedByBucketId.get(bucketId) + parseMoneyToCents(split.amount));
      }
      continue;
    }

    const originalBucket = transaction.categoryId ? categoryLookupById.get(transaction.categoryId) ?? null : null;
    const bucketId = originalBucket?.slug
      ? activeBucketIdBySlug.get(originalBucket.slug) ?? null
      : transaction.categoryId;
    if (!bucketId || !usedByBucketId.has(bucketId)) {
      continue;
    }

    const amountCents = Math.abs(parseMoneyToCents(transaction.amount));
    if (transaction.direction === 'credit') {
      addedByBucketId.set(bucketId, addedByBucketId.get(bucketId) + amountCents);
      continue;
    }

    if (transaction.direction === 'debit') {
      usedByBucketId.set(
        bucketId,
        usedByBucketId.get(bucketId) + amountCents,
      );
    }
  }

  return activeBuckets.map((bucket) => {
    const allocatedCents = allocatedByBucketId.get(bucket.id);
    const addedCents = addedByBucketId.get(bucket.id);
    const usedCents = usedByBucketId.get(bucket.id);
    const reservedForGoalsCents = goalReservedByBucketId.get(bucket.id) ?? 0;
    const remainingCents = allocatedCents + addedCents - usedCents;
    const availableCents = Math.max(remainingCents - reservedForGoalsCents, 0);

    return {
      bucket_id: bucket.id,
      bucket_name: bucket.label ?? bucket.slug,
      allocated_this_month: formatCents(allocatedCents),
      added_this_month: formatCents(addedCents),
      used_this_month: formatCents(usedCents),
      reserved_for_goals_this_month: formatCents(reservedForGoalsCents),
      available_this_month: formatCents(availableCents),
      remaining_this_month: formatCents(remainingCents),
      percent_used_this_month: allocatedCents === 0 ? 0 : Number(((usedCents / allocatedCents) * 100).toFixed(2)),
      percent_reserved_for_goals_this_month:
        allocatedCents === 0 ? 0 : Number(((reservedForGoalsCents / allocatedCents) * 100).toFixed(2)),
    };
  });
}

export function unwrapRows(result) {
  return Array.isArray(result) ? result : result?.items ?? [];
}

export function monthStart(value) {
  const asString = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asString)) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  const parsed = new Date(`${asString}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== asString) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  parsed.setUTCDate(1);
  return parsed.toISOString().slice(0, 10);
}

export function nextMonth(month) {
  const current = new Date(`${monthStart(month)}T00:00:00.000Z`);
  current.setUTCMonth(current.getUTCMonth() + 1);
  return current.toISOString().slice(0, 10);
}

export function enumerateMonths(from, to) {
  const start = monthStart(from);
  const end = monthStart(to);
  if (start > end) {
    throw new Error('from must be before or equal to to');
  }

  const months = [];
  let cursor = start;
  while (cursor <= end) {
    months.push(cursor);
    cursor = nextMonth(cursor);
  }

  return months;
}

export function computeAlertStatus({ netSurplusCents, debtRatio = 0, emergencyCoverageMonths = null }) {
  if ((emergencyCoverageMonths != null && emergencyCoverageMonths < 1) || debtRatio > 0.35) {
    return 'risky';
  }

  if (debtRatio > 0.25 || netSurplusCents < 0) {
    return 'elevated';
  }

  return 'ok';
}

export function buildNetSurplusExplanation({ month, incomeCents, spendingCents }) {
  return {
    label: 'Net surplus',
    value: formatCents(incomeCents - spendingCents),
    components: [
      {
        label: 'Income',
        value: formatCents(incomeCents),
        kind: 'add',
      },
      {
        label: 'Spending',
        value: formatCents(-spendingCents),
        kind: 'subtract',
      },
    ],
    assumptions: [
      'Spending includes recorded debit transactions in the selected month.',
      'Credits are not counted as spending.',
    ],
    provenance: 'Dashboard report period totals',
    asOf: month,
  };
}

export function buildDashboardPeriods({
  from,
  to,
  incomeEntries,
  incomeAllocations,
  transactions,
  debtPayments,
  emergencyCoverageMonthsByMonth = {},
}) {
  const months = enumerateMonths(from, to);
  const totals = new Map(
    months.map((month) => [
      month,
      {
        incomeCents: 0,
        spendingCents: 0,
        savingsCents: 0,
        debtPaymentCents: 0,
      },
    ]),
  );

  for (const entry of incomeEntries) {
    const month = monthStart(entry.receivedDate);
    if (totals.has(month)) {
      totals.get(month).incomeCents += parseMoneyToCents(entry.amount);
    }
  }

  for (const allocation of incomeAllocations) {
    if (allocation.slug !== 'savings') {
      continue;
    }

    const month = monthStart(allocation.receivedDate);
    if (totals.has(month)) {
      totals.get(month).savingsCents += parseMoneyToCents(allocation.allocatedAmount);
    }
  }

  for (const transaction of transactions) {
    if (transaction.direction !== 'debit') {
      continue;
    }

    const month = monthStart(transaction.transactionDate);
    if (totals.has(month)) {
      totals.get(month).spendingCents += Math.abs(parseMoneyToCents(transaction.amount));
    }
  }

  for (const payment of debtPayments) {
    const month = monthStart(payment.paymentDate);
    if (totals.has(month)) {
      totals.get(month).debtPaymentCents += parseMoneyToCents(payment.amount);
    }
  }

  return months.map((month) => {
    const total = totals.get(month);
    const netSurplusCents = total.incomeCents - total.spendingCents;
    const debtRatio = total.incomeCents === 0 ? 0 : total.debtPaymentCents / total.incomeCents;

    return {
      month,
      incomeTotal: formatCents(total.incomeCents),
      spendingTotal: formatCents(total.spendingCents),
      surplusOrDeficit: formatCents(netSurplusCents),
      savingsActual: formatCents(total.savingsCents),
      alertStatus: computeAlertStatus({
        netSurplusCents,
        debtRatio,
        emergencyCoverageMonths: emergencyCoverageMonthsByMonth[month] ?? null,
      }),
      explanations: {
        netSurplus: buildNetSurplusExplanation({
          month,
          incomeCents: total.incomeCents,
          spendingCents: total.spendingCents,
        }),
      },
    };
  });
}

export function computeMonthlyReviewSnapshot({
  reviewMonth,
  incomeEntries,
  transactions,
  debtPayments,
  surplusSplitRules,
  surplusSplitOverride = null,
  emergencyCoverageMonths = null,
}) {
  const month = monthStart(reviewMonth);
  const incomeCents = incomeEntries.reduce((sum, entry) => sum + parseMoneyToCents(entry.amount), 0);
  const outflowCents = transactions.reduce((sum, transaction) => {
    if (transaction.direction !== 'debit') {
      return sum;
    }

    return sum + Math.abs(parseMoneyToCents(transaction.amount));
  }, 0);
  const debtPaymentCents = debtPayments.reduce((sum, payment) => sum + parseMoneyToCents(payment.amount), 0);
  const netSurplusCents = incomeCents - outflowCents;
  const debtRatio = incomeCents === 0 ? 0 : debtPaymentCents / incomeCents;

  const activeRules = [...surplusSplitRules]
    .filter((rule) => rule.isActive !== false)
    .sort(sortBySortOrderSlugId)
    .map((rule) => ({
      ...rule,
      splitPercent: surplusSplitOverride && Object.prototype.hasOwnProperty.call(surplusSplitOverride, rule.slug)
        ? surplusSplitOverride[rule.slug]
        : rule.splitPercent,
    }));

  const totalSplitBps = activeRules.reduce((sum, rule) => sum + parseFractionToBps(rule.splitPercent), 0);
  if (activeRules.length > 0 && Math.abs(totalSplitBps - FRACTION_SCALE) > SUM_TOLERANCE_BPS) {
    throw new Error('Active surplus split percents must sum to 1.0000 ± 0.0001.');
  }

  const splitApplied = Object.fromEntries(
    activeRules.map((rule) => [rule.slug, typeof rule.splitPercent === 'string' ? rule.splitPercent : Number(rule.splitPercent).toFixed(4)]),
  );

  const distributions = Object.fromEntries(activeRules.map((rule) => [rule.slug, '0.00']));
  if (netSurplusCents > 0 && activeRules.length > 0) {
    const emergencyRule = activeRules.find((rule) => rule.slug === 'emergency_fund');
    if (!emergencyRule) {
      throw new Error('Active surplus split rules must include the emergency_fund slug.');
    }

    let assignedCents = 0;
    for (const rule of activeRules) {
      const cents = Math.floor((netSurplusCents * parseFractionToBps(rule.splitPercent)) / FRACTION_SCALE);
      distributions[rule.slug] = formatCents(cents);
      assignedCents += cents;
    }

    const remainder = netSurplusCents - assignedCents;
    distributions.emergency_fund = formatCents(parseMoneyToCents(distributions.emergency_fund) + remainder);
  }

  return {
    reviewMonth: month,
    netSurplus: formatCents(netSurplusCents),
    splitApplied,
    distributions,
    alertStatus: computeAlertStatus({
      netSurplusCents,
      debtRatio,
      emergencyCoverageMonths,
    }),
  };
}

export function computeFinancialHealthSnapshot({
  reviewMonth = undefined,
  household,
  activeMonthIncomeEntries,
  activeMonthIncomeAllocations = [],
  activeMonthTransactions,
  activeMonthDebtPayments,
  savingsAllocations = [],
  savingsBalance = null,
  monthlyReviews,
  healthScoreSnapshot = { healthScore: 0, healthPillars: [] },
}) {
  const activeMonthIncomeCents = activeMonthIncomeEntries.reduce(
    (sum, entry) => sum + parseMoneyToCents(entry.amount),
    0,
  );
  const monthlyDebtPaymentsCents = activeMonthDebtPayments.reduce(
    (sum, payment) => sum + parseMoneyToCents(payment.amount),
    0,
  );
  const activeMonthOutflowCents = activeMonthTransactions.reduce((sum, transaction) => {
    if (transaction.direction !== 'debit') {
      return sum;
    }

    return sum + Math.abs(parseMoneyToCents(transaction.amount));
  }, 0);
  const savingsBalanceCents = savingsBalance != null
    ? parseMoneyToCents(savingsBalance)
    : savingsAllocations.reduce(
      (sum, allocation) => sum + parseMoneyToCents(allocation.allocatedAmount),
      0,
    );
  const emergencyFundBalanceCents = monthlyReviews.reduce((sum, review) => {
    const distributions = review.distributions ?? {};
    const amount = distributions.emergency_fund ?? '0.00';
    return sum + parseMoneyToCents(amount);
  }, 0);

  const configuredSavingsFloorCents = parseMoneyToCents(household.savingsFloor ?? '0.00');
  const savingsFloorEnabled = household.savingsFloorEnabled === true;
  const savingsFloorCents = savingsFloorEnabled ? configuredSavingsFloorCents : 0;
  const monthlyEssentialsCents = parseMoneyToCents(household.monthlyEssentialsBaseline ?? '0.00');
  const availableSavingsCents = savingsBalanceCents - savingsFloorCents;
  const debtRatio = activeMonthIncomeCents === 0 ? 0 : monthlyDebtPaymentsCents / activeMonthIncomeCents;
  const emergencyCoverageMonths =
    monthlyEssentialsCents === 0 ? null : emergencyFundBalanceCents / monthlyEssentialsCents;
  const netSurplusCents = activeMonthIncomeCents - activeMonthOutflowCents;

  return {
    reviewMonth,
    activeMonthIncome: formatCents(activeMonthIncomeCents),
    monthlyDebtPayments: formatCents(monthlyDebtPaymentsCents),
    debtRatio: activeMonthIncomeCents === 0 ? '0.0000' : debtRatio.toFixed(4),
    savingsBalance: formatCents(savingsBalanceCents),
    savingsFloor: formatCents(configuredSavingsFloorCents),
    savingsFloorEnabled,
    availableSavings: formatCents(availableSavingsCents),
    emergencyFundBalance: formatCents(emergencyFundBalanceCents),
    monthlyEssentials: formatCents(monthlyEssentialsCents),
    emergencyCoverageMonths:
      emergencyCoverageMonths == null ? null : Number(emergencyCoverageMonths.toFixed(2)),
    healthScore: healthScoreSnapshot.healthScore,
    healthPillars: healthScoreSnapshot.healthPillars,
    alertStatus: computeAlertStatus({
      netSurplusCents,
      debtRatio,
      emergencyCoverageMonths,
    }),
  };
}

// Transactions are paged (default 50 rows). Canonical period totals must read every page
// in range, or spending is silently understated for any month with more rows than one page.
export async function listAllTransactionsInRange(tx, { householdId, from, to }) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const page = await tx.listTransactions({ householdId, from, to, cursor, limit: 500 });
    const items = unwrapRows(page);
    rows.push(...items);
    const nextCursor = page?.nextCursor ?? null;
    if (!nextCursor || items.length === 0) break;
    cursor = nextCursor;
  }
  return rows;
}
