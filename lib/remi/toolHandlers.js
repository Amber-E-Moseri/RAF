/**
 * Remi tool handler layer.
 *
 * Each handler receives { db, householdId, input } and returns a plain object
 * representing the tool result. Handlers MUST call RAF domain services (report
 * functions, plan engine, debt engine, etc.) — they must never perform financial
 * calculations directly from raw database rows.
 *
 * Inputs are validated with Zod (lib/remi/validation.js) in dispatchToolCall
 * before any handler runs. Free-text values are sanitized with
 * lib/remi/sanitize.js, and every successful result is marked
 * data_untrusted: true so the model treats names and descriptions as data.
 *
 * If a handler fails it returns { error: string } so Remi can acknowledge the
 * failure gracefully instead of crashing the agentic loop.
 */

import { getDashboardReport } from '../reports/getDashboardReport.js';
import { getCashFlowForecastReport } from '../reports/getCashFlowForecastReport.js';
import { resolveDebtBalanceAuthority } from '../debts/debtBalanceAuthority.js';
import { buildDebtListResponse } from '../raf/debts.js';
import { parseMoneyToCents, formatCents, unwrapRows } from '../raf/reporting.js';
import { monthBounds } from '../dates.js';
import { sanitizeFreeText, sanitizeMerchantName } from './sanitize.js';
import { toolInputSchemas, formatToolInputIssues } from './validation.js';

// Upper bound on transactions read for one period. Results that reach the cap
// are flagged truncated so incomplete totals are never presented as complete.
export const PERIOD_TRANSACTION_CAP = 5000;

const NAME_MAX_LENGTH = 120;

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function periodToYearMonth(period) {
  if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) return {};
  const [year, month] = period.split('-').map(Number);
  return { year: String(year), month: String(month) };
}

function deltaPercent(from, to) {
  const fromCents = parseMoneyToCents(from ?? '0.00');
  if (fromCents === 0) return null;
  return Number((((parseMoneyToCents(to ?? '0.00') - fromCents) / fromCents) * 100).toFixed(1));
}

