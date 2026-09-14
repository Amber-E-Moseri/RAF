import { monthBounds } from '../dates.js';
import { resolveDebtBalanceAuthority } from '../debts/debtBalanceAuthority.js';
import { formatCents, parseMoneyToCents } from './reporting.js';

// Payment-pace tuning. `WELL_BELOW_PLAN_PCT` is the ceiling (percent of the planned
// payment) under which a sustained shortfall is worth surfacing as a below-plan warning.
// `SAVINGS_MIN_CENTS` is the Phase 5 threshold below which projected interest savings are
// not worth reporting.
const WELL_BELOW_PLAN_PCT = 60;
const SAVINGS_MIN_CENTS = 5000;

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

function addMonths(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function monthStartOf(date) {
  return `${date.slice(0, 7)}-01`;
}

function activeMonthBounds(activeMonth) {
  if (typeof activeMonth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(activeMonth)) {
    const [year, month] = activeMonth.split('-').map(Number);
    return monthBounds(year, month);
  }

  const now = new Date();
  return monthBounds(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

function shiftMonth(monthStart, offset) {
  return toIsoDate(addMonths(parseIsoDate(monthStart), offset));
}

function isDateBefore(left, right) {
  return String(left) < String(right);
}

function isDateWithin(date, start, end) {
  return String(date) >= String(start) && String(date) <= String(end);
}

function monthsBetween(leftDate, rightDate) {
  if (!leftDate || !rightDate) {
    return 0;
  }
  const [leftYear, leftMonth] = String(leftDate).slice(0, 7).split('-').map(Number);
  const [rightYear, rightMonth] = String(rightDate).slice(0, 7).split('-').map(Number);
  return (leftYear * 12 + leftMonth) - (rightYear * 12 + rightMonth);
}

function cycleDateForMonth(monthStart, dayOfMonth) {
  const anchor = parseIsoDate(monthStart);
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  return toIsoDate(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), Math.min(dayOfMonth, lastDay))));
}

function adjustmentAmountOnDate(adjustments, adjustmentType, effectiveDate) {
  return adjustments.some((adjustment) =>
    adjustment.adjustmentType === adjustmentType
    && adjustment.effectiveDate === effectiveDate
    && adjustment.generated !== true);
}

function feeAdjustmentType(adjustmentType) {
  return adjustmentType === 'late_fee' || adjustmentType === 'fee';
}

export function classifyPaymentPace({
  actualPaymentCents,
  minimumPaymentCents,
  monthlyPaymentCents,
  isPaymentDue,
}) {
  const actual = Math.max(0, Number(actualPaymentCents) || 0);
  const minimum = Math.max(0, Number(minimumPaymentCents) || 0);
  const planned = Math.max(0, Number(monthlyPaymentCents) || 0);
  const tolerance = planned > 0 ? Math.max(Math.round(planned * 0.05), 500) : 0;
  const lowerBound = Math.max(0, planned - tolerance);
  const upperBound = planned + tolerance;

  // State ladder follows Phase 7's clarification (which supersedes the self-inconsistent
  // Phase 2 table): exactly the minimum -> `minimum_only`; anything between the minimum and
  // the on-plan window -> `below_plan`.
  let pace = 'on_plan';
  if (actual === 0) {
    pace = 'no_payment';
  } else if (isPaymentDue && minimum > 0 && actual < minimum) {
    pace = 'under_minimum';
  } else if (minimum > 0 && actual === minimum && actual < lowerBound) {
    pace = 'minimum_only';
  } else if (planned <= 0) {
    pace = 'above_plan';
  } else if (actual < lowerBound) {
    pace = 'below_plan';
  } else if (actual > upperBound) {
    pace = 'above_plan';
  }

  return {
    pace,
    actualPaymentCents: actual,
    amountAboveMinimum: Math.max(0, actual - minimum),
    amountAbovePlan: pace === 'above_plan' ? Math.max(0, actual - planned) : 0,
    percentOfPlan: planned > 0 ? Number(((actual / planned) * 100).toFixed(1)) : 0,
    lowerBound,
    upperBound,
  };
}

export function getCompletedPaymentPeriods(payments = [], count = 3, activeMonth) {
  const currentMonth = monthStartOf(activeMonth ?? toIsoDate(new Date())).slice(0, 7);
  const grouped = new Map();

  for (const payment of payments) {
    const paymentMonth = String(payment.paymentDate ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(paymentMonth) || paymentMonth >= currentMonth) {
      continue;
    }
    grouped.set(paymentMonth, (grouped.get(paymentMonth) ?? 0) + parseMoneyToCents(payment.amount));
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, count)
    .map(([paymentPeriodMonth, amountCents]) => ({
      paymentPeriodMonth,
      amount: formatCents(amountCents),
      amountCents,
    }));
}

