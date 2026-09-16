import { getJson, postJson, patchJson, deleteJson } from "./client";

export type ForecastDays = 30 | 60 | 90;

export type ConfidenceLevel = "confirmed" | "expected" | "estimated";

export interface CategorySpend {
  categoryId: string;
  slug: string;
  label: string;
  amount: string;
  confidence: ConfidenceLevel;
  direction: "outflow";
  sourceType: "category_spending";
}

export interface FixedBillEntry {
  billId: string;
  description: string;
  amount: string;
  categorySlug: string | null;
  confidence: "confirmed";
  direction: "outflow";
  sourceType: "fixed_bill";
}

export interface DebtPaymentEntry {
  debtId: string;
  description: string;
  amount: string;
  minimumPayment: string;
  additionalPayment: string;
  confidence: "expected";
  direction: "outflow";
  sourceType: "debt_payment";
}

export interface UpcomingExpenseEntry {
  expenseId: string;
  description: string;
  amount: string;
  category: string | null;
  accountId: string | null;
  priority: "essential" | "planned" | "optional";
  confidence: ConfidenceLevel;
  notes: string | null;
  direction: "outflow";
  sourceType: "upcoming_expense";
}

export interface DayProjection {
  date: string;
  dayNumber: number;
  projectedIncome: { amount: string; confidence: ConfidenceLevel; direction: "inflow"; sourceType: "income" };
  projectedFixedBills: { amount: string; bills: FixedBillEntry[] };
  projectedCategorySpending: { total: string; byCategory: CategorySpend[] };
  projectedDebtPayments: { total: string; byDebt: DebtPaymentEntry[] };
  projectedUpcomingExpenses: { total: string; expenses: UpcomingExpenseEntry[] };
  netCashFlow: string;
  projectedBalance: string;
  projectedAvailableMargin: string;
  obligationsAffordability: {
    canCoverObligations: boolean;
    obligationsAmount: string;
    availableAfterIncome: string;
  };
  constraints: {
    belowSavingsFloor: boolean;
    savingsFloorAmount: string;
    availableAboveFloor: string;
  };
  pressureIndicators: {
    marginPercent: number;
    riskLevel: "healthy" | "tight" | "critical";
  };
}

export interface CategoryBaseline {
  categoryId: string;
  slug: string;
  label: string;
  monthlyAverage: string;
  confidence: ConfidenceLevel;
}

export interface AccountFreshnessInfo {
  accountId: string;
  accountName: string;
  accountType: string;
  balance: string;
  balanceAsOf: string | null;
  balanceAgeInDays: number | null;
  lastReconciliationDate: string | null;
  lastImportDate: string | null;
}

export interface CoverageGap {
  accountId: string;
  name: string;
  accountType: string;
  reason: "payment_coverage_unknown";
}

export interface CashFlowForecast {
  forecastPeriod: string;
  generatedAt: string;
  days: number;
  startDate: string;
  endDate: string;
  assumptions: {
    startingBalance: string;
    liquidCashBalance: string;
    savingsAccountBalance: string;
    investmentAccountsExcluded: string;
    accountBalanceAsOf: string | null;
    daysSinceOldestBalance: number | null;
    accountBreakdown: Array<{ accountId: string | null; type: string; balance: string; balanceAsOf: string | null }>;
    savingsFloor: string;
    savingsFloorEnabled: boolean;
    baselineSource: string;
    avgMonthlyIncome: string;
    incomeConfidence: ConfidenceLevel;
    fixedBillsCount: number;
    upcomingExpensesCount: number;
    obligationCategoriesExcluded: string[];
    categoryBaselines: CategoryBaseline[];
    freshnessBreakdown?: AccountFreshnessInfo[];
    coverageGaps?: CoverageGap[];
    pendingReviewCount?: number;
  };
  projections: DayProjection[];
  summaryMetrics: {
    lowestProjectedBalance: { amount: string; date: string };
    lowestBalanceMargin: { amount: string; percent: number };
    lowestProjectedAvailableMargin: { amount: string; date: string };
    firstProjectedDeficitDate: string | null;
    daysAboveSavingsFloor: number;
    criticalDays: Array<{ date: string; reason: string }>;
    averageDailyNetFlow: string;
    totalExpectedIncome: string;
    totalEstimatedVariableSpending: string;
    obligations: {
      totalObligations: string;
      totalConfirmedObligations: string;
      totalExpectedObligations: string;
      daysWithShortfall: number;
      totalShortfall: string;
    };
    headroom?: string | null;
    shortfall?: string | null;
    projectedLowDate?: string;
    firstShortfallDate?: string | null;
  };
  pressurePoints: Array<{ date: string; reason: string; riskLevel: string }>;
}

// ── Upcoming Expense types ────────────────────────────────────────────────────

export interface UpcomingExpense {
  id: string;
  householdId: string;
  name: string;
  amount: string;
  expectedDate: string;
  category: string | null;
  accountId: string | null;
  priority: "essential" | "planned" | "optional";
  confidence: "confirmed" | "expected";
  notes: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface CreateUpcomingExpenseInput {
  name: string;
  amount: string;
  expectedDate: string;
  category?: string | null;
  accountId?: string | null;
  priority?: "essential" | "planned" | "optional";
  confidence?: "confirmed" | "expected";
  notes?: string | null;
}

// ── API functions ─────────────────────────────────────────────────────────────

export function getCashFlowForecast(days: ForecastDays = 30) {
  return getJson<CashFlowForecast>("/reports/cash-flow-forecast", { days });
}

export function listUpcomingExpenses(status?: "active" | "archived") {
  const params = status ? { status } : {};
  return getJson<{ items: UpcomingExpense[] }>("/upcoming-expenses", params);
}

export function createUpcomingExpense(input: CreateUpcomingExpenseInput) {
  return postJson<UpcomingExpense>("/upcoming-expenses", input);
}

export function updateUpcomingExpense(id: string, input: Partial<CreateUpcomingExpenseInput> & { status?: "active" | "archived" }) {
  return patchJson<UpcomingExpense>(`/upcoming-expenses/${id}`, input);
}

export function deleteUpcomingExpense(id: string) {
  return deleteJson<{ deleted: boolean }>(`/upcoming-expenses/${id}`);
}
