import { formatCents, parseMoneyToCents } from './reporting.js';

// ── Account type semantics ────────────────────────────────────────────────────

// Only these account types contribute to the forecasted liquid starting balance.
// investment accounts are excluded — they are not available for routine spending.
// credit_card, line_of_credit, loan are liabilities and must never inflate cash.
const LIQUID_ASSET_TYPES = new Set(['checking', 'savings', 'cash', 'other']);
const INVESTMENT_TYPES = new Set(['investment']);
const LIABILITY_TYPES = new Set(['credit_card', 'line_of_credit', 'loan']);

// ── Date helpers ─────────────────────────────────────────────────────────────

function parseDate(isoDate) {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

function monthStartOf(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function nextMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function daysInMonthOf(year, month1Based) {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

function clampDay(year, month1Based, day) {
  return Math.min(day, daysInMonthOf(year, month1Based));
}

// ── Trailing averages ────────────────────────────────────────────────────────

/**
 * Compute average monthly income (cents) from the 3 calendar months prior to startDate.
 */
function trailingMonthlyIncomeCents(incomeEntries, startDate, count = 3) {
  const totals = new Map();
  for (let i = 1; i <= count; i++) {
    const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() - i, 1));
    totals.set(d.toISOString().slice(0, 7), 0);
  }

  for (const entry of incomeEntries) {
    const mk = String(entry.receivedDate ?? '').slice(0, 7);
    if (totals.has(mk)) {
      totals.set(mk, totals.get(mk) + parseMoneyToCents(entry.amount ?? '0.00'));
    }
  }

  const total = [...totals.values()].reduce((s, v) => s + v, 0);
  return Math.round(total / count);
}

/**
 * Compute 3-month trailing average spending per active category (cents/month).
 *
 * @param {Set<string>} excludedSlugs - Category slugs to exclude from baselines.
 *   Pass the slugs of categories already represented as confirmed obligations
 *   (e.g. fixed_bill categories, debt_payment) to prevent double-counting.
 */
function trailingCategoryBaselines(transactions, activeCategories, startDate, count = 3, excludedSlugs = new Set()) {
  const monthKeys = new Set();
  for (let i = 1; i <= count; i++) {
    const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() - i, 1));
    monthKeys.add(d.toISOString().slice(0, 7));
  }

  // Only include categories not represented as explicit confirmed/expected obligations.
  const eligibleCategories = activeCategories.filter((c) => !excludedSlugs.has(c.slug));
  const totals = new Map(eligibleCategories.map((c) => [c.id, 0]));

  for (const tx of transactions) {
    if (tx.direction !== 'debit') continue;
    if (!tx.categoryId || !totals.has(tx.categoryId)) continue;
    const mk = String(tx.transactionDate ?? '').slice(0, 7);
    if (!monthKeys.has(mk)) continue;
    totals.set(tx.categoryId, totals.get(tx.categoryId) + Math.abs(parseMoneyToCents(tx.amount ?? '0.00')));
  }

  return eligibleCategories.map((cat) => ({
    categoryId: cat.id,
    slug: cat.slug,
    label: cat.label ?? cat.slug,
    monthlyAverageCents: Math.round((totals.get(cat.id) ?? 0) / count),
    confidence: 'estimated',
  }));
}

// ── Projection builders ──────────────────────────────────────────────────────

/**
 * Map of date → income cents.
 * Income is expected on the 15th of each month in the window (mid-month proxy).
 * Income never appears before startDate; future income is NEVER included in current available resources.
 */
function buildIncomeByDate(avgMonthlyCents, startDate, forecastDays) {
  if (avgMonthlyCents <= 0) return new Map();

  const endDate = addDays(startDate, forecastDays - 1);
  const byDate = new Map();
  let cursor = monthStartOf(startDate);

  while (cursor <= endDate) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const day = clampDay(y, m, 15);
    const incomeDate = new Date(Date.UTC(y, m - 1, day));

    if (incomeDate >= startDate && incomeDate <= endDate) {
      const ds = formatDate(incomeDate);
      byDate.set(ds, (byDate.get(ds) ?? 0) + avgMonthlyCents);
    }

    cursor = nextMonthStart(cursor);
  }

  return byDate;
}

