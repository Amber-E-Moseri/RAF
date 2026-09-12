export interface ApiErrorPayload {
  error: string | { code: string; message: string };
}

export interface HealthResponse {
  status: "ok";
  service: string;
}

export interface AllocationCategory {
  id: string;
  snapshotId?: string | null;
  effectiveFrom?: string | null;
  supersededAt?: string | null;
  slug: string;
  label: string;
  sortOrder: number;
  allocationPercent: string;
  isSystem?: boolean;
  isActive: boolean;
  isBuffer?: boolean;
}

export interface AllocationCategoryWriteItem {
  slug: string;
  label: string;
  sortOrder: number;
  allocationPercent: string;
  isActive: boolean;
  isBuffer?: boolean;
}

export interface AllocationCategoriesResponse {
  items: AllocationCategory[];
  history?: AllocationCategorySnapshot[];
}

export interface AllocationCategoriesWriteResponse {
  items: AllocationCategory[];
  history?: AllocationCategorySnapshot[];
}

export interface AllocationCategorySnapshot {
  snapshotId: string;
  effectiveFrom: string | null;
  supersededAt: string | null;
  items: AllocationCategory[];
}

export interface IncomeAllocationLine {
  category: string;
  slug: string;
  amount: string;
}

export interface IncomeCreateRequest {
  sourceName: string;
  amount: string;
  receivedDate: string;
  notes?: string;
}

export interface IncomeCreateResponse {
  incomeId: string;
  allocations: IncomeAllocationLine[];
}

export interface IncomeListItem {
  incomeId: string;
  sourceName: string;
  amount: string;
  receivedDate: string;
  notes: string | null;
}

export interface IncomeListResponse {
  items: IncomeListItem[];
  total: string;
}

export interface Transaction {
  id: string;
  transactionDate: string;
  description: string;
  merchant: string | null;
  amount: string;
  direction: "debit" | "credit";
  categoryId: string | null;
  linkedDebtId: string | null;
  linkedGoalId: string | null;
  source?: string | null;
}

export interface TransactionCreateRequest {
  transactionDate: string;
  description: string;
  merchant?: string | null;
  amount: string;
  direction: "debit" | "credit";
  categoryId?: string | null;
  linkedDebtId?: string | null;
  linkedGoalId?: string | null;
}

export interface TransactionListResponse {
  items: Transaction[];
  nextCursor: string | null;
}

export interface TransactionSplit {
  id: string;
  transactionId: string;
  amount: string;
  categoryId: string | null;
  description: string;
}

export interface TransactionSplitDraft {
  amount: string;
  categoryId?: string | null;
  description?: string;
}

export interface TransactionSplitsResponse {
  splits: TransactionSplit[];
}