export function buildDebtPaymentInsight({
  debt,
  classifiedPace,
  actionablePaymentPeriod,
  currentBalance,
  avgMonthlyFeesCents = 0,
  observedMonthlyPaymentCents = null,
  observedBasis = null,
  acknowledged = false,
  currentObligationOpen = false,
}) {
  if (!debt || acknowledged || debt.isActive === false || !classifiedPace) {
    return null;
  }

  const plannedPaymentCents = parseMoneyToCents(debt.monthlyPayment ?? '0.00');
  const minimumPaymentCents = parseMoneyToCents(debt.minimumPayment ?? '0.00');
  if (plannedPaymentCents <= 0) {
    return null;
  }

  const pace = classifiedPace.pace;
  const percentOfPlan = classifiedPace.percentOfPlan;

  // Payment pace is one dimension only: how the payment compares to the user's plan.
  // Above plan -> informational; sustained well-below plan -> a slow-pace warning, but
  // only once the obligation is closed/overdue (an open obligation that is merely
  // partially funded is never a negative signal).
  let type = null;
  if (pace === 'above_plan') {
    type = 'above_plan_payment';
  } else if (
    (pace === 'below_plan' || pace === 'minimum_only')
    && percentOfPlan > 0
    && percentOfPlan < WELL_BELOW_PLAN_PCT
    && !currentObligationOpen
  ) {
    type = 'below_plan_warning';
  }
  if (!type) {
    return null;
  }

  const isBelowPlan = type === 'below_plan_warning';
  const actualPaymentCents = Math.max(0, Number(classifiedPace.actualPaymentCents) || 0);
  const suggestedPaymentCents = observedMonthlyPaymentCents && observedMonthlyPaymentCents > 0
    ? observedMonthlyPaymentCents
    : actualPaymentCents;
  const planned = estimateDebtPayoff(debt, currentBalance, avgMonthlyFeesCents);
  const observed = suggestedPaymentCents > 0
    ? estimateDebtPayoff({ ...debt, monthlyPayment: formatCents(suggestedPaymentCents) }, currentBalance, avgMonthlyFeesCents)
    : null;

  let acceleratedMonths;
  let interestSaved;
  if (planned?.estimatedPayoffDate && observed?.estimatedPayoffDate) {
    const monthDifference = monthsBetween(planned.estimatedPayoffDate, observed.estimatedPayoffDate);
    const interestSavingsCents = parseMoneyToCents(planned.totalInterestRemaining) - parseMoneyToCents(observed.totalInterestRemaining);
    if (isBelowPlan) {
      // Cost framing: negative months == payoff slips later; negative savings == extra interest.
      acceleratedMonths = monthDifference;
      interestSaved = formatCents(interestSavingsCents);
    } else if (monthDifference > 1 || interestSavingsCents > SAVINGS_MIN_CENTS) {
      // Phase 5: only report savings that are material.
      acceleratedMonths = Math.max(0, monthDifference);
      interestSaved = formatCents(Math.max(0, interestSavingsCents));
    }
  }

  // Phase 4: never extrapolate a projection from an incomplete current month.
  const includeProjections = Boolean(observed) && observedBasis !== 'this_month';

  return {
    type,
    ...(isBelowPlan ? { reason: 'well_below_plan' } : {}),
    actionablePaymentPeriod,
    actualPayment: formatCents(actualPaymentCents),
    plannedPayment: formatCents(plannedPaymentCents),
    minimumPayment: formatCents(minimumPaymentCents),
    ...(isBelowPlan
      ? { amountBelowPlan: formatCents(Math.max(0, plannedPaymentCents - actualPaymentCents)) }
      : {
        amountAbovePlan: formatCents(classifiedPace.amountAbovePlan),
        suggestedRecurringPayment: formatCents(suggestedPaymentCents),
      }),
    percentOfPlan,
    projections: includeProjections ? {
      planned,
      observed,
      observedBasis,
      ...(acceleratedMonths != null ? { acceleratedMonths } : {}),
      ...(interestSaved != null ? { interestSaved } : {}),
    } : undefined,
  };
}

function computeNextCycleDate(dayOfMonth, activeMonth, now = new Date()) {
  if (!dayOfMonth) {
    return null;
  }

  const { start } = activeMonthBounds(activeMonth);
  const referenceMonth = monthStartOf(toIsoDate(now));
  const baseMonth = start > referenceMonth ? start : referenceMonth;
  const thisCycleDate = cycleDateForMonth(baseMonth, dayOfMonth);
  return thisCycleDate >= toIsoDate(now) ? thisCycleDate : cycleDateForMonth(shiftMonth(baseMonth, 1), dayOfMonth);
}

function currentAsOfDate(activeMonth, now = new Date()) {
  const bounds = activeMonthBounds(activeMonth);
  const today = toIsoDate(now);
  const currentMonthStart = monthStartOf(today);
  return monthStartOf(bounds.start) === currentMonthStart
    ? (today < bounds.end ? today : bounds.end)
    : bounds.end;
}