/**
 * Map of date → array of fixed bill objects.
 * Only active, user-confirmed bills are included (confidence: 'confirmed').
 */
function buildBillsByDate(fixedBills, startDate, forecastDays) {
  const endDate = addDays(startDate, forecastDays - 1);
  const byDate = new Map();
  const active = fixedBills.filter((b) => b.active !== false);

  let cursor = monthStartOf(startDate);
  while (cursor <= endDate) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;

    for (const bill of active) {
      const dueDay = bill.due_day_of_month ?? bill.dueDayOfMonth;
      if (!dueDay) continue;
      const day = clampDay(y, m, dueDay);
      const billDate = new Date(Date.UTC(y, m - 1, day));

      if (billDate >= startDate && billDate <= endDate) {
        const ds = formatDate(billDate);
        const list = byDate.get(ds) ?? [];
        list.push({
          billId: bill.id,
          description: bill.name,
          amount: bill.expected_amount ?? bill.expectedAmount ?? '0.00',
          categorySlug: bill.category_slug ?? bill.categorySlug ?? null,
          confidence: 'confirmed',
          direction: 'outflow',
          sourceType: 'fixed_bill',
        });
        byDate.set(ds, list);
      }
    }

    cursor = nextMonthStart(cursor);
  }

  return byDate;
}

/**
 * Map of date → array of debt payment objects.
 * Confidence is 'expected' — scheduled but not yet transacted.
 * A forecasted payment never creates a real transaction.
 *
 * Recurring bill detection boundary: only debts explicitly entered by the user
 * are included here. Algorithmically detected recurring transactions must NOT
 * be promoted to confirmed/expected obligations without explicit user confirmation.
 */
function buildDebtsByDate(debts, startDate, forecastDays) {
  const endDate = addDays(startDate, forecastDays - 1);
  const byDate = new Map();
  const active = debts.filter((d) => d.isActive !== false && (d.status ?? 'current') !== 'paid_off');

  let cursor = monthStartOf(startDate);
  while (cursor <= endDate) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;

    for (const debt of active) {
      const dueDay = debt.paymentDueDay ?? debt.payment_due_day;
      if (!dueDay) continue;
      // Use minimum payment for baseline obligation; additional payment is a planning decision
      const minimumCents = parseMoneyToCents(
        debt.minimumPayment ?? debt.minimum_payment ?? '0.00',
      );
      const additionalCents = parseMoneyToCents(
        debt.additionalPayment ?? debt.additional_payment ?? '0.00',
      );
      const paymentCents = parseMoneyToCents(
        debt.monthlyPayment ?? debt.monthly_payment ?? '0.00',
      ) || (minimumCents + additionalCents);
      if (paymentCents <= 0) continue;

      const day = clampDay(y, m, dueDay);
      const payDate = new Date(Date.UTC(y, m - 1, day));

      if (payDate >= startDate && payDate <= endDate) {
        const ds = formatDate(payDate);
        const list = byDate.get(ds) ?? [];
        list.push({
          debtId: debt.id,
          description: debt.name,
          amount: formatCents(paymentCents),
          minimumPayment: formatCents(minimumCents || paymentCents),
          additionalPayment: formatCents(additionalCents),
          confidence: 'expected',
          direction: 'outflow',
          sourceType: 'debt_payment',
        });
        byDate.set(ds, list);
      }
    }

    cursor = nextMonthStart(cursor);
  }

  return byDate;
}

/**
 * Map of date → array of known upcoming expense objects.
 * These are user-entered one-time planned expenses (tuition, car repair, travel, etc.).
 * They appear exactly once on their expectedDate within the forecast window.
 * Creating an upcoming expense NEVER creates a transaction or changes account balances.
 */