export interface ImportedTransaction {
  id: string;
  household_id: string;
  date: string;
  description: string;
  amount: string;
  currency: string;
  source: string;
  raw_description: string | null;
  reference_number: string | null;
  balance_after_transaction: string | null;
  status: "unreviewed" | "classified" | "ignored" | string;
  classification_type: string | null;
  linked_transaction_id: string | null;
  linked_income_entry_id?: string | null;
  linked_debt_id: string | null;
  linked_fixed_bill_id: string | null;
  linked_goal_id?: string | null;
  normalized_description?: string | null;
  suggestion?: ImportReviewSuggestion | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportReviewSuggestion {
  id: string;
  normalized_description: string;
  match_type?: "contains" | "exact";
  match_value?: string;
  classification_type: string;
  category_id: string | null;
  linked_debt_id: string | null;
  linked_fixed_bill_id: string | null;
  linked_goal_id: string | null;
  rule_type?: "suggestion" | "reusable_rule";
  auto_apply: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
}

export interface ImportedTransactionListResponse {
  items: ImportedTransaction[];
}

export interface BankStatementImportResponse {
  extracted: number;
  currency: string;
  items: ImportedTransaction[];
}

export interface ImportClassificationPayload {
  classification_type: "income" | "transaction" | "debt_payment" | "fixed_bill_payment" | "goal_funding" | "duplicate" | "transfer" | "ignore";
  transaction_date?: string;
  description?: string;
  merchant?: string | null;
  category_id?: string | null;
  debt_id?: string | null;
  fixed_bill_id?: string | null;
  goal_id?: string | null;
  remember_choice?: boolean;
  save_rule_mode?: "suggestion" | "reusable_rule";
  auto_apply_rule?: boolean;
  review_note?: string | null;
}

export interface ImportReviewRule {
  id: string;
  household_id: string;
  match_type: "contains" | "exact";
  match_value: string;
  normalized_description: string | null;
  classification_type: ImportClassificationPayload["classification_type"];
  category_id: string | null;
  linked_debt_id: string | null;
  linked_fixed_bill_id: string | null;
  linked_goal_id: string | null;
  rule_type: "suggestion" | "reusable_rule";
  auto_apply: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface ImportReviewRuleListResponse {
  items: ImportReviewRule[];
}

export interface ImportReviewRuleUpdatePayload {
  match_value?: string;
  match_type?: "contains" | "exact";
  classification_type?: ImportClassificationPayload["classification_type"];
  category_id?: string | null;
  debt_id?: string | null;
  fixed_bill_id?: string | null;
  goal_id?: string | null;
  rule_type?: "suggestion" | "reusable_rule";
  auto_apply?: boolean;
}

export interface Debt {
  id: string;
  name: string;
  startingBalance: string;
  currentBalance: string;
  apr: number;
  minimumPayment: string;
  monthlyPayment: string;
  statementDay?: number | null;
  paymentDueDay?: number | null;
  lateFeeAmount?: string;
  autoPostInterest?: boolean;
  autoPostLateFee?: boolean;
  status: string;
  sortOrder: number;
  isActive?: boolean;
  openingBalance?: string;
  paymentsThisMonth?: string;
  interestChargedThisMonth?: string;
  feesThisMonth?: string;
  principalReductionThisMonth?: string;
  closingBalance?: string;
  paymentStatus?: "current" | "missed_payment" | "under_minimum" | "at_risk" | "paying_down" | "paid_off";
  nextStatementDate?: string | null;
  nextPaymentDueDate?: string | null;
  estimatedPayoffDate?: string | null;
  monthsRemaining?: number | null;
  totalInterestRemaining?: string | null;
  paymentPace?: DebtPaymentPace | null;
  paymentInsight?: DebtPaymentInsight | null;
  insightAcknowledged?: boolean;
  paymentObligation?: PaymentObligation | null;
  balanceTrajectory?: BalanceTrajectory | null;
  balanceExplanation?: BalanceChangeExplanation | null;
}

export interface DebtPaymentPace {
  pace: "no_payment" | "under_minimum" | "minimum_only" | "below_plan" | "on_plan" | "above_plan";
  actualPayment: string;
  plannedPayment: string;
  minimumPayment: string;
  amountAboveMinimum: string;
  amountAbovePlan: string;
  percentOfPlan: number;
  lowerBound: string;
  upperBound: string;
}

export interface DebtPaymentInsight {
  type: "above_plan_payment" | "below_plan_warning" | null;
  /** Present only when `type` is "below_plan_warning". */
  reason?: "well_below_plan";
  actionablePaymentPeriod: string;
  actualPayment: string;
  plannedPayment: string;
  minimumPayment: string;
  amountAbovePlan?: string;
  amountBelowPlan?: string;
  percentOfPlan: number;
  suggestedRecurringPayment?: string;
  projections?: {
    observedBasis?: "three_month_average" | "latest_completed_month" | "this_month" | string | null;
    planned: {
      estimatedPayoffDate: string | null;
      monthsRemaining: number | null;
      totalInterestRemaining: string | null;
    };
    observed: {
      estimatedPayoffDate: string | null;
      monthsRemaining: number | null;
      totalInterestRemaining: string | null;
    };
    /** Positive = observed pace pays off sooner; negative = it slips later (below-plan). */
    acceleratedMonths?: number;
    /** Positive = interest saved; negative = extra interest (below-plan). */
    interestSaved?: string;
  };
}

export interface DebtPaymentPaceAcknowledgement {
  id: string;
  debtId: string;
  paymentPeriodMonth: string;
  action: "keep_plan" | "acknowledge_onetime" | "update_plan";
  acknowledgementDate: string;
}

export interface PaymentObligation {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  minimumDue: string;
  plannedAmount: string;
  payments: Array<{ paymentDate: string; amount: string }>;
  totalPaidToDate: string;
  minimumRemaining: string;
  plannedRemaining: string;
  status: "pending" | "in_progress" | "satisfied" | "under_minimum" | "missed_payment";
  minimumSatisfied: boolean;
  planSatisfied: boolean;
}

export interface BalanceTrajectory {
  trajectory: "decreasing" | "stable" | "increasing";
  absoluteChange: number;
  percentageChange: number;
  tolerance: number;
  isIncreasing: boolean;
  isDecreasing: boolean;
  isStable: boolean;
  /** True when the balance grew this period — surfaced independently of payment pace. */
  warning: boolean;
}

export interface BalanceChangeExplanation {
  openingBalance: string;
  payments: string;
  interest: string;
  fees: string;
  adjustments: string;
  /** Balance-increasing activity that is not interest or fees (new charges / borrowing). */
  newActivity: string;
  unexplained: string;
  closingBalance: string;
  changeMessage: string;
}

export interface DebtCreateRequest {
  name: string;
  startingBalance: string;
  apr: number | string;
  minimumPayment: string;
  monthlyPayment: string;
  statementDay?: number;
  paymentDueDay?: number;
  lateFeeAmount?: string;
  autoPostInterest?: boolean;
  autoPostLateFee?: boolean;
  sortOrder?: number;
}

export interface DebtListResponse {
  items: Debt[];
  summary: {
    totalStarting: string;
    totalRemaining: string;
    totalPaidAllTime: string;
  };
}

export interface FixedBill {
  id: string;
  household_id: string;
  name: string;
  category_slug: string;
  expected_amount: string;
  due_day_of_month: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FixedBillListResponse {
  items: FixedBill[];
}

export interface Goal {
  id: string;
  household_id: string;
  bucket_id: string;
  name: string;
  target_amount: string;
  target_date: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GoalListResponse {
  items: Goal[];
}

export interface GoalCreateRequest {
  bucket_id: string;
  name: string;
  target_amount: string;
  target_date?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface GoalUpdateRequest {
  bucket_id?: string;
  name?: string;
  target_amount?: string;
  target_date?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface DashboardPeriod {
  month: string;
  incomeTotal: string;
  spendingTotal: string;
  surplusOrDeficit: string;
  savingsActual: string;
  alertStatus: "ok" | "elevated" | "risky";
  explanations?: {
    netSurplus: CalculationExplanation;
  };
}

export interface CalculationExplanation {
  label: string;
  value: string;
  components: Array<{
    label: string;
    value: string;
    kind?: "add" | "subtract" | "neutral";
  }>;
  assumptions?: string[];
  provenance?: string;
  asOf?: string;
}

export interface BucketBalance {
  bucket_id: string;
  bucket_name: string;
  slug: string;
  balance: string;
  percent_of_total: number;
}

export interface GoalProgress {
  goal_id: string;
  goal_name: string;
  bucket_id: string;
  bucket?: string;
  bucket_name: string;
  bucket_balance?: string;
  reserved_amount: string;
  current_amount: string;
  target_amount: string;
  remaining_amount: string;
  progress_percent: number;
}

export interface MonthlyBucketProgress {
  bucket_id: string;
  bucket_name: string;
  slug?: string;
  allocated_this_month: string;
  added_this_month: string;
  used_this_month: string;
  reserved_for_goals_this_month: string;
  available_this_month: string;
  remaining_this_month: string;
  percent_used_this_month: number;
  percent_reserved_for_goals_this_month: number;
}

export interface DashboardReport {
  periods: DashboardPeriod[];
  upcoming_fixed_bills_this_month: Array<{
    id: string;
    name: string;
    category_slug: string;
    expected_amount: string;
    due_day_of_month: number;
  }>;
  total_expected_fixed_bills_this_month: string;
  bucket_balances: BucketBalance[];
  monthly_bucket_progress: MonthlyBucketProgress[];
  ytd_bucket_progress: MonthlyBucketProgress[];
  ttd_bucket_progress: MonthlyBucketProgress[];
  goal_progress: GoalProgress[];
}

export interface DashboardAggregateReport {
  dashboard: DashboardReport;
  financialHealth: FinancialHealthReport;
  surplusRecommendations: SurplusRecommendationsReport;
}

export interface FinancialHealthReport {
  reviewMonth?: string;
  activeMonthIncome: string;
  monthlyDebtPayments: string;
  debtRatio: string;
  savingsBalance: string;
  savingsFloor: string;
  savingsFloorEnabled: boolean;
  availableSavings: string;
  emergencyFundBalance: string;
  monthlyEssentials: string;
  emergencyCoverageMonths: number | null;
  healthScore: number;
  healthPillars: Array<{
    key: "budget_discipline" | "surplus_generation" | "debt_ratio" | "debt_reduction" | "savings_coverage" | "spending_stability";
    label: string;
    score: number;
    value: string;
  }>;
  alertStatus: "ok" | "elevated" | "risky";
}

export interface HouseholdSettings {
  id: string;
  name: string;
  timezone: string;
  activeMonth: string;
  periodStartDay: number;
  savingsFloor: string;
  savingsFloorEnabled: boolean;
  monthlyEssentialsBaseline: string;
}

export interface HouseholdSettingsUpdateRequest {
  timezone?: string;
  activeMonth?: string;
  periodStartDay?: number;
  savingsFloor?: string;
  savingsFloorEnabled?: boolean;
  monthlyEssentialsBaseline?: string;
}

export interface DistributionLine {
  slug: string;
  label: string;
  amount: string;
  splitPercent?: string;
  destinationType?: "bucket" | "goal" | "debt";
  destinationBucketSlug?: string | null;
  destinationGoalId?: string | null;
  destinationDebtId?: string | null;
  isMissing?: boolean;
}

export interface SurplusRecommendationsReport {
  reviewMonth?: string;
  netSurplus: string;
  distributions: DistributionLine[];
  targetDebtName?: string | null;
  alertStatus: "ok" | "elevated" | "risky";
  monthlySummary?: {
    totalIncome: string;
    totalAllocated: string;
    totalSpent: string;
    monthResult: string;
    surplusAllocatedToGoals: string;
    surplusAllocatedToDebt: string;
    remainingSurplus: string;
    finalMonthResult: string;
    statusLabel: "On Budget" | "Slight Overrun" | "Over Budget" | "Deficit Month";
  };
  categorySummaries?: Array<{
    bucketId: string;
    bucketName: string;
    slug: string;
    allocated: string;
    added: string;
    spent: string;
    goalContributions: string;
    available: string;
    overused: boolean;
    overageAmount: string;
  }>;
  overspendingImpact?: {
    totalImpact: string;
    categories: Array<{
      bucketId: string;
      bucketName: string;
      slug: string;
      overageAmount: string;
    }>;
  };
}

export interface SurplusAllocationPreference {
  id: string;
  slug: string;
  label: string;
  splitPercent: string;
  sortOrder: number;
  isActive: boolean;
  destinationType: "bucket" | "goal" | "debt";
  destinationBucketSlug: string | null;
  destinationGoalId: string | null;
  destinationDebtId: string | null;
}

export interface SurplusAllocationPreferenceWriteItem {
  id?: string | null;
  slug?: string | null;
  label: string;
  splitPercent: string;
  sortOrder: number;
  isActive: boolean;
  destinationType: "bucket" | "goal" | "debt";
  destinationBucketSlug?: string | null;
  destinationGoalId?: string | null;
  destinationDebtId?: string | null;
}

export interface SurplusAllocationPreferencesResponse {
  items: SurplusAllocationPreference[];
}

export interface MonthlyReviewRequest {
  reviewMonth: string;
  notes?: string;
  splitOverride?: SurplusAllocationPreferenceWriteItem[];
}

export interface MonthlyReviewResponse {
  id: string;
  reviewMonth: string;
  netSurplus: string;
  splitApplied: Record<string, string>;
  distributions: Record<string, string>;
  alertStatus: "ok" | "elevated" | "risky";
  notes: string | null;
}

export interface MonthlyReviewListResponse {
  items: MonthlyReviewResponse[];
}

export interface AppliedMonthlyReviewTransaction {
  id: string;
  transactionDate: string;
  description: string;
  merchant: string | null;
  amount: string;
  direction: "debit" | "credit";
  categoryId: string | null;
  linkedDebtId: string | null;
}

export interface ApplyMonthlyReviewResponse {
  review: MonthlyReviewResponse;
  appliedTransactions: AppliedMonthlyReviewTransaction[];
}

export interface DeleteMonthlyReviewResponse {
  review: MonthlyReviewResponse;
  revertedTransactions: AppliedMonthlyReviewTransaction[];
}

export interface IncomeAllocationReport {
  sourceName: string;
  amount: string;
  receivedDate: string;
  allocations: DistributionLine[];
}