function normalizePayments(payments = []) {
  return [...payments].sort((left, right) => String(left.paymentDate).localeCompare(String(right.paymentDate)));
}

function normalizeAdjustments(adjustments = []) {
  return [...adjustments].sort((left, right) =>
    String(left.effectiveDate).localeCompare(String(right.effectiveDate))
    || String(left.id ?? '').localeCompare(String(right.id ?? '')));
}

function buildGeneratedAdjustments(debt, payments = [], manualAdjustments = [], activeMonth, asOfDate) {
  const statementDay = debt.statementDay ?? null;
  const paymentDueDay = debt.paymentDueDay ?? null;
  const shouldPostInterest = debt.autoPostInterest === true && statementDay != null;
  const shouldPostLateFee = debt.autoPostLateFee === true && statementDay != null && paymentDueDay != null;

  if (!shouldPostInterest && !shouldPostLateFee) {
    return [];
  }

  const activeBounds = activeMonthBounds(activeMonth);
  const startMonth = debt.createdAt ? monthStartOf(debt.createdAt.slice(0, 10)) : activeBounds.start;
  const endMonth = monthStartOf(asOfDate ?? activeBounds.end);
  const monthlyRate = Number(debt.apr ?? 0) / 100 / 12;
  const minimumPaymentCents = parseMoneyToCents(debt.minimumPayment ?? '0.00');
  const lateFeeCents = parseMoneyToCents(debt.lateFeeAmount ?? '0.00');
  const sortedPayments = normalizePayments(payments);
  const sortedManualAdjustments = normalizeAdjustments(manualAdjustments);

  let cursor = startMonth;
  let runningBalanceCents = parseMoneyToCents(debt.startingBalance);
  const generated = [];

  while (cursor <= endMonth) {
    const { start, end } = activeMonthBounds(cursor);
    const monthPayments = sortedPayments.filter((payment) => isDateWithin(payment.paymentDate, start, end));
    const monthManualAdjustments = sortedManualAdjustments.filter((adjustment) => isDateWithin(adjustment.effectiveDate, start, end));

    if (shouldPostInterest) {
      const statementDate = cycleDateForMonth(cursor, statementDay);
      if (statementDate <= (asOfDate ?? activeBounds.end) && !adjustmentAmountOnDate(monthManualAdjustments, 'interest', statementDate)) {
        const interestCents = Math.round(runningBalanceCents * monthlyRate);
        if (interestCents > 0) {
          generated.push({
            id: `auto_interest_${debt.id}_${statementDate}`,
            debtId: debt.id,
            householdId: debt.householdId,
            amount: formatCents(interestCents),
            adjustmentType: 'interest',
            effectiveDate: statementDate,
            note: 'Auto-posted interest',
            createdAt: `${statementDate}T00:00:00.000Z`,
            generated: true,
          });
          runningBalanceCents += interestCents;
        }
      }
    }

    const paymentsThisCycleCents = monthPayments.reduce((sum, payment) => sum + parseMoneyToCents(payment.amount), 0);

    if (shouldPostLateFee) {
      const dueDate = cycleDateForMonth(cursor, paymentDueDay);
      if (dueDate <= (asOfDate ?? activeBounds.end) && paymentsThisCycleCents < minimumPaymentCents && lateFeeCents > 0) {
        if (!adjustmentAmountOnDate(monthManualAdjustments, 'late_fee', dueDate) && !adjustmentAmountOnDate(monthManualAdjustments, 'fee', dueDate)) {
          generated.push({
            id: `auto_late_fee_${debt.id}_${dueDate}`,
            debtId: debt.id,
            householdId: debt.householdId,
            amount: formatCents(lateFeeCents),
            adjustmentType: 'late_fee',
            effectiveDate: dueDate,
            note: 'Auto-posted late fee',
            createdAt: `${dueDate}T00:00:00.000Z`,
            generated: true,
          });
        }
      }
    }

    const totalMonthAdjustmentCents = [...monthManualAdjustments, ...generated.filter((adjustment) => isDateWithin(adjustment.effectiveDate, start, end))].reduce(
      (sum, adjustment) => sum + parseMoneyToCents(adjustment.amount),
      0,
    );
    runningBalanceCents = Math.max(0, runningBalanceCents + totalMonthAdjustmentCents - paymentsThisCycleCents);
    cursor = shiftMonth(cursor, 1);
  }

  return normalizeAdjustments(generated);
}

