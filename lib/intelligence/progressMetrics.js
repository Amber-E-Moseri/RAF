/**
 * Then vs Now / Progress — compares historical financial position to current.
 * Every metric carries a provenance classification; only SNAPSHOT and
 * LEDGER_RECONSTRUCTED metrics enter comparisons.
 */

import { formatCents, parseMoneyToCents } from '../raf/reporting.js';
import { Provenance } from './provenance.js';

/**
 * Compute aggregate income/spending/surplus stats from closed monthly reviews.
 * Source: monthly_reviews (SNAPSHOT).
 *
 * @param {Array} closedReviews  monthly_review rows (all with net_surplus populated)
 * @param {Array} incomeEntries  income_entry rows for same period
 * @param {Array} transactions   transaction rows for same period
 * @returns {object} averaged metrics with provenance
 */
export function computeClosedMonthAverages(closedReviews, incomeEntries, transactions) {
  if (closedReviews.length === 0) {
    return { monthsAvailable: 0, metrics: [] };
  }

  const monthSet = new Set(closedReviews.map((r) => (r.reviewMonth ?? r.review_month).slice(0, 7)));

  // Income per closed month.
  const incomeByMonth = new Map();
  for (const entry of incomeEntries) {
    const m = (entry.receivedDate ?? entry.received_date ?? '').slice(0, 7);
    if (!monthSet.has(m)) continue;
    incomeByMonth.set(m, (incomeByMonth.get(m) ?? 0) + parseMoneyToCents(entry.amount));
  }

  // Spending per closed month.
  const spendByMonth = new Map();
  for (const tx of transactions) {
    if (tx.direction !== 'debit') continue;
    const m = (tx.transactionDate ?? tx.transaction_date ?? '').slice(0, 7);
    if (!monthSet.has(m)) continue;
    spendByMonth.set(m, (spendByMonth.get(m) ?? 0) + parseMoneyToCents(tx.amount));
  }

  // Surplus per closed month — directly from the snapshot.
  const surplusByMonth = new Map();
  for (const review of closedReviews) {
    const m = (review.reviewMonth ?? review.review_month).slice(0, 7);
    const s = review.netSurplus ?? review.net_surplus;
    if (s !== null && s !== undefined) {
      surplusByMonth.set(m, parseMoneyToCents(s));
    }
  }

  const months = [...monthSet].sort();
  const totalIncome = [...incomeByMonth.values()].reduce((a, b) => a + b, 0);
  const totalSpend = [...spendByMonth.values()].reduce((a, b) => a + b, 0);
  const totalSurplus = [...surplusByMonth.values()].reduce((a, b) => a + b, 0);
  const n = closedReviews.length;

  return {
    monthsAvailable: n,
    firstMonth: months[0] ?? null,
    lastMonth: months[months.length - 1] ?? null,
    metrics: [
      {
        key: 'avg_monthly_income',
        label: 'Average monthly income',
        value: formatCents(Math.round(totalIncome / n)),
        provenance: Provenance.SNAPSHOT,
        safe: true,
      },
      {
        key: 'avg_monthly_spending',
        label: 'Average monthly spending',
        value: formatCents(Math.round(totalSpend / n)),
        provenance: Provenance.LEDGER_RECONSTRUCTED,
        safe: true,
      },
      {
        key: 'avg_monthly_surplus',
        label: 'Average monthly surplus',
        value: formatCents(Math.round(totalSurplus / n)),
        provenance: Provenance.SNAPSHOT,
        safe: true,
      },
    ],
  };
}

/**
 * Compute a debt balance as-of a specific date from the ledger.
 * Source: debt_payments + debt_adjustments (LEDGER_RECONSTRUCTED).
 *
 * @param {object}  debt            debt record with starting_balance
 * @param {Array}   payments        debt_payment rows (payment_date, amount)
 * @param {Array}   adjustments     debt_adjustment rows (effective_date, amount)
 * @param {string}  asOfDate        ISO date
 * @returns {{ balanceCents: number, provenance: string }}
 */
export function computeDebtBalanceAsOf(debt, payments, adjustments, asOfDate) {
  const startingCents = parseMoneyToCents(debt.startingBalance ?? debt.starting_balance ?? 0);
  let balanceCents = startingCents;

  for (const p of payments) {
    const d = p.paymentDate ?? p.payment_date;
    if (d && d <= asOfDate) {
      balanceCents -= parseMoneyToCents(p.amount);
    }
  }

  for (const a of adjustments) {
    const d = a.effectiveDate ?? a.effective_date;
    if (d && d <= asOfDate) {
      balanceCents += parseMoneyToCents(a.amount); // positive = charge/interest, negative = correction
    }
  }

  return {
    balanceCents: Math.max(balanceCents, 0),
    formattedBalance: formatCents(Math.max(balanceCents, 0)),
    provenance: Provenance.LEDGER_RECONSTRUCTED,
    safe: true,
  };
}

/**
 * Build a Then vs Now comparison for a single metric.
 * Only compares metrics where both points have safe provenance.
 *
 * @param {object} then  { value: cents, provenance, label }
 * @param {object} now   { value: cents, provenance, label }
 * @param {string} key   Metric identifier
 */
export function buildThenVsNow(key, label, then, now) {
  const safe = then.provenance !== Provenance.CURRENT_ONLY
    && then.provenance !== Provenance.UNAVAILABLE
    && now.provenance !== Provenance.CURRENT_ONLY
    && now.provenance !== Provenance.UNAVAILABLE;

  if (!safe) {
    return { key, label, safe: false, reason: 'Insufficient historical data for this metric' };
  }

  const deltaCents = now.value - then.value;
  const deltaPercent = then.value !== 0
    ? Number(((deltaCents / Math.abs(then.value)) * 100).toFixed(1))
    : null;

  return {
    key,
    label,
    safe: true,
    then: { value: formatCents(then.value), provenance: then.provenance },
    now: { value: formatCents(now.value), provenance: now.provenance },
    delta: { value: formatCents(deltaCents), percent: deltaPercent },
  };
}