function bucketSlug(bucket) {
  return bucket?.slug ?? String(bucket?.bucket_name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function nameText(value, fallback = '') {
  return sanitizeFreeText(value, { maxLength: NAME_MAX_LENGTH, fallback });
}

function completenessNote(truncated) {
  return truncated
    ? `Only the first ${PERIOD_TRANSACTION_CAP} transactions in this period were read. Totals and drivers may be incomplete.`
    : null;
}

/**
 * Reads every transaction in [from, to] (inclusive) up to the cap.
 * Returns { rows, truncated }. truncated is true when the store reports more
 * rows or when the page is full (conservative: a full page may hide more).
 */
async function fetchPeriodTransactions(db, householdId, from, to) {
  const page = await db.transaction((tx) =>
    tx.listTransactions({ householdId, from, to, limit: PERIOD_TRANSACTION_CAP }),
  );
  const rows = unwrapRows(page);
  const truncated = Boolean(page?.nextCursor) || rows.length >= PERIOD_TRANSACTION_CAP;
  return { rows, truncated };
}

async function fetchSplitsByTransactionId(db, householdId, from, to) {
  const splits = await db.transaction((tx) =>
    typeof tx.listTransactionSplits === 'function'
      ? tx.listTransactionSplits({ householdId, from, to })
      : [],
  );
  const map = new Map();
  for (const split of unwrapRows(splits)) {
    if (!map.has(split.transactionId)) map.set(split.transactionId, []);
    map.get(split.transactionId).push(split);
  }
  return map;
}

async function fetchCategorySlugById(db, householdId) {
  const categories = await db.transaction((tx) =>
    tx.listAllocationCategories({ householdId, includeSuperseded: true }),
  );
  return new Map(unwrapRows(categories).map((c) => [c.id, c.slug]));
}

/**
 * Attributes debit amounts to bucket slugs using the same rule as
 * computeMonthlyBucketProgressSnapshot: split rows replace the parent's
 * attribution, otherwise the transaction's category decides. Credits are
 * excluded because they never count as used spending.
 */
function attributeDebits({ rows, splitsByTransactionId, slugById }) {
  const debits = [];
  for (const tx of rows) {
    if (tx.direction !== 'debit') continue;

    const splits = splitsByTransactionId.get(tx.id);
    if (splits?.length) {
      for (const split of splits) {
        const slug = split.categoryId ? slugById.get(split.categoryId) ?? null : null;
        if (!slug) continue;
        debits.push({ slug, cents: Math.abs(parseMoneyToCents(split.amount ?? '0.00')), tx });
      }
      continue;
    }

    const slug = (tx.categoryId ? slugById.get(tx.categoryId) : null)
      ?? tx.categorySlug ?? tx.category_slug ?? null;
    if (!slug) continue;
    debits.push({ slug, cents: Math.abs(parseMoneyToCents(tx.amount ?? '0.00')), tx });
  }
  return debits;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleGetCurrentPlan({ db, householdId, input }) {
  const { year, month } = periodToYearMonth(input?.period);
  const report = await getDashboardReport({ db, householdId, year, month });

  const periodSummary = report.periods?.[0] ?? {};
  const buckets = (report.monthly_bucket_progress ?? []).map((b) => ({
    slug: bucketSlug(b),
    label: nameText(b.bucket_name, bucketSlug(b)),
    allocated: b.allocated_this_month,
    used: b.used_this_month,
    available: b.available_this_month,
    remaining: b.remaining_this_month,
    reserved_for_goals: b.reserved_for_goals_this_month,
    percent_used: b.percent_used_this_month,
  }));

  const totalAllocatedCents = (report.monthly_bucket_progress ?? []).reduce(
    (sum, b) => sum + parseMoneyToCents(b.allocated_this_month ?? '0.00'),
    0,
  );

  return {
    period: input?.period ?? 'current active month',
    income: {
      total_received: periodSummary.incomeTotal ?? '0.00',
      total_allocated: formatCents(totalAllocatedCents),
    },
    total_spending: periodSummary.spendingTotal ?? '0.00',
    buckets,
    goals: (report.goal_progress ?? []).map((g) => ({
      id: g.goal_id,
      name: nameText(g.goal_name, 'Unnamed goal'),
      current: g.current_amount,
      target: g.target_amount,
      progress_percent: g.progress_percent,
    })),
    upcoming_fixed_bills_total: report.total_expected_fixed_bills_this_month ?? '0.00',
    upcoming_fixed_bills_count: (report.upcoming_fixed_bills_this_month ?? []).length,
  };
}

async function handleGetAvailableResources({ db, householdId }) {
  const report = await getDashboardReport({ db, householdId });
  const buckets = report.monthly_bucket_progress ?? [];

  // Flexible slugs: categories that are discretionary and non-protected
  const FLEXIBLE_SLUGS = new Set(['personal_spending', 'buffer', 'investment', 'debt_payoff', 'savings']);

  const flexibleBuckets = buckets
    .filter((b) => FLEXIBLE_SLUGS.has(bucketSlug(b)))
    .map((b) => ({
      slug: bucketSlug(b),
      label: nameText(b.bucket_name, bucketSlug(b)),
      allocated: b.allocated_this_month,
      used: b.used_this_month,
      available: b.available_this_month,
      remaining: b.remaining_this_month,
    }));

  const totalFlexibleAvailableCents = flexibleBuckets.reduce(
    (sum, b) => sum + parseMoneyToCents(b.available ?? '0.00'),
    0,
  );

  const periodSummary = report.periods?.[0] ?? {};
  const receivedCents = parseMoneyToCents(periodSummary.incomeTotal ?? '0.00');
  const allocatedCents = buckets.reduce(
    (sum, b) => sum + parseMoneyToCents(b.allocated_this_month ?? '0.00'),
    0,
  );
  const unallocatedCents = Math.max(0, receivedCents - allocatedCents);

  return {
    flexible_buckets: flexibleBuckets,
    total_flexible_available: formatCents(totalFlexibleAvailableCents),
    unallocated_income: formatCents(unallocatedCents),
    note: 'Available figures are after goals reserved in each bucket. Savings floor is enforced by the forecast engine.',
  };
}

async function handleGetUpcomingObligations({ db, householdId, input }) {
  const days = input?.days ?? 14;
  const forecast = await getCashFlowForecastReport({ db, householdId, days });

  const obligations = [];
  for (const day of forecast.projections ?? []) {
    const bills = (day.projectedFixedBills?.bills ?? []).filter(
      (b) => parseMoneyToCents(b.amount ?? '0.00') > 0,
    );
    const debts = (day.projectedDebtPayments?.byDebt ?? []).filter(
      (d) => parseMoneyToCents(d.amount ?? '0.00') > 0,
    );

    for (const b of bills) {
      obligations.push({
        date: day.date,
        type: 'fixed_bill',
        description: nameText(b.description, 'Unnamed bill'),
        amount: b.amount,
        confidence: b.confidence,
      });
    }
    for (const d of debts) {
      obligations.push({
        date: day.date,
        type: 'debt_payment',
        description: nameText(d.description, 'Unnamed debt payment'),
        amount: d.amount,
        confidence: d.confidence,
      });
    }
  }

  const totalCents = obligations.reduce((s, o) => s + parseMoneyToCents(o.amount ?? '0.00'), 0);

  return {
    lookahead_days: days,
    obligations,
    total_obligations: formatCents(totalCents),
    savings_floor: forecast.assumptions?.savingsFloor ?? '0.00',
  };
}

async function handleGetGoalProgress({ db, householdId, input }) {
  const report = await getDashboardReport({ db, householdId });
  let goals = report.goal_progress ?? [];

  if (input?.goalId) {
    goals = goals.filter((g) => g.goal_id === input.goalId);
  }

  return {
    goals: goals.map((g) => ({
      id: g.goal_id,
      name: nameText(g.goal_name, 'Unnamed goal'),
      current: g.current_amount,
      target: g.target_amount,
      remaining: g.remaining_amount,
      progress_percent: g.progress_percent,
      bucket: nameText(g.bucket_name ?? g.bucket, ''),
    })),
  };
}

async function handleGetDebtStrategy({ db, householdId }) {
  const today_str = today();
  const [debts, allPayments, allAdjustments] = await db.transaction(async (tx) => {
    const debtList = await tx.listDebts({ householdId });
    const payments = typeof tx.listDebtPayments === 'function'
      ? await tx.listDebtPayments({ householdId, from: '0001-01-01', to: today_str })
      : [];
    const adjustments = typeof tx.listDebtAdjustments === 'function'
      ? await tx.listDebtAdjustments({ householdId })
      : [];

    const rawDebts = Array.isArray(debtList) ? debtList : (debtList?.items ?? []);
    const linkedAccountIds = [...new Set(rawDebts.map((d) => d.financialAccountId ?? d.financial_account_id).filter(Boolean))];
    const accountById = new Map();
    if (linkedAccountIds.length > 0 && typeof tx.getFinancialAccountById === 'function') {
      await Promise.all(linkedAccountIds.map(async (accountId) => {
        const account = await tx.getFinancialAccountById({ householdId, accountId });
        if (account) accountById.set(accountId, account);
      }));
    }
    const debtsWithAuthority = rawDebts.map((debt) => {
      const financialAccountId = debt.financialAccountId ?? debt.financial_account_id ?? null;
      const financialAccount = financialAccountId ? (accountById.get(financialAccountId) ?? null) : null;
      return { ...debt, financialAccountId, balanceAuthority: resolveDebtBalanceAuthority({ debt: { ...debt, financialAccountId }, financialAccount }) };
    });

    return [debtsWithAuthority, payments, adjustments];
  });

  const debtArr = Array.isArray(debts) ? debts : (debts?.items ?? []);
  const paymentArr = Array.isArray(allPayments) ? allPayments : (allPayments?.items ?? []);
  const adjustmentArr = Array.isArray(allAdjustments) ? allAdjustments : (allAdjustments?.items ?? []);

  const paymentsByDebtId = new Map();
  for (const p of paymentArr) {
    const key = p.debtId ?? p.debt_id;
    if (!key) continue;
    if (!paymentsByDebtId.has(key)) paymentsByDebtId.set(key, []);
    paymentsByDebtId.get(key).push(p);
  }

  const adjustmentsByDebtId = new Map();
  for (const a of adjustmentArr) {
    const key = a.debtId ?? a.debt_id;
    if (!key) continue;
    if (!adjustmentsByDebtId.has(key)) adjustmentsByDebtId.set(key, []);
    adjustmentsByDebtId.get(key).push(a);
  }

  const result = buildDebtListResponse(debtArr, paymentsByDebtId, adjustmentsByDebtId, today_str);

  return {
    strategy: 'avalanche (highest APR first — saves the most interest)',
    debts: result.items.map((d) => ({
      id: d.id,
      name: nameText(d.name, 'Unnamed debt'),
      current_balance: d.currentBalance,
      apr: d.apr,
      minimum_payment: d.minimumPayment,
      monthly_payment: d.monthlyPayment,
      estimated_payoff_date: d.estimatedPayoffDate,
      months_remaining: d.monthsRemaining,
      total_interest_remaining: d.totalInterestRemaining,
      payment_status: d.paymentStatus,
    })),
    summary: result.summary,
  };
}

async function handleGetCashflowForecast({ db, householdId, input }) {
  const days = input?.days ?? 30;
  const forecast = await getCashFlowForecastReport({ db, householdId, days });

  // Return summary metrics + pressure points — not the full day-by-day array
  return {
    days,
    start_date: forecast.startDate,
    end_date: forecast.endDate,
    assumptions: {
      starting_balance: forecast.assumptions?.startingBalance,
      savings_floor: forecast.assumptions?.savingsFloor,
      avg_monthly_income: forecast.assumptions?.avgMonthlyIncome,
      income_confidence: forecast.assumptions?.incomeConfidence,
    },
    summary: forecast.summaryMetrics,
    pressure_points: (forecast.pressurePoints ?? []).slice(0, 5),
  };
}

async function handleComparePeriods({ db, householdId, input }) {
  const { year: yearA, month: monthA } = periodToYearMonth(input?.periodA);
  if (!yearA) return { error: 'periodA is required and must be YYYY-MM-01' };

  const [reportA, reportB] = await Promise.all([
    getDashboardReport({ db, householdId, year: yearA, month: monthA }),
    getDashboardReport({ db, householdId, ...(input?.periodB ? periodToYearMonth(input.periodB) : {}) }),
  ]);

  const pA = reportA.periods?.[0] ?? {};
  const pB = reportB.periods?.[0] ?? {};

  const bucketsA = new Map((reportA.monthly_bucket_progress ?? []).map((b) => [bucketSlug(b), b]));
  const bucketsB = new Map((reportB.monthly_bucket_progress ?? []).map((b) => [bucketSlug(b), b]));
  const allSlugs = new Set([...bucketsA.keys(), ...bucketsB.keys()]);

  const bucketComparison = [...allSlugs].map((slug) => {
    const a = bucketsA.get(slug);
    const b = bucketsB.get(slug);
    const usedA = a?.used_this_month ?? '0.00';
    const usedB = b?.used_this_month ?? '0.00';
    return {
      slug,
      label: nameText(b?.bucket_name ?? a?.bucket_name ?? slug, slug),
      period_a_used: usedA,
      period_b_used: usedB,
      delta_percent: deltaPercent(usedA, usedB),
    };
  });

  return {
    period_a: input.periodA,
    period_b: input?.periodB ?? 'current active month',
    income: {
      period_a: pA.income?.total ?? '0.00',
      period_b: pB.income?.total ?? '0.00',
      delta_percent: deltaPercent(pA.income?.total, pB.income?.total),
    },
    spending: {
      period_a: pA.spending?.total ?? '0.00',
      period_b: pB.spending?.total ?? '0.00',
      delta_percent: deltaPercent(pA.spending?.total, pB.spending?.total),
    },
    buckets: bucketComparison,
  };
}

async function handleExplainVariance({ db, householdId, input }) {
  // The bucket figures and the transaction window must come from the same
  // period. Omitted period = the household active month, exactly as the
  // dashboard report resolves it.
  const { year, month } = periodToYearMonth(input?.period);
  const report = await getDashboardReport({ db, householdId, year, month });
  const bucket = (report.monthly_bucket_progress ?? []).find(
    (b) => bucketSlug(b) === input.categorySlug,
  );

  if (!bucket) {
    return { error: `Category slug '${input.categorySlug}' not found in this period` };
  }

  const reportMonth = report.periods?.[0]?.month;
  if (!reportMonth) {
    return { error: 'Could not resolve the period for this variance explanation.' };
  }
  const [periodYear, periodMonth] = String(reportMonth).split('-').map(Number);
  const { start, end } = monthBounds(periodYear, periodMonth);

  const { rows, truncated } = await fetchPeriodTransactions(db, householdId, start, end);
  const [splitsByTransactionId, slugById] = await Promise.all([
    fetchSplitsByTransactionId(db, householdId, start, end),
    fetchCategorySlugById(db, householdId),
  ]);

  const bucketDebits = attributeDebits({ rows, splitsByTransactionId, slugById })
    .filter((d) => d.slug === input.categorySlug);

  const driverTotals = new Map();
  let attributedCents = 0;
  const transactionIds = new Set();
  for (const debit of bucketDebits) {
    attributedCents += debit.cents;
    transactionIds.add(debit.tx.id);
    const key = sanitizeMerchantName(debit.tx.merchant ?? debit.tx.description);
    driverTotals.set(key, (driverTotals.get(key) ?? 0) + debit.cents);
  }

  const topDrivers = [...driverTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([description, cents]) => ({ description, total: formatCents(cents) }));

  const allocatedCents = parseMoneyToCents(bucket.allocated_this_month ?? '0.00');
  const usedCents = parseMoneyToCents(bucket.used_this_month ?? '0.00');
  const varianceCents = usedCents - allocatedCents;

  return {
    category: input.categorySlug,
    label: nameText(bucket.bucket_name, input.categorySlug),
    period: reportMonth,
    period_from: start,
    period_to: end,
    allocated: bucket.allocated_this_month,
    used: bucket.used_this_month,
    remaining: bucket.remaining_this_month,
    variance: formatCents(varianceCents),
    variance_direction: varianceCents > 0 ? 'over_budget' : varianceCents < 0 ? 'under_budget' : 'on_track',
    top_transaction_drivers: topDrivers,
    transaction_count: transactionIds.size,
    attributed_debit_total: formatCents(attributedCents),
    reconciles_with_report: !truncated && attributedCents === usedCents,
    truncated,
    completeness_note: completenessNote(truncated),
  };
}

async function handleGetTransactionSummary({ db, householdId, input }) {
  const from = input?.from ?? today().slice(0, 7) + '-01';
  const to = input?.to ?? today();

  const { rows, truncated } = await fetchPeriodTransactions(db, householdId, from, to);

  const filtered = input?.categorySlug
    ? rows.filter((t) => t.categorySlug === input.categorySlug || t.category_slug === input.categorySlug)
    : rows;

  const debits = filtered.filter((t) => t.direction === 'debit' || Number(t.amount ?? 0) < 0);
  const uncategorized = debits.filter((t) => !t.categoryId && !t.category_id);

  const merchantTotals = {};
  for (const tx of debits) {
    const key = sanitizeMerchantName(tx.merchant ?? tx.description);
    merchantTotals[key] = (merchantTotals[key] ?? 0) + Math.abs(parseMoneyToCents(tx.amount ?? '0.00'));
  }
  const topMerchants = Object.entries(merchantTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([merchant, cents]) => ({ merchant, total: formatCents(cents) }));

  const categoryTotals = {};
  for (const tx of debits) {
    const slug = tx.categorySlug ?? tx.category_slug ?? 'uncategorized';
    categoryTotals[slug] = (categoryTotals[slug] ?? 0) + Math.abs(parseMoneyToCents(tx.amount ?? '0.00'));
  }
  const byCategory = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, cents]) => ({ slug, total: formatCents(cents) }));

  const totalCents = debits.reduce(
    (s, t) => s + Math.abs(parseMoneyToCents(t.amount ?? '0.00')),
    0,
  );

  return {
    period: { from, to },
    total_spending: formatCents(totalCents),
    transaction_count: debits.length,
    uncategorized_count: uncategorized.length,
    top_merchants: topMerchants,
    by_category: byCategory,
    truncated,
    completeness_note: completenessNote(truncated),
  };
}