function paymentStatusFromActivity({
  closingBalanceCents,
  dueDate,
  minimumPaymentCents,
  actualPaymentCents,
  interestChargedCents,
  asOfDate,
}) {
  if (closingBalanceCents <= 1) {
    return 'paid_off';
  }

  const paymentDue = Boolean(dueDate) && String(asOfDate) >= String(dueDate);

  if (paymentDue && minimumPaymentCents > 0 && actualPaymentCents === 0) {
    return 'missed_payment';
  }

  if (paymentDue && actualPaymentCents > 0 && actualPaymentCents < minimumPaymentCents) {
    return 'under_minimum';
  }

  if (actualPaymentCents > 0 && actualPaymentCents <= interestChargedCents) {
    return 'at_risk';
  }

  if (actualPaymentCents > interestChargedCents) {
    return 'paying_down';
  }

  return 'current';
}

export function deriveDebtMonthlyActivity(debt, payments = [], adjustments = [], activeMonth) {
  const asOfDate = currentAsOfDate(activeMonth);
  const generatedAdjustments = buildGeneratedAdjustments(debt, payments, adjustments, activeMonth, asOfDate);
  const mergedAdjustments = normalizeAdjustments([...adjustments, ...generatedAdjustments]);
  const { start, end } = activeMonthBounds(activeMonth);
  const minimumPaymentCents = parseMoneyToCents(debt.minimumPayment ?? '0.00');
  const dueDate = debt.paymentDueDay ? cycleDateForMonth(monthStartOf(asOfDate), debt.paymentDueDay) : null;

  const paymentsBeforeMonthCents = payments.reduce((sum, payment) => (
    isDateBefore(payment.paymentDate, start) ? sum + parseMoneyToCents(payment.amount) : sum
  ), 0);
  const adjustmentsBeforeMonthCents = mergedAdjustments.reduce((sum, adjustment) => (
    isDateBefore(adjustment.effectiveDate, start) ? sum + parseMoneyToCents(adjustment.amount) : sum
  ), 0);
  const openingBalanceCents = Math.max(
    0,
    parseMoneyToCents(debt.startingBalance) - paymentsBeforeMonthCents + adjustmentsBeforeMonthCents,
  );

  const paymentsThisMonthCents = payments.reduce((sum, payment) => (
    isDateWithin(payment.paymentDate, start, asOfDate) ? sum + parseMoneyToCents(payment.amount) : sum
  ), 0);
  const interestChargedThisMonthCents = mergedAdjustments.reduce((sum, adjustment) => (
    adjustment.adjustmentType === 'interest' && isDateWithin(adjustment.effectiveDate, start, asOfDate)
      ? sum + parseMoneyToCents(adjustment.amount)
      : sum
  ), 0);
  const feesThisMonthCents = mergedAdjustments.reduce((sum, adjustment) => (
    feeAdjustmentType(adjustment.adjustmentType) && isDateWithin(adjustment.effectiveDate, start, asOfDate)
      ? sum + parseMoneyToCents(adjustment.amount)
      : sum
  ), 0);

  const closingBalanceCents = Math.max(
    0,
    openingBalanceCents + interestChargedThisMonthCents + feesThisMonthCents - paymentsThisMonthCents,
  );

  return {
    openingBalance: formatCents(openingBalanceCents),
    interestChargedThisMonth: formatCents(interestChargedThisMonthCents),
    feesThisMonth: formatCents(feesThisMonthCents),
    paymentsThisMonth: formatCents(paymentsThisMonthCents),
    principalReductionThisMonth: formatCents(Math.max(0, paymentsThisMonthCents - interestChargedThisMonthCents - feesThisMonthCents)),
    closingBalance: formatCents(closingBalanceCents),
    paymentStatus: paymentStatusFromActivity({
    closingBalanceCents,
      dueDate,
      minimumPaymentCents,
      actualPaymentCents: paymentsThisMonthCents,
      interestChargedCents: interestChargedThisMonthCents,
      asOfDate,
    }),
    nextStatementDate: computeNextCycleDate(debt.statementDay ?? null, activeMonth),
    nextPaymentDueDate: computeNextCycleDate(debt.paymentDueDay ?? null, activeMonth),
    generatedAdjustments,
    asOfDate,
  };
}

