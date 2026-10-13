import { listAllTransactionsInRange, parseMoneyToCents, formatCents } from '../raf/reporting.js';

/**
 * Builds a structured export payload for a workspace's financial data.
 *
 * Exports: transactions, income, debts, goals, monthly reviews,
 * allocation categories. Does not export raw bank statement text,
 * PDF content, or any PII beyond what the user themselves entered.
 *
 * @param {object} opts
 * @param {object} opts.db - DB adapter
 * @param {string} opts.householdId
 * @param {string} [opts.fromMonth] - ISO date (YYYY-MM-DD), inclusive
 * @param {string} [opts.toMonth]   - ISO date (YYYY-MM-DD), inclusive
 */
export async function buildDataExport({ db, householdId, fromMonth = null, toMonth = null }) {
  return db.transaction(async (tx) => {
    const allTransactions = await listAllTransactionsInRange(tx, { householdId });
    const allIncome = (await tx.listIncomeEntries({ householdId })) ?? [];
    const allDebts = (await tx.listDebts({ householdId })) ?? [];
    const allGoals = (await tx.listGoals({ householdId })) ?? [];
    const allReviews = (await tx.listMonthlyReviews({ householdId })) ?? [];
    const allCategories = (await tx.listAllocationCategories({ householdId })) ?? [];

    const inRange = (dateStr) => {
      if (!dateStr) return true;
      const d = dateStr.slice(0, 10);
      if (fromMonth && d < fromMonth) return false;
      if (toMonth && d > toMonth) return false;
      return true;
    };

    const transactions = allTransactions
      .filter((t) => inRange(t.transactionDate ?? t.date))
      .map((t) => ({
        id: t.id,
        date: t.transactionDate ?? t.date,
        merchant: t.merchant ?? null,
        description: t.description ?? null,
        amount: t.amount,
        direction: t.direction,
        category_slug: t.categorySlug ?? null,
        source: t.source ?? null,
      }));

    const income = allIncome
      .filter((e) => inRange(e.receivedDate ?? e.date))
      .map((e) => ({
        id: e.id,
        date: e.receivedDate ?? e.date,
        source: e.sourceName ?? e.source_name ?? null,
        amount: e.amount,
      }));

    const debts = allDebts.map((d) => ({
      id: d.id,
      name: d.name,
      balance: d.currentBalance ?? d.startingBalance,
      apr: d.interestRate ?? d.apr ?? null,
      minimum_payment: d.minimumPayment ?? d.minimum_payment ?? null,
    }));

    const goals = allGoals.map((g) => ({
      id: g.id,
      name: g.name,
      target_amount: g.targetAmount ?? g.target_amount,
      current_amount: g.currentAmount ?? g.current_amount ?? '0.00',
    }));

    const monthlyReviews = allReviews
      .filter((r) => inRange(r.month))
      .map((r) => ({
        id: r.id,
        month: r.month,
        status: r.status,
        net_surplus: r.netSurplus ?? r.net_surplus ?? null,
      }));

    const allocationCategories = allCategories.map((c) => ({
      slug: c.slug,
      label: c.label,
      allocation_percent: c.allocationPercent ?? c.allocation_percent,
      is_active: c.isActive ?? c.is_active,
    }));

    return {
      exported_at: new Date().toISOString(),
      household_id: householdId,
      date_range: { from: fromMonth ?? null, to: toMonth ?? null },
      transactions,
      income,
      debts,
      goals,
      monthly_reviews: monthlyReviews,
      allocation_categories: allocationCategories,
    };
  });
}

/**
 * Converts a row array to CSV string with proper quoting.
 */
export function rowsToCsv(headers, rows) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}
