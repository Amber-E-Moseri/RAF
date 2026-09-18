import { parseMoneyToCents, formatCents } from '../raf/reporting.js';

const ACTIVITY_TYPES = new Set(['payment', 'interest', 'fee', 'adjustment', 'balance_reconciliation']);

function classifyAdjustmentType(adjustmentType) {
  if (adjustmentType === 'interest') return 'interest';
  if (adjustmentType === 'fee' || adjustmentType === 'late_fee') return 'fee';
  if (adjustmentType === 'reconciliation') return 'balance_reconciliation';
  return 'adjustment';
}

function resolvePaymentSource(debtPayment, transactionsByIdMap) {
  if (!debtPayment.transactionId) return 'manual';
  const transaction = transactionsByIdMap.get(debtPayment.transactionId);
  if (!transaction) return 'unknown';
  if (transaction.source === 'import') return 'import';
  if (transaction.source === 'buffer_disposition') return 'buffer';
  if (transaction.source === 'manual') {
    if (typeof transaction.description === 'string' && transaction.description.startsWith('Monthly review allocation:')) {
      return 'monthly_review';
    }
    return 'manual';
  }
  return 'unknown';
}

function resolveAdjustmentSource(adjustment) {
  if (adjustment.generated === true) return 'system';
  if (adjustment.adjustmentType === 'reconciliation') return 'reconciliation';
  return 'manual';
}

export function normalizeDebtPayment(debtPayment, transactionsByIdMap = new Map()) {
  const transaction = debtPayment.transactionId
    ? transactionsByIdMap.get(debtPayment.transactionId) ?? null
    : null;

  return {
    id: `payment:${debtPayment.id}`,
    debtId: debtPayment.debtId,
    workspaceId: debtPayment.householdId ?? debtPayment.workspaceId ?? null,
    type: 'payment',
    amountCents: parseMoneyToCents(debtPayment.amount),
    effectiveDate: debtPayment.paymentDate,
    source: resolvePaymentSource(debtPayment, transactionsByIdMap),
    transactionId: debtPayment.transactionId ?? null,
    importBatchId: transaction?.importBatchId ?? null,
    provenance: {
      recordType: 'debt_payment',
      recordId: debtPayment.id,
    },
  };
}

export function normalizeDebtAdjustment(adjustment) {
  return {
    id: `adjustment:${adjustment.id}`,
    debtId: adjustment.debtId,
    workspaceId: adjustment.householdId ?? adjustment.workspaceId ?? null,
    type: classifyAdjustmentType(adjustment.adjustmentType),
    amountCents: parseMoneyToCents(adjustment.amount),
    effectiveDate: adjustment.effectiveDate,
    source: resolveAdjustmentSource(adjustment),
    transactionId: null,
    importBatchId: null,
    provenance: {
      recordType: 'debt_adjustment',
      recordId: adjustment.id,
    },
  };
}

export function deriveDebtActivity({ payments = [], adjustments = [], transactionsByIdMap = new Map() }) {
  const activities = [];

  for (const payment of payments) {
    activities.push(normalizeDebtPayment(payment, transactionsByIdMap));
  }

  for (const adjustment of adjustments) {
    activities.push(normalizeDebtAdjustment(adjustment));
  }

  activities.sort((a, b) => {
    const dateCompare = String(a.effectiveDate).localeCompare(String(b.effectiveDate));
    if (dateCompare !== 0) return dateCompare;
    return a.id.localeCompare(b.id);
  });

  return activities;
}

export function deriveDebtMonthlyActivitySummary(activities, month) {
  const monthPrefix = month.slice(0, 7);

  const filtered = activities.filter((a) => {
    const activityMonth = String(a.effectiveDate).slice(0, 7);
    return activityMonth === monthPrefix;
  });

  let paymentsCents = 0;
  let interestCents = 0;
  let feesCents = 0;
  let adjustmentsCents = 0;
  let reconciliationCents = 0;

  for (const activity of filtered) {
    switch (activity.type) {
      case 'payment':
        paymentsCents += activity.amountCents;
        break;
      case 'interest':
        interestCents += activity.amountCents;
        break;
      case 'fee':
        feesCents += activity.amountCents;
        break;
      case 'adjustment':
        adjustmentsCents += activity.amountCents;
        break;
      case 'balance_reconciliation':
        reconciliationCents += activity.amountCents;
        break;
    }
  }

  return {
    month: monthPrefix,
    paymentsCents,
    interestCents,
    feesCents,
    adjustmentsCents,
    reconciliationCents,
    activityCount: filtered.length,
    payments: formatCents(paymentsCents),
    interest: formatCents(interestCents),
    fees: formatCents(feesCents),
    adjustments: formatCents(adjustmentsCents),
    activities: filtered,
  };
}

export function assessActivityCompleteness({ activities, balanceAuthority, openingBalanceCents, closingBalanceCents }) {
  if (activities.length === 0) {
    return balanceAuthority?.source === 'financial_account' ? 'balance_only' : 'balance_only';
  }

  if (balanceAuthority?.source === 'financial_account') {
    const authoritativeBalanceCents = parseMoneyToCents(balanceAuthority.balance);
    let paymentsCents = 0;
    let nonPaymentCents = 0;
    for (const a of activities) {
      if (a.type === 'payment') {
        paymentsCents += a.amountCents;
      } else {
        nonPaymentCents += a.amountCents;
      }
    }
    const expectedClosing = openingBalanceCents - paymentsCents + nonPaymentCents;
    const delta = Math.abs(authoritativeBalanceCents - expectedClosing);
    if (delta <= 100) return 'complete';
    return 'partial';
  }

  return 'complete';
}

export function deriveEconomicDebtActivity({ activities, reconciliations = [] }) {
  const excludedIds = new Set();
  for (const rec of reconciliations) {
    if (rec.status === 'confirmed') {
      excludedIds.add(rec.duplicatePaymentId);
    }
  }

  return activities.filter((a) => {
    const recordId = a.provenance?.recordId;
    return !excludedIds.has(recordId);
  });
}

export function deriveEconomicMonthlyActivitySummary(activities, month, reconciliations = []) {
  const economic = deriveEconomicDebtActivity({ activities, reconciliations });
  return deriveDebtMonthlyActivitySummary(economic, month);
}

export { ACTIVITY_TYPES };