export function estimateDebtPayoff(debt, currentBalance, avgMonthlyFeesCents = 0) {
  const currentBalanceCents = parseMoneyToCents(currentBalance ?? debt.currentBalance ?? debt.startingBalance);
  if (currentBalanceCents <= 1) {
    return {
      estimatedPayoffDate: toIsoDate(new Date()),
      monthsRemaining: 0,
      totalInterestRemaining: '0.00',
    };
  }

  const monthlyPaymentCents = parseMoneyToCents(debt.monthlyPayment ?? '0.00');
  const monthlyRate = Number(debt.apr ?? 0) / 100 / 12;
  const firstMonthInterestCents = Math.round(currentBalanceCents * monthlyRate) + avgMonthlyFeesCents;

  if (monthlyPaymentCents <= 0 || monthlyPaymentCents <= firstMonthInterestCents) {
    return {
      estimatedPayoffDate: null,
      monthsRemaining: null,
      totalInterestRemaining: null,
    };
  }

  let remainingBalanceCents = currentBalanceCents;
  let totalInterestCents = 0;
  let monthsRemaining = 0;
  const maxMonths = 1200;

  while (remainingBalanceCents > 0 && monthsRemaining < maxMonths) {
    const interestCents = Math.round(remainingBalanceCents * monthlyRate) + avgMonthlyFeesCents;
    totalInterestCents += interestCents;
    remainingBalanceCents += interestCents;

    if (monthlyPaymentCents <= interestCents) {
      return {
        estimatedPayoffDate: null,
        monthsRemaining: null,
        totalInterestRemaining: null,
      };
    }

    remainingBalanceCents = Math.max(0, remainingBalanceCents - monthlyPaymentCents);
    monthsRemaining += 1;
  }

  if (remainingBalanceCents > 0) {
    return {
      estimatedPayoffDate: null,
      monthsRemaining: null,
      totalInterestRemaining: null,
    };
  }

  return {
    estimatedPayoffDate: toIsoDate(addMonths(new Date(), monthsRemaining)),
    monthsRemaining,
    totalInterestRemaining: formatCents(totalInterestCents),
  };
}

export function compareDebtPriority(left, right) {
  return (Number(right.apr ?? 0) - Number(left.apr ?? 0))
    || (parseMoneyToCents(right.currentBalance ?? right.startingBalance) - parseMoneyToCents(left.currentBalance ?? left.startingBalance))
    || (() => {
      const leftMonths = left.monthsRemaining;
      const rightMonths = right.monthsRemaining;
      if (leftMonths == null && rightMonths == null) {
        return 0;
      }
      if (leftMonths == null) {
        return 1;
      }
      if (rightMonths == null) {
        return -1;
      }
      return leftMonths - rightMonths;
    })()
    || String(left.name ?? '').localeCompare(String(right.name ?? ''));
}