function buildUpcomingExpensesByDate(upcomingExpenses, startDate, forecastDays) {
  const endDate = addDays(startDate, forecastDays - 1);
  const byDate = new Map();
  const active = upcomingExpenses.filter((e) => (e.status ?? 'active') === 'active');

  for (const expense of active) {
    const expDate = parseDate(expense.expectedDate);
    if (expDate < startDate || expDate > endDate) continue;
    const ds = expense.expectedDate;
    const list = byDate.get(ds) ?? [];
    list.push({
      expenseId: expense.id,
      description: expense.name,
      amount: expense.amount ?? '0.00',
      category: expense.category ?? null,
      accountId: expense.accountId ?? null,
      priority: expense.priority ?? 'planned',
      confidence: expense.confidence ?? 'confirmed',
      notes: expense.notes ?? null,
      direction: 'outflow',
      sourceType: 'upcoming_expense',
    });
    byDate.set(ds, list);
  }

  return byDate;
}

// ── Risk helpers ─────────────────────────────────────────────────────────────

function riskLevel(balanceCents, floorCents) {
  if (balanceCents < floorCents) return 'critical';
  if (floorCents > 0 && (balanceCents - floorCents) / Math.max(floorCents, 1) < 0.1) return 'tight';
  return 'healthy';
}