async function handleCreateScenario({ db, householdId, input }) {
  const report = await getDashboardReport({ db, householdId });
  const buckets = report.monthly_bucket_progress ?? [];

  // Find the target bucket
  let targetBucket = input?.categorySlug
    ? buckets.find((b) => bucketSlug(b) === input.categorySlug)
    : buckets.find((b) => ['personal_spending', 'buffer'].includes(bucketSlug(b)) && parseMoneyToCents(b.available_this_month ?? '0.00') > 0);

  if (!targetBucket) {
    return { error: `Could not find a suitable bucket for the scenario. Try specifying categorySlug.` };
  }

  // amountDelta is a validated positive decimal (see validation.js)
  const deltaCents = parseMoneyToCents(input.amountDelta);
  const availableBefore = parseMoneyToCents(targetBucket.available_this_month ?? '0.00');
  const availableAfter = availableBefore - deltaCents;
  const canAfford = availableAfter >= 0;
  const bucketLabel = nameText(targetBucket.bucket_name, bucketSlug(targetBucket));

  return {
    scenario: input.description,
    amount: input.amountDelta,
    bucket: bucketSlug(targetBucket),
    bucket_label: bucketLabel,
    before: {
      allocated: targetBucket.allocated_this_month,
      used: targetBucket.used_this_month,
      available: targetBucket.available_this_month,
    },
    after: {
      used: formatCents(parseMoneyToCents(targetBucket.used_this_month ?? '0.00') + deltaCents),
      available: formatCents(availableAfter),
    },
    can_afford: canAfford,
    shortfall: canAfford ? null : formatCents(Math.abs(availableAfter)),
    note: canAfford
      ? `This would leave ${formatCents(availableAfter)} remaining in ${bucketLabel}.`
      : `This exceeds the available ${bucketLabel} balance by ${formatCents(Math.abs(availableAfter))}.`,
  };
}