export function deriveDebtSnapshot(debt, payments = [], adjustments = [], activeMonth) {
  const monthlyActivity = deriveDebtMonthlyActivity(debt, payments, adjustments, activeMonth);
  const balanceAuthority = debt.balanceAuthority ?? resolveDebtBalanceAuthority({
    debt,
    financialAccount: debt.financialAccount ?? null,
  });
  const mergedAdjustments = normalizeAdjustments([...adjustments, ...monthlyActivity.generatedAdjustments])
    .filter((adjustment) => String(adjustment.effectiveDate) <= String(monthlyActivity.asOfDate));
  const startingBalanceCents = parseMoneyToCents(debt.startingBalance);
  const totalPaidCents = payments
    .filter((payment) => String(payment.paymentDate) <= String(monthlyActivity.asOfDate))
    .reduce((sum, payment) => sum + parseMoneyToCents(payment.amount), 0);
  const totalAdjustedCents = mergedAdjustments.reduce((sum, adjustment) => sum + parseMoneyToCents(adjustment.amount), 0);
  const derivedBalanceCents = Math.max(0, startingBalanceCents - totalPaidCents + totalAdjustedCents);
  const currentBalanceCents = balanceAuthority.source === 'financial_account'
    ? parseMoneyToCents(balanceAuthority.balance)
    : derivedBalanceCents;
  const generatedFees = monthlyActivity.generatedAdjustments.filter((a) => feeAdjustmentType(a.adjustmentType));
  const interestMonthCount = monthlyActivity.generatedAdjustments.filter((a) => a.adjustmentType === 'interest').length;
  const avgMonthlyFeesCents = interestMonthCount > 0
    ? Math.round(generatedFees.reduce((sum, a) => sum + parseMoneyToCents(a.amount), 0) / interestMonthCount)
    : 0;
  const payoffEstimate = estimateDebtPayoff(debt, formatCents(currentBalanceCents), avgMonthlyFeesCents);
  const minimumPaymentCents = parseMoneyToCents(debt.minimumPayment ?? '0.00');
  const monthlyPaymentCents = parseMoneyToCents(debt.monthlyPayment ?? '0.00');
  const actualPaymentCents = parseMoneyToCents(monthlyActivity.paymentsThisMonth);
  const actionablePaymentPeriod = monthStartOf(activeMonth ?? monthlyActivity.asOfDate).slice(0, 7);
  const dueDate = debt.paymentDueDay ? cycleDateForMonth(monthStartOf(monthlyActivity.asOfDate), debt.paymentDueDay) : null;
  const shouldComputePace = debt.isActive !== false && currentBalanceCents > 1 && monthlyPaymentCents > 0;
  const classifiedPace = shouldComputePace ? classifyPaymentPace({
    actualPaymentCents,
    minimumPaymentCents,
    monthlyPaymentCents,
    isPaymentDue: Boolean(dueDate) && String(monthlyActivity.asOfDate) >= String(dueDate),
  }) : null;
  const completedPeriods = getCompletedPaymentPeriods(payments, 3, activeMonth ?? monthlyActivity.asOfDate);
  // Phase 4: 3-month rolling average once there are three completed periods; otherwise the
  // single most recent completed period. Never blend in the incomplete current month.
  const observedMonthlyPaymentCents = completedPeriods.length >= 3
    ? Math.round(completedPeriods.reduce((sum, period) => sum + period.amountCents, 0) / completedPeriods.length)
    : completedPeriods.length > 0
      ? completedPeriods[0].amountCents
      : actualPaymentCents;
  const currentObligationOpen = Boolean(dueDate) && String(monthlyActivity.asOfDate) <= String(dueDate);
  const insightAcknowledged = Boolean(debt.paymentPaceAcknowledgement);
  const paymentInsight = classifiedPace ? buildDebtPaymentInsight({
    debt,
    classifiedPace,
    actionablePaymentPeriod,
    currentBalance: formatCents(currentBalanceCents),
    avgMonthlyFeesCents,
    observedMonthlyPaymentCents,
    observedBasis: completedPeriods.length >= 3 ? 'three_month_average' : completedPeriods.length > 0 ? 'latest_completed_month' : 'this_month',
    acknowledged: insightAcknowledged,
    currentObligationOpen,
  }) : null;

  // Independent dimensions (never derived from payment pace): the obligation status for the
  // active period, the balance direction, and a plain-language explanation of the change.
  const openingBalanceCents = parseMoneyToCents(monthlyActivity.openingBalance);
  const closingBalanceCents = parseMoneyToCents(monthlyActivity.closingBalance);
  const periodStartDate = monthStartOf(monthlyActivity.asOfDate);
  const manualAdjustmentsThisPeriodCents = adjustments
    .filter((adjustment) => adjustment.generated !== true
      && String(adjustment.effectiveDate) >= String(periodStartDate)
      && String(adjustment.effectiveDate) <= String(monthlyActivity.asOfDate))
    .reduce((sum, adjustment) => sum + parseMoneyToCents(adjustment.amount), 0);
  const trackBalanceHealth = debt.isActive !== false && currentBalanceCents > 1;
  const paymentObligation = debt.isActive !== false
    ? derivePaymentObligation({
      debt,
      payments,
      obligationMonth: actionablePaymentPeriod,
      asOfDate: monthlyActivity.asOfDate,
    })
    : null;
  const balanceTrajectory = trackBalanceHealth
    ? deriveBalanceTrajectory({ openingBalanceCents, closingBalanceCents })
    : null;
  const balanceExplanation = trackBalanceHealth
    ? explainBalanceChange({
      openingBalanceCents,
      closingBalanceCents,
      paymentsThisPeriodCents: parseMoneyToCents(monthlyActivity.paymentsThisMonth),
      interestChargedCents: parseMoneyToCents(monthlyActivity.interestChargedThisMonth),
      feesChargedCents: parseMoneyToCents(monthlyActivity.feesThisMonth),
      adjustmentsCents: manualAdjustmentsThisPeriodCents,
    })
    : null;

  return {
    ...debt,
    currentBalance: formatCents(currentBalanceCents),
    totalPaidAllTime: formatCents(totalPaidCents),
    totalAdjustments: formatCents(totalAdjustedCents),
    status: currentBalanceCents <= 1 ? 'paid_off' : 'current',
    financialAccountId: debt.financialAccountId ?? debt.financial_account_id ?? null,
    balanceAuthority,
    openingBalance: monthlyActivity.openingBalance,
    interestChargedThisMonth: monthlyActivity.interestChargedThisMonth,
    feesThisMonth: monthlyActivity.feesThisMonth,
    paymentsThisMonth: monthlyActivity.paymentsThisMonth,
    principalReductionThisMonth: monthlyActivity.principalReductionThisMonth,
    closingBalance: monthlyActivity.closingBalance,
    paymentStatus: monthlyActivity.paymentStatus,
    nextStatementDate: monthlyActivity.nextStatementDate,
    nextPaymentDueDate: monthlyActivity.nextPaymentDueDate,
    estimatedPayoffDate: payoffEstimate.estimatedPayoffDate,
    monthsRemaining: payoffEstimate.monthsRemaining,
    totalInterestRemaining: payoffEstimate.totalInterestRemaining,
    paymentPace: classifiedPace ? {
      pace: classifiedPace.pace,
      actualPayment: formatCents(actualPaymentCents),
      plannedPayment: formatCents(monthlyPaymentCents),
      minimumPayment: formatCents(minimumPaymentCents),
      amountAboveMinimum: formatCents(classifiedPace.amountAboveMinimum),
      amountAbovePlan: formatCents(classifiedPace.amountAbovePlan),
      percentOfPlan: classifiedPace.percentOfPlan,
      lowerBound: formatCents(classifiedPace.lowerBound),
      upperBound: formatCents(classifiedPace.upperBound),
    } : null,
    paymentInsight,
    insightAcknowledged,
    paymentObligation,
    balanceTrajectory,
    balanceExplanation,
  };
}