function marginPercent(balanceCents, floorCents) {
  if (balanceCents <= 0) return 0;
  if (floorCents <= 0) return 100;
  return Number(((balanceCents - floorCents) / balanceCents * 100).toFixed(1));
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute a deterministic 30/60/90-day cash-flow forecast.
 *
 * This function is read-only: it never modifies the RAF Plan Engine or any stored data.
 *
 * Confidence levels:
 *   confirmed  – user-entered fixed bills and confirmed upcoming expenses (certain obligations)
 *   expected   – recurring income / debt payments (scheduled but not yet received/transacted)
 *   estimated  – category baselines from trailing averages
 *
 * Double-counting prevention:
 *   Category baselines exclude any category whose slug matches a fixed bill's category slug
 *   or known obligation slugs (debt_payment). This ensures the same economic event is not
 *   projected both as a confirmed obligation and as an estimated variable-spending baseline.
 *
 * Recurring bill detection boundary:
 *   Algorithmically detected recurring transaction candidates are NOT treated as confirmed
 *   obligations automatically. They must pass through explicit user confirmation before
 *   appearing in the forecast as confirmed or expected events.
 *
 * Account sign conventions:
 *   - Liquid asset accounts (checking, savings, cash, other): positive balance = available cash
 *   - Investment accounts: excluded from forecast liquid balance (not available for routine spending)
 *   - Liability accounts (credit_card, line_of_credit, loan): excluded; a liability balance
 *     must never increase projected available cash
 *
 * @param {Object} params
 * @param {Array}  params.accounts            - Active financial accounts
 * @param {Array}  params.incomeEntries       - Historical income entries (for baseline)
 * @param {Array}  params.fixedBills          - User-confirmed fixed bills
 * @param {Array}  params.debts              - Active debts with payment schedule
 * @param {Array}  params.allocationCategories - Category definitions
 * @param {Array}  params.transactions        - Historical transactions (for category baseline)
 * @param {Array}  params.upcomingExpenses    - Known future one-time planned expenses
 * @param {Object} params.household           - Household settings (savingsFloor, savingsFloorEnabled)
 * @param {number} params.days               - 30 | 60 | 90
 * @param {string} params.startDate          - ISO date string 'YYYY-MM-DD' (day 1 of forecast)
 * @returns {CashFlowForecast}
 */
export function computeCashFlowForecast({
  accounts = [],
  incomeEntries = [],
  fixedBills = [],
  debts = [],
  allocationCategories = [],
  transactions = [],
  upcomingExpenses = [],
  household = {},
  days = 30,
  startDate,
} = {}) {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error(`startDate must be a YYYY-MM-DD string, got: ${startDate}`);
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`days must be an integer between 1 and 365, got: ${days}`);
  }

  const start = parseDate(startDate);
  const endDate = addDays(start, days - 1);

  // Savings floor
  const floorEnabled = household.savingsFloorEnabled === true;
  const floorCents = floorEnabled ? parseMoneyToCents(household.savingsFloor ?? '0.00') : 0;

  // Account balance breakdown — only liquid assets contribute to starting balance.
  // Investment accounts are excluded (not available for routine spending).
  // Liabilities are excluded (a credit card balance is not available cash).
  let liquidCashCents = 0;      // checking + cash
  let savingsAccountCents = 0;  // savings
  let otherAccountCents = 0;    // other type
  let investmentExcludedCents = 0; // investment (reported but excluded)
  const accountBreakdown = []; // provenance: liquid accounts only

  for (const acc of accounts) {
    if ((acc.status ?? 'active') !== 'active') continue;
    const type = acc.account_type ?? acc.accountType ?? '';
    const bal = parseMoneyToCents(acc.current_balance ?? acc.currentBalance ?? '0.00');
    if (type === 'checking' || type === 'cash') {
      liquidCashCents += bal;
    } else if (type === 'savings') {
      savingsAccountCents += bal;
    } else if (type === 'other') {
      otherAccountCents += bal;
    } else if (INVESTMENT_TYPES.has(type)) {
      investmentExcludedCents += bal;
      continue; // excluded from provenance
    } else {
      continue; // liability types excluded from provenance
    }
    // Track as-of date for each liquid account that contributes to the opening balance.
    const rawAsOf = acc.balance_as_of ?? acc.balanceAsOf ?? null;
    const balanceAsOf = rawAsOf ? String(rawAsOf).slice(0, 10) : null;
    accountBreakdown.push({
      accountId: acc.id ?? null,
      type,
      balance: formatCents(bal),
      balanceAsOf,
    });
  }
  const startingBalanceCents = liquidCashCents + savingsAccountCents + otherAccountCents;

  // Provenance: oldest known balance observation date across all liquid accounts.
  const knownDates = accountBreakdown.map((a) => a.balanceAsOf).filter(Boolean);
  const accountBalanceAsOf = knownDates.length > 0 ? knownDates.sort()[0] : null;
  const daysSinceOldestBalance = accountBalanceAsOf
    ? Math.floor((start.getTime() - new Date(`${accountBalanceAsOf}T00:00:00.000Z`).getTime()) / 86400000)
    : null;

  // Double-counting prevention: collect category slugs already represented as
  // confirmed obligations (fixed bills) so those categories are excluded from
  // the estimated variable-spending baseline.
  const activeBills = fixedBills.filter((b) => b.active !== false);
  const obligationCategorySlugs = new Set([
    ...activeBills.map((b) => b.category_slug ?? b.categorySlug).filter(Boolean),
    'debt_payment',
    'debt_payments',
  ]);

  // Category baselines (estimated) — obligation categories excluded
  const activeCategories = allocationCategories.filter((c) => c.isActive !== false);
  const categoryBaselines = trailingCategoryBaselines(
    transactions, activeCategories, start, 3, obligationCategorySlugs,
  );

  // Average monthly income
  const avgMonthlyCents = trailingMonthlyIncomeCents(incomeEntries, start, 3);
  const incomeConfidence = avgMonthlyCents > 0 ? 'expected' : 'estimated';

  // Pre-compute date maps
  const incomeByDate = buildIncomeByDate(avgMonthlyCents, start, days);
  const billsByDate = buildBillsByDate(fixedBills, start, days);
  const debtsByDate = buildDebtsByDate(debts, start, days);
  const upcomingByDate = buildUpcomingExpensesByDate(upcomingExpenses, start, days);

  // ── Day-by-day loop ────────────────────────────────────────────────────────
  let balanceCents = startingBalanceCents;
  let lowestBalanceCents = startingBalanceCents;
  let lowestBalanceDate = startDate;
  let lowestAvailableMarginCents = startingBalanceCents - floorCents;
  let lowestAvailableMarginDate = startDate;
  let daysAboveFloor = 0;
  let totalDaysWithShortfall = 0;
  let totalShortfallCents = 0;
  let totalIncomeCents = 0;
  let totalObligationsCents = 0;
  let totalConfirmedObligationsCents = 0;
  let totalExpectedObligationsCents = 0;
  let totalEstimatedSpendingCents = 0;
  let firstProjectedDeficitDate = null;
  const criticalDays = [];
  const projections = [];

  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const ds = formatDate(date);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const numDays = daysInMonthOf(y, m);

    // Income
    const dayIncomeCents = incomeByDate.get(ds) ?? 0;
    totalIncomeCents += dayIncomeCents;

    // Fixed bills
    const dayBills = billsByDate.get(ds) ?? [];
    const dayBillsCents = dayBills.reduce((s, b) => s + parseMoneyToCents(b.amount), 0);

    // Debt payments
    const dayDebts = debtsByDate.get(ds) ?? [];
    const dayDebtsCents = dayDebts.reduce((s, d) => s + parseMoneyToCents(d.amount), 0);

    // Known upcoming one-time expenses
    const dayExpenses = upcomingByDate.get(ds) ?? [];
    const dayExpensesCents = dayExpenses.reduce((s, e) => s + parseMoneyToCents(e.amount), 0);

    // Daily category spending (monthly average ÷ days in that month)
    const daySpends = categoryBaselines
      .filter((b) => b.monthlyAverageCents > 0)
      .map((b) => {
        const dailyCents = Math.round(b.monthlyAverageCents / numDays);
        return {
          categoryId: b.categoryId,
          slug: b.slug,
          label: b.label,
          amount: formatCents(dailyCents),
          confidence: 'estimated',
          direction: 'outflow',
          sourceType: 'category_spending',
        };
      });
    const dayCategorySpendCents = daySpends.reduce((s, sp) => s + parseMoneyToCents(sp.amount), 0);

    const dayObligationsCents = dayBillsCents + dayDebtsCents + dayExpensesCents;
    totalObligationsCents += dayBillsCents + dayDebtsCents; // bills and debts are "obligations"
    totalConfirmedObligationsCents += dayBillsCents + dayExpensesCents; // confirmed events
    totalExpectedObligationsCents += dayDebtsCents;          // expected events
    totalEstimatedSpendingCents += dayCategorySpendCents;

    const dayOutflowCents = dayObligationsCents + dayCategorySpendCents;
    balanceCents += dayIncomeCents - dayOutflowCents;

    if (balanceCents < lowestBalanceCents) {
      lowestBalanceCents = balanceCents;
      lowestBalanceDate = ds;
    }

    const availableMarginCents = balanceCents - floorCents;
    if (availableMarginCents < lowestAvailableMarginCents) {
      lowestAvailableMarginCents = availableMarginCents;
      lowestAvailableMarginDate = ds;
    }

    if (firstProjectedDeficitDate === null && balanceCents < 0) {
      firstProjectedDeficitDate = ds;
    }

    if (balanceCents >= floorCents) {
      daysAboveFloor++;
    } else {
      const gap = floorCents - balanceCents;
      totalShortfallCents += gap;
      totalDaysWithShortfall++;
      if (criticalDays.length < 10) criticalDays.push({ date: ds, reason: 'balance below savings floor' });
    }

    projections.push({
      date: ds,
      dayNumber: i + 1,

      projectedIncome: {
        amount: formatCents(dayIncomeCents),
        confidence: dayIncomeCents > 0 ? incomeConfidence : 'estimated',
        direction: 'inflow',
        sourceType: 'income',
      },

      projectedFixedBills: {
        amount: formatCents(dayBillsCents),
        bills: dayBills,
      },

      projectedCategorySpending: {
        total: formatCents(dayCategorySpendCents),
        byCategory: daySpends,
      },

      projectedDebtPayments: {
        total: formatCents(dayDebtsCents),
        byDebt: dayDebts,
      },

      projectedUpcomingExpenses: {
        total: formatCents(dayExpensesCents),
        expenses: dayExpenses,
      },

      netCashFlow: formatCents(dayIncomeCents - dayOutflowCents),
      projectedBalance: formatCents(balanceCents),
      projectedAvailableMargin: formatCents(Math.max(0, balanceCents - floorCents)),

      obligationsAffordability: {
        canCoverObligations: dayObligationsCents === 0 || balanceCents + dayObligationsCents - dayIncomeCents <= balanceCents,
        obligationsAmount: formatCents(dayObligationsCents),
        availableAfterIncome: formatCents(dayIncomeCents - dayObligationsCents),
      },

      constraints: {
        belowSavingsFloor: balanceCents < floorCents,
        savingsFloorAmount: formatCents(floorCents),
        availableAboveFloor: formatCents(Math.max(0, balanceCents - floorCents)),
      },

      pressureIndicators: {
        marginPercent: marginPercent(balanceCents, floorCents),
        riskLevel: riskLevel(balanceCents, floorCents),
      },
    });
  }

  const pressurePoints = projections
    .filter((p) => p.pressureIndicators.riskLevel !== 'healthy')
    .map((p) => ({
      date: p.date,
      reason: p.constraints.belowSavingsFloor ? 'balance below savings floor' : 'tight margin',
      riskLevel: p.pressureIndicators.riskLevel,
    }))
    .slice(0, 10);

  return {
    forecastPeriod: `${startDate.slice(0, 7)}-01`,
    generatedAt: new Date().toISOString(),
    days,
    startDate,
    endDate: formatDate(endDate),

    assumptions: {
      startingBalance: formatCents(startingBalanceCents),
      liquidCashBalance: formatCents(liquidCashCents),
      savingsAccountBalance: formatCents(savingsAccountCents),
      investmentAccountsExcluded: formatCents(investmentExcludedCents),
      accountBalanceAsOf,
      daysSinceOldestBalance,
      accountBreakdown,
      savingsFloor: formatCents(floorCents),
      savingsFloorEnabled: floorEnabled,
      baselineSource: '3-month trailing average',
      avgMonthlyIncome: formatCents(avgMonthlyCents),
      incomeConfidence,
      fixedBillsCount: activeBills.length,
      upcomingExpensesCount: upcomingExpenses.filter((e) => (e.status ?? 'active') === 'active').length,
      obligationCategoriesExcluded: [...obligationCategorySlugs],
      categoryBaselines: categoryBaselines.map((b) => ({
        categoryId: b.categoryId,
        slug: b.slug,
        label: b.label,
        monthlyAverage: formatCents(b.monthlyAverageCents),
        confidence: b.confidence,
      })),
    },

    projections,

    summaryMetrics: {
      lowestProjectedBalance: { amount: formatCents(lowestBalanceCents), date: lowestBalanceDate },
      lowestBalanceMargin: {
        amount: formatCents(Math.max(0, lowestBalanceCents - floorCents)),
        percent: marginPercent(lowestBalanceCents, floorCents),
      },
      lowestProjectedAvailableMargin: {
        amount: formatCents(lowestAvailableMarginCents),
        date: lowestAvailableMarginDate,
      },
      firstProjectedDeficitDate,
      daysAboveSavingsFloor: daysAboveFloor,
      criticalDays,
      averageDailyNetFlow: formatCents(Math.round((totalIncomeCents - (totalObligationsCents + categoryBaselines.reduce((s, b) => s + b.monthlyAverageCents, 0) * days / 30)) / days)),

      totalExpectedIncome: formatCents(totalIncomeCents),
      totalEstimatedVariableSpending: formatCents(totalEstimatedSpendingCents),

      obligations: {
        totalObligations: formatCents(totalObligationsCents),
        totalConfirmedObligations: formatCents(totalConfirmedObligationsCents),
        totalExpectedObligations: formatCents(totalExpectedObligationsCents),
        daysWithShortfall: totalDaysWithShortfall,
        totalShortfall: formatCents(totalShortfallCents),
      },
    },

    pressurePoints,
  };
}