async function handleProposeAllocationChange({ db, householdId, input }) {
  const report = await getDashboardReport({ db, householdId });
  const amountCents = parseMoneyToCents(input.amount);

  if (input.action === 'add_to_goal') {
    const goals = report.goal_progress ?? [];
    let goal;
    let goalSelection;

    if (input.targetId !== undefined) {
      // An explicit targetId must match exactly. Never fall back to another goal.
      goal = goals.find((g) => g.goal_id === input.targetId);
      if (!goal) {
        return { error: 'No goal matches the given targetId. Ask the user which goal to use.' };
      }
      goalSelection = 'explicit_target_id';
    } else {
      goal = goals[0];
      if (!goal) return { error: 'No goal found to apply this change to.' };
      goalSelection = 'defaulted_to_first_goal';
    }

    const goalName = nameText(goal.goal_name, 'Unnamed goal');
    const currentCents = parseMoneyToCents(goal.current_amount ?? '0.00');
    const targetCents = parseMoneyToCents(goal.target_amount ?? '0.00');
    const newCurrentCents = currentCents + amountCents;
    const newPercent = targetCents > 0
      ? Number(((newCurrentCents / targetCents) * 100).toFixed(1))
      : 0;

    return {
      type: 'proposal',
      action: 'add_to_goal',
      rationale: input.rationale,
      amount: input.amount,
      goal: {
        id: goal.goal_id,
        name: goalName,
        before: { current: goal.current_amount, progress_percent: goal.progress_percent },
        after: { current: formatCents(newCurrentCents), progress_percent: Math.min(newPercent, 100) },
        target: goal.target_amount,
      },
      goal_selection: goalSelection,
      selection_note: goalSelection === 'defaulted_to_first_goal'
        ? `No targetId was given, so this preview applies to the goal "${goalName}". Confirm that is the intended goal before proceeding.`
        : null,
      confirmation_required: true,
      note: 'This is a preview only. No data has been changed. Ask the user to confirm before executing.',
    };
  }

  if (input.action === 'redirect_surplus') {
    const periodSummary = report.periods?.[0] ?? {};
    const receivedCents = parseMoneyToCents(periodSummary.incomeTotal ?? '0.00');
    const spentCents = parseMoneyToCents(periodSummary.spendingTotal ?? '0.00');
    const surplusCents = Math.max(0, receivedCents - spentCents);

    return {
      type: 'proposal',
      action: 'redirect_surplus',
      rationale: input.rationale,
      amount: input.amount,
      surplus: {
        current_surplus: formatCents(surplusCents),
        amount_to_redirect: input.amount,
        surplus_after: formatCents(Math.max(0, surplusCents - amountCents)),
      },
      confirmation_required: true,
      note: 'This is a preview only. No data has been changed. Ask the user to confirm before executing.',
    };
  }

  return { error: `Unknown action: ${input.action}` };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const HANDLERS = {
  get_current_plan: handleGetCurrentPlan,
  get_available_resources: handleGetAvailableResources,
  get_upcoming_obligations: handleGetUpcomingObligations,
  get_goal_progress: handleGetGoalProgress,
  get_debt_strategy: handleGetDebtStrategy,
  get_cashflow_forecast: handleGetCashflowForecast,
  compare_periods: handleComparePeriods,
  explain_variance: handleExplainVariance,
  get_transaction_summary: handleGetTransactionSummary,
  create_scenario: handleCreateScenario,
  propose_allocation_change: handleProposeAllocationChange,
};

export async function dispatchToolCall({ name, input, db, householdId }) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }

  // Validate before any RAF calculation. An invalid input returns an error only.
  const parsed = toolInputSchemas[name].safeParse(input ?? {});
  if (!parsed.success) {
    return { error: `Invalid input for ${name}: ${formatToolInputIssues(parsed.error)}` };
  }

  try {
    const result = await handler({ db, householdId, input: parsed.data });
    if (result?.error) return result;
    // Every successful result may contain imported or user-entered text.
    return { ...result, data_untrusted: true };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}