export function derivePaymentObligation({
  debt,
  payments = [],
  obligationMonth,
  asOfDate,
}) {
  if (!debt.statementDay || !debt.paymentDueDay) {
    return null;
  }

  const [obligationYear, obligationMonthNum] = obligationMonth.split('-').map(Number);
  const monthStart = toIsoDate(new Date(Date.UTC(obligationYear, obligationMonthNum - 1, 1)));
  const { start, end } = monthBounds(obligationYear, obligationMonthNum);

  const dueDate = cycleDateForMonth(monthStart, debt.paymentDueDay);
  const minimumPaymentCents = parseMoneyToCents(debt.minimumPayment ?? '0.00');
  const plannedAmountCents = parseMoneyToCents(debt.monthlyPayment ?? '0.00');

  const obligationPayments = payments.filter((p) =>
    String(p.paymentDate) >= String(start) && String(p.paymentDate) <= String(end)
  );
  const totalPaidCents = obligationPayments.reduce((sum, p) => sum + parseMoneyToCents(p.amount), 0);

  // Compliance is judged on the aggregate of every payment in the obligation window, and an
  // obligation that is still open (before its due date) is never a negative signal —
  // partial funding reads as `in_progress`, not `under_minimum` / `missed_payment`.
  const isOverdue = asOfDate ? String(asOfDate) > String(dueDate) : false;
  let status;
  if (totalPaidCents >= plannedAmountCents || totalPaidCents >= minimumPaymentCents) {
    status = 'satisfied';
  } else if (totalPaidCents === 0) {
    status = isOverdue ? 'missed_payment' : 'pending';
  } else {
    status = isOverdue ? 'under_minimum' : 'in_progress';
  }

  return {
    periodStart: start,
    periodEnd: end,
    dueDate,
    minimumDue: formatCents(minimumPaymentCents),
    plannedAmount: formatCents(plannedAmountCents),
    payments: obligationPayments,
    totalPaidToDate: formatCents(totalPaidCents),
    minimumRemaining: formatCents(Math.max(0, minimumPaymentCents - totalPaidCents)),
    plannedRemaining: formatCents(Math.max(0, plannedAmountCents - totalPaidCents)),
    status,
    minimumSatisfied: totalPaidCents >= minimumPaymentCents,
    planSatisfied: totalPaidCents >= plannedAmountCents,
  };
}

export function deriveBalanceTrajectory({
  openingBalanceCents,
  closingBalanceCents,
}) {
  const changeCents = closingBalanceCents - openingBalanceCents;
  const tolerance = Math.max(Math.round(closingBalanceCents * 0.001), 100);

  let trajectory = 'stable';
  if (changeCents < -tolerance) {
    trajectory = 'decreasing';
  } else if (changeCents > tolerance) {
    trajectory = 'increasing';
  }

  const percentageChange = openingBalanceCents > 0
    ? ((closingBalanceCents - openingBalanceCents) / openingBalanceCents) * 100
    : 0;

  return {
    trajectory,
    absoluteChange: changeCents,
    percentageChange: Number(percentageChange.toFixed(2)),
    tolerance,
    isIncreasing: changeCents > tolerance,
    isDecreasing: changeCents < -tolerance,
    isStable: Math.abs(changeCents) <= tolerance,
    // A growing balance is always worth surfacing, independent of payment pace.
    warning: trajectory === 'increasing',
  };
}

export function explainBalanceChange({
  openingBalanceCents,
  closingBalanceCents,
  paymentsThisPeriodCents = 0,
  interestChargedCents = 0,
  feesChargedCents = 0,
  adjustmentsCents = 0,
}) {
  const expectedClosing = openingBalanceCents + interestChargedCents + feesChargedCents + adjustmentsCents - paymentsThisPeriodCents;
  const unexplainedCents = closingBalanceCents - expectedClosing;
  // Balance-increasing activity that is not interest or fees: positive adjustments (manual
  // charges/corrections) plus anything the model cannot otherwise account for. This is what
  // "new borrowing / new charges" looks like in the ledger.
  const newActivityCents = Math.max(0, adjustmentsCents) + Math.max(0, unexplainedCents);

  return {
    openingBalance: formatCents(openingBalanceCents),
    payments: formatCents(-paymentsThisPeriodCents),
    interest: formatCents(interestChargedCents),
    fees: formatCents(feesChargedCents),
    adjustments: formatCents(adjustmentsCents),
    newActivity: formatCents(newActivityCents),
    unexplained: formatCents(unexplainedCents),
    closingBalance: formatCents(closingBalanceCents),
    changeMessage: buildBalanceChangeMessage({
      openingCents: openingBalanceCents,
      closingCents: closingBalanceCents,
      paymentsCents: paymentsThisPeriodCents,
      interestCents: interestChargedCents,
      feesCents: feesChargedCents,
      newActivityCents,
      unexplainedCents,
    }),
  };
}

function buildBalanceChangeMessage({
  openingCents,
  closingCents,
  paymentsCents,
  interestCents,
  feesCents,
  newActivityCents,
  unexplainedCents,
}) {
  const parts = [];

  if (paymentsCents > 0) {
    parts.push(`You paid ${formatCents(paymentsCents)}`);
  }

  if (interestCents > 0) {
    parts.push(`and interest was ${formatCents(interestCents)}`);
  }

  if (feesCents > 0) {
    parts.push(`plus fees of ${formatCents(feesCents)}`);
  }

  if (newActivityCents >= 50) {
    parts.push(`plus new charges or borrowing of ${formatCents(newActivityCents)}`);
  } else if (unexplainedCents <= -50) {
    parts.push(`less other changes of ${formatCents(-unexplainedCents)}`);
  }

  const change = closingCents - openingCents;
  const direction = change > 0 ? 'increased' : change < 0 ? 'decreased' : 'stayed the same';

  if (parts.length === 0) {
    return `Your balance ${direction} by ${formatCents(Math.abs(change))}.`;
  }

  const activity = parts.join(', ');
  return `${activity}, ${direction} your balance by ${formatCents(Math.abs(change))}.`;
}

export function buildDebtListResponse(debts, debtPaymentsByDebtId, debtAdjustmentsByDebtId = new Map(), activeMonth, acknowledgementsByDebtId = new Map()) {
  const snapshots = debts.map((debt) => deriveDebtSnapshot(
    { ...debt, paymentPaceAcknowledgement: acknowledgementsByDebtId.get(debt.id) ?? null },
    debtPaymentsByDebtId.get(debt.id) ?? [],
    debtAdjustmentsByDebtId.get(debt.id) ?? [],
    activeMonth,
  )).sort(compareDebtPriority);

  const summary = snapshots.reduce(
    (totals, debt) => ({
      totalStartingCents: totals.totalStartingCents + parseMoneyToCents(debt.startingBalance),
      totalRemainingCents: totals.totalRemainingCents + parseMoneyToCents(debt.currentBalance),
      totalPaidAllTimeCents: totals.totalPaidAllTimeCents + parseMoneyToCents(debt.totalPaidAllTime),
    }),
    {
      totalStartingCents: 0,
      totalRemainingCents: 0,
      totalPaidAllTimeCents: 0,
    },
  );

  return {
    items: snapshots.map((debt) => ({
      id: debt.id,
      name: debt.name,
      startingBalance: debt.startingBalance,
      currentBalance: debt.currentBalance,
      financialAccountId: debt.financialAccountId ?? null,
      balanceAuthority: debt.balanceAuthority ?? null,
      apr: debt.apr,
      minimumPayment: debt.minimumPayment,
      monthlyPayment: debt.monthlyPayment,
      statementDay: debt.statementDay ?? null,
      paymentDueDay: debt.paymentDueDay ?? null,
      lateFeeAmount: debt.lateFeeAmount ?? '0.00',
      autoPostInterest: debt.autoPostInterest === true,
      autoPostLateFee: debt.autoPostLateFee === true,
      status: debt.status,
      sortOrder: debt.sortOrder,
      isActive: debt.isActive,
      totalAdjustments: debt.totalAdjustments,
      openingBalance: debt.openingBalance,
      paymentsThisMonth: debt.paymentsThisMonth,
      interestChargedThisMonth: debt.interestChargedThisMonth,
      feesThisMonth: debt.feesThisMonth,
      principalReductionThisMonth: debt.principalReductionThisMonth,
      closingBalance: debt.closingBalance,
      paymentStatus: debt.paymentStatus,
      nextStatementDate: debt.nextStatementDate,
      nextPaymentDueDate: debt.nextPaymentDueDate,
      estimatedPayoffDate: debt.estimatedPayoffDate,
      monthsRemaining: debt.monthsRemaining,
      totalInterestRemaining: debt.totalInterestRemaining,
      paymentPace: debt.paymentPace,
      paymentInsight: debt.paymentInsight,
      insightAcknowledged: debt.insightAcknowledged,
      paymentObligation: debt.paymentObligation ?? null,
      balanceTrajectory: debt.balanceTrajectory ?? null,
      balanceExplanation: debt.balanceExplanation ?? null,
    })),
    summary: {
      totalStarting: formatCents(summary.totalStartingCents),
      totalRemaining: formatCents(summary.totalRemainingCents),
      totalPaidAllTime: formatCents(summary.totalPaidAllTimeCents),
    },
  };
}
