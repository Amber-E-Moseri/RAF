# RAF Adversarial Test Seed Plan

**Phase 1 Deliverable**: Non-implementation specification for Phase 2 deterministic household  
**Generated**: 2026-09-16

---

## Executive Summary

This document specifies the **Workspace A (Primary Household)** fixture that Phase 2 will create. It is a deterministic 12-month financial simulation (2026-01 through 2026-12) designed to trigger all critical financial invariants without implementing new product features.

**Why this design?**
- **Realistic events**: Bonus income, overspending, late income, revolving debt, goal progress
- **Invariant stress**: Each month intentionally violates or validates one critical invariant
- **Reproducible**: All dates, amounts, and sequences are fixed; seed is deterministic
- **Diagnostic**: When an invariant breaks, the seed pinpoints which scenario revealed it

---

## Workspace & User Setup

### Users
```
alice@example.test (Primary household owner, full permissions)
bob@example.test   (Member, role=member, can read all, write restricted)
charlie@example.test (Workspace B owner, for cross-workspace denial tests)
diana@example.test (Workspace C owner, minimal fixture)
```

### Workspaces
```
Workspace A: "Alice & Bob's Household"
  - Owner: alice
  - Member: bob
  - Type: household
  
Workspace B: "Charlie's Household"
  - Owner: charlie
  - Type: household
  
Workspace C: "Diana's Household"
  - Owner: diana
  - Type: household (minimal fixture)
```

### Active Month (Test "Now")
- **Baseline**: 2026-09-01
- All queries, reports, forecasts are as-of 2026-09-16

---

## Financial Accounts

### Checking (Primary)
```
id: account_chequing_a
workspace_id: workspace_a
account_type: checking
institution: BMO
currency: CAD
is_manual: false
status: active

Balance History:
  2026-01-01: $5,000.00
  2026-02-15: +$3,000.00 income → $8,000.00
  2026-02-28: -$2,000.00 spending → $6,000.00
  2026-03-01: $6,000.00 (balance carries forward)
  ... (updated monthly by transactions)
  2026-09-16: $4,250.00 (current)
```

### Savings (Emergency Fund)
```
id: account_savings_a
workspace_id: workspace_a
account_type: savings
institution: BMO
currency: CAD
is_manual: false
status: active

Balance History:
  2026-01-01: $2,000.00
  ... (allocated income, no withdrawals)
  2026-09-16: $2,800.00 (current)
```

### Goal Savings (RESP)
```
id: account_goal_resp_a
workspace_id: workspace_a
account_type: savings
institution: CIBC
currency: CAD
is_manual: false
status: active
linked_goal_id: goal_education_fund

Balance History:
  2026-01-01: $500.00
  2026-04-15: +$200.00 (goal contribution) → $700.00
  2026-11-20: -$150.00 (goal withdrawal) → $550.00
  2026-09-16: $550.00 (current)
```

### Credit Card (Visa, Liability)
```
id: account_cc_visa_a
workspace_id: workspace_a
account_type: credit_card
institution: Visa
currency: CAD
is_manual: false
status: active
linked_debt_id: debt_visa_a

Balance History:
  2026-01-01: $0.00
  2026-01-31: $150.00 (monthly spending accumulated)
  2026-02-01: -$150.00 (payment) → $0.00
  ...
  2026-06-30: $1,200.00 (balance grows; user overspending)
  2026-07-15: $1,220.00 (accrued interest added)
  2026-07-20: -$400.00 (above-plan payment) → $820.00
  2026-09-16: $950.00 (current; balance rising despite above-plan payment)
```

### Line of Credit (Liability)
```
id: account_loc_bmo_a
workspace_id: workspace_a
account_type: line_of_credit
institution: BMO
currency: CAD
is_manual: false
status: active
linked_debt_id: debt_loc_a

Balance History:
  2026-01-01: $5,000.00
  2026-01-20: -$500.00 (payment) → $4,500.00
  2026-03-15: +$200.00 (interest accrual) → $4,700.00
  ...
  2026-09-16: $4,850.00 (current; stable, on-plan payments)
```

### Manual Debt (Car Loan, no account link)
```
id: account_car_loan_a
workspace_id: workspace_a
account_type: loan  (not directly linked to a financial account)
is_manual: true
status: active
linked_debt_id: debt_car_a

Note: Balance is derived from debtPayments + adjustments, not from account balance.
      See Debts section below.
```

---

## Debts

### Visa Credit Card (Account-Backed)
```
id: debt_visa_a
workspace_id: workspace_a
name: "Visa Card"
starting_balance: $0.00 (linked to account_cc_visa_a)
apr: 19.99
minimum_payment: $50.00
monthly_payment: $150.00
statement_day: 1
payment_due_day: 20
is_active: true
financial_account_id: account_cc_visa_a

Payment History:
  2026-01-20: $150.00 (on plan)
  2026-02-20: $150.00 (on plan)
  2026-03-20: $160.00 (above plan)
  2026-04-20: $100.00 (below plan)
  2026-05-20: $140.00 (below plan, cumulative shortfall)
  2026-06-20: $0.00 (MISSED PAYMENT)
  2026-07-20: $400.00 (above plan, catch-up)
  2026-08-20: $180.00 (above plan)
  2026-09-16: (no payment yet this month)

Balance Authority:
  - Source: financial_account_id = account_cc_visa_a
  - Current Balance: $950.00 (from account.current_balance, absolute value)
  - Balance as Of: 2026-09-16
  - Accrued Interest: ~$45.00 (at 19.99% APR on revolving balance)

Critical Test Invariant (2026-07):
  Payment: $400 (above plan of $150)
  Interest accrued: ~$35
  Balance change: $0 → $820 (actually rising)
  ✅ This tests: paymentPace = above_plan but balanceTrajectory = increasing
                (independent concepts, both simultaneously valid)
```

### Line of Credit (Account-Backed)
```
id: debt_loc_a
workspace_id: workspace_a
name: "LOC"
starting_balance: $5,000.00 (linked to account_loc_bmo_a)
apr: 7.20
minimum_payment: $100.00
monthly_payment: $500.00
statement_day: 5
payment_due_day: 25
is_active: true
financial_account_id: account_loc_bmo_a

Payment History:
  2026-01-25: $500.00 (on plan)
  2026-02-25: $500.00 (on plan)
  2026-03-25: $500.00 (on plan)
  2026-04-25: $450.00 (below plan by $50)
  2026-05-25: $500.00 (on plan)
  2026-06-25: $500.00 (on plan)
  2026-07-25: $500.00 (on plan)
  2026-08-25: $500.00 (on plan)
  2026-09-16: (no payment yet this month)

Balance Authority:
  - Source: financial_account_id = account_loc_bmo_a
  - Current Balance: $4,850.00 (from account.current_balance)
  - Interest accrued: ~$30/month (at 7.20% APR)
```

### Car Loan (Manual, No Account Link)
```
id: debt_car_a
workspace_id: workspace_a
name: "Car Loan"
starting_balance: $15,000.00
apr: 4.99
minimum_payment: $0.00 (no minimum; fixed-term loan)
monthly_payment: $350.00
is_active: true
financial_account_id: null (MANUAL DEBT)

Payment History:
  2026-01-10: $350.00
  2026-02-10: $350.00
  2026-03-10: $350.00
  2026-04-10: $350.00
  2026-05-10: $350.00
  2026-06-10: $350.00
  2026-07-10: $350.00
  2026-08-10: $350.00
  2026-09-16: (no payment yet; due 2026-09-10, not yet paid)

Balance Authority:
  - Source: MANUAL (derived from payments + adjustments)
  - Calculated: $15,000 - (8 × $350) = $12,200.00
  - Interest accrued: ~$33/month (at 4.99% APR)
  - Current Balance: $12,233.00

Test Scenario:
  User payment pace on car loan is ON_PLAN (steady $350 fixed payment)
  No account to reconcile against
  Verify: manual debt balance derives correctly from ledger
```

---

## Allocation Categories & Plan

### Active Categories
```
Savings (system)
  - id: cat_savings
  - slug: savings
  - isBuffer: false
  - isActive: true
  - sortOrder: 1
  - allocationPercent: 10%
  
Fixed Bills (system)
  - id: cat_fixed_bills
  - slug: fixed_bills
  - isActive: true
  - sortOrder: 2
  - allocationPercent: 30%
  
Personal Spending (custom)
  - id: cat_personal
  - slug: personal_spending
  - isActive: true
  - sortOrder: 3
  - allocationPercent: 15%
  
Debt Payoff (custom)
  - id: cat_debt_payoff
  - slug: debt_payoff
  - isActive: true
  - sortOrder: 4
  - allocationPercent: 10%
  
Partnership Giving (custom)
  - id: cat_giving
  - slug: partnership
  - isActive: true
  - sortOrder: 5
  - allocationPercent: 5%
  
Investment (custom)
  - id: cat_invest
  - slug: investment
  - isActive: true
  - sortOrder: 6
  - allocationPercent: 10%
  
Buffer (system)
  - id: cat_buffer
  - slug: buffer
  - isBuffer: true
  - isActive: true
  - sortOrder: 9
  - allocationPercent: 20%
```

**Total Active Allocation**: 100%

### Household Plan
```
Income Streams (Expected):
  - Primary Job: $3,000.00/month (stable)
  - Bonus (one-time): $500.00 (2026-02 only)
  
Surplus Split Rules (Active):
  - Emergency Fund: 40%
  - Investment: 40%
  - Giving: 20%
  
Savings Floor:
  - Enabled: true
  - Amount: $2,000.00
  
Priority Overrides: None (uses defaults)
```

---

## Monthly Income & Allocations

### 2026-01: Baseline
```
Income:
  - Received: $3,000.00 (2026-01-15)
  
Allocations (per plan):
  - Savings: $300.00
  - Fixed Bills: $900.00
  - Personal Spending: $450.00
  - Debt Payoff: $300.00
  - Partnership: $150.00
  - Investment: $300.00
  - Buffer: $600.00
  Total: $3,000.00
  
Transactions:
  - Rent (2026-01-01): $900.00 debit, category=fixed_bills
  - Groceries (2026-01-05): $200.00 debit, category=personal_spending
  - Power (2026-01-15): $80.00 debit, category=fixed_bills
  - Coffee (2026-01-20): $15.00 debit, category=personal_spending
  - Transfer to Savings (2026-01-20): $300.00 credit, category=savings
  Total Spending: $1,195.00
  
Ending Balance Check:
  Opening: $5,000.00
  + Income: $3,000.00
  - Spending: $1,195.00
  = Ending: $6,805.00 ✓
```

### 2026-02: Bonus Income & Overspending
```
Income:
  - Salary: $3,000.00 (2026-02-15)
  - BONUS: $500.00 (2026-02-20) [ONE-TIME]
  Total: $3,500.00
  
Allocations (per plan, before bonus surplus):
  - Savings: $300.00
  - Fixed Bills: $900.00
  - Personal Spending: $450.00
  - Debt Payoff: $300.00
  - Partnership: $150.00
  - Investment: $300.00
  - Buffer: $600.00
  Total: $3,000.00
  
Bonus Surplus: $500.00
  Applied per surplus split rules:
  - Emergency Fund: $200.00
  - Investment: $200.00
  - Giving: $100.00
  
Transactions:
  - Rent: $900.00 debit, fixed_bills
  - Groceries: $350.00 debit, personal_spending (OVERSPENDING ← high utility bill)
  - Power: $150.00 debit, fixed_bills (HIGHER THAN NORMAL)
  - Furniture: $200.00 debit, personal_spending (impulse buy, OVERSPENDING)
  - Car insurance: $120.00 debit, fixed_bills
  Total Spending: $1,720.00 (vs. $1,195 budgeted; $525 deficit in personal_spending)
  
Allocation Consumption:
  - Fixed Bills allocated: $900, spent: $1,170 → DEFICIT
  - Personal allocated: $450 + bonus=$200, spent: $550 → NEAR-DEFICIT
  
Monthly Review Action (2026-02-28):
  Surplus Decision: Apply surplus split rules above
  Deficit Candidates (lowest priority first):
    1. Personal Spending: $100 remaining → offer adjustment
    2. Investment: Has full allocation, no deficit
  
Test Invariant: Allocation conservation (allocation + rollover must explain available)
  
Ending Balance: $6,805 + $3,500 - $1,720 = $8,585.00
```

### 2026-03: Reconciliation & Recovery
```
Income:
  - Salary: $3,000.00 (2026-03-15)
  
Transactions:
  - Rent: $900.00 debit, fixed_bills
  - Groceries: $250.00 debit, personal_spending (back to normal)
  - Power: $100.00 debit, fixed_bills
  - Goal Contribution: $200.00 credit, linked to goal_education_fund (intentional savings goal)
  Total Spending: $950.00
  
Reconciliation (2026-03-31):
  Bank statement shows: $7,635.00
  Calculated balance: $8,585 + $3,000 - $950 = $10,635.00
  DISCREPANCY: -$3,000.00
  
Audit Note: Reconciliation adjustment inserted to match statement.
  Adjustment: $-3,000.00 (labeled as "Bank correction for transferred funds to high-yield account")
  
Test Invariant: Account conservation (reconciliation + adjustments = statement balance)
  
Ending Balance: $7,635.00 (per reconciliation)
```

### 2026-04: Import Workflow & Duplicate Detection
```
Income:
  - Salary: $3,000.00 (2026-04-15)
  
Transactions:
  - Rent: $900.00 debit, fixed_bills
  - Groceries: $250.00 debit, personal_spending
  - Coffee: $5.00 debit, personal_spending
  - Duplicate Test: Starbucks $25.00 (imported twice)
  Total Spending (non-duplicate): $1,180.00
  
Import Batches:
  - Batch 1 (uploaded 2026-04-20): Contains Starbucks $25.00
    User reviews, classifies as personal_spending, approves
    → Creates transaction_1 ($25, personal_spending)
    
  - Batch 2 (uploaded 2026-04-22): Contains same Starbucks $25.00
    User detects as duplicate (same merchant, date, amount)
    Rejects batch 2
    → No transaction_2 created
    
Verify:
  - Bucket balance includes transaction_1 ($25) once
  - No phantom allocation from duplicate
  - Duplicate detection correctly linked by merchant + date + amount
  
Test Invariant: Import identity & no double-counting
  
Ending Balance: $7,635 + $3,000 - $1,180 = $9,455.00
```

### 2026-05: Late Income & Catch-up Allocation
```
Income Expected (per plan): $3,000.00
Actual:
  - Late Salary: $3,000.00 (2026-05-20, NOT 2026-05-15 as expected)
  
Allocation Decision (as of 2026-05-15):
  User anticipates income; allocates early based on plan
  - Savings: $300.00 (allocated 2026-05-15)
  - Fixed Bills: $900.00 (allocated 2026-05-15)
  Total: $1,200.00
  
Income Received (2026-05-20):
  Actual: $3,000.00
  Previous Allocations: $1,200.00 (already recorded)
  New Allocations Needed: $1,800.00 to complete the month
  
Transactions:
  - Rent: $900.00 debit, fixed_bills (2026-05-01)
  - Groceries: $300.00 debit, personal_spending
  Total Spending: $1,200.00
  
Monthly Review (2026-05-31):
  Allocations: $3,000 per plan
  Spent: $1,200
  Available: $1,800 (to be allocated to personal, debt, investment, buffer per plan)
  
Surplus (if any): None (exact allocation coverage)
  
Test Invariant: Late income allocation (allocations refcount to income date, not promised date)
  
Ending Balance: $9,455 + $3,000 - $1,200 = $11,255.00
```

### 2026-06: Revolving Balance Growth (Account-Backed Debt)
```
Income:
  - Salary: $3,000.00 (2026-06-15)
  
Credit Card Transactions:
  - Groceries: $300.00 debit, personal_spending
  - Gas: $80.00 debit, personal_spending
  - Coffee: $15.00 debit, personal_spending
  - Visa Payment (manual): $150.00 credit (toward debt payoff, 2026-06-20)
  Total on Visa: $245.00 (net added to balance)
  
Account Balance Tracking:
  Starting (2026-06-01): $0.00 (paid off 2026-05)
  June Charges: $395.00
  Payment (2026-06-20): -$150.00
  Accrued Interest: +$8.00 (at 19.99% APR on $245 balance)
  Ending (2026-06-30): $253.00
  
Debt Authority:
  - Balance source: financial_account_id (linked account balance)
  - Calculated from account: $253.00
  - Matches transaction ledger: YES ✓
  
Test Invariant: Account-backed debt balance authority
  Verify account balance reconciles with transaction ledger
  
Ending Household Balance: $11,255 + $3,000 - (allocations consumed) = TBD
```

### 2026-07: CRITICAL — Debt Trajectory Independence
```
Income:
  - Salary: $3,000.00 (2026-07-15)
  
Credit Card Balance (Visa):
  Starting (2026-07-01): $253.00
  June Interest Accrual: $8.00 (2026-07-01)
  July Charges: $400.00 (groceries, utilities, etc.)
  
Payments:
  - Payment (2026-07-20): $400.00 ← ABOVE PLAN ($150 plan)
  
Interest Accrual (continuous):
  - Accrued during month: ~$35.00 (at 19.99% APR on average $253–653 balance)
  
Balance Calculation:
  Starting: $253.00
  + Interest: $8 (July accrual) = $261.00
  + Charges: $400.00 = $661.00
  - Payment: $400.00 = $261.00
  + Interest (on remaining): ~$35.00
  Ending (2026-07-31): $296.00
  
Payment Pace Classification:
  Actual Payment: $400.00
  Plan Payment: $150.00
  Tolerance: max(5% × $150, $5) = $7.50
  Upper Bound: $157.50
  
  $400 > $157.50 → pace = "above_plan" ✓
  
Balance Trajectory:
  Opening: $253.00
  Closing: $296.00
  Change: +$43.00
  Trajectory: INCREASING ✓
  
  **CRITICAL TEST**: Both above_plan AND increasing are TRUE
             These must be independent concepts.
             User is aggressively paying down debt, yet balance rises
             due to accrued interest.
  
Test Invariant: [[debt-trajectory-independence]]
  This test directly validates:
    ✓ pace (how much paid) ≠ trajectory (balance direction)
    ✓ Both can be true simultaneously
    ✓ No coupling between payment behavior and balance outcome
  
Ending Household Balance: TBD + $3,000 - (allocations)
```

### 2026-08: Monthly Close & Close Integrity
```
Income:
  - Salary: $3,000.00 (2026-08-15)
  
Transactions:
  - Standard monthly spending: ~$1,100 across categories
  
Monthly Review (2026-08-31):
  Allocations: $3,000 (per plan)
  Spent: $1,100
  Available for Surplus: $1,900
  
Surplus Distribution (per split rules):
  - Emergency Fund: $760.00 (40%)
  - Investment: $760.00 (40%)
  - Giving: $380.00 (20%)
  Total: $1,900.00
  
Applied Transactions:
  - Transfer to Savings: $760.00 credit, category=savings
  - Transfer to Investment: $760.00 credit, category=investment
  - Transfer to Giving: $380.00 credit, category=partnership
  
Monthly Review Record Created:
  - workspace_id: workspace_a
  - period: 2026-08-01
  - surplus_allocated: $1,900.00
  - applied_at: 2026-08-31
  - status: closed
  
Close Integrity Test:
  User attempts to add transaction in 2026-08 after close
  → Expected: 409 CONFLICT or rejected
  
User attempts to modify allocation in 2026-08 after close
  → Expected: 409 CONFLICT or rejected
  
Test Invariant: [[close-integrity]]
  Closed month is immutable except via reopen workflow
  
Ending Balance: TBD
```

### 2026-09: Reopen & Modify Cycle
```
Household "Active Month": 2026-09-01 (current test month)
Test Date: 2026-09-16

Month Status: OPEN (not yet closed)
  Monthly review has not been applied yet
  All 2026-09 transactions are still editable
  
Historic Reopen: 2026-08 was closed; now reopen
  
Reopen Workflow:
  1. User selects month 2026-08
  2. Clicks "Reopen Month"
  3. Monthly review record status → reopened
  4. Transactions become editable again
  
Modification (in reopened 2026-08):
  Transaction: Transfer to Savings $760.00 (created during 2026-08 close)
  User changes: Split allocation $500 to Savings, $260 to Investment
  
Reclose Workflow:
  1. User selects month 2026-08
  2. Clicks "Close Month" (via applyMonthlyReview again)
  3. Recalculates surplus from modified spending
  4. New allocation distribution applied
  
Verification:
  - Original close record updated, not duplicated
  - No phantom allocation from reopen/reclose cycle
  - Transactions remain intact (only allocations adjusted)
  - Audit trail captures both close and reclose
  
Test Invariant: [[close-integrity]] + reopen workflow
  Verify: Reopening does not lose data; reclosing does not double-allocate
  
Current Status (2026-09-16):
  Transactions YTD (2026-01 through 2026-09-16): ~$8,000 total spending
  Income YTD: $3,000 × 8 months + $500 bonus = $24,500
  Allocations YTD: Tracked monthly, no discrepancies
  
Current Balances (verified):
  - Checking: $4,250.00
  - Savings: $2,800.00
  - Visa CC: $296.00
  - LOC: $4,850.00
  - Car Loan: $12,233.00 (manual debt calculated balance)
```

### 2026-10: Forecast (Read-Only, No Mutations)
```
Forecast Projection (computed 2026-09-16, for next 30 days):
  
30-Day Projections:
  2026-09-20: $4,250 - $100 (coffee) = $4,150
  2026-09-25: $4,150 - $900 (rent) = $3,250
  2026-10-01: $3,250 + $3,000 (salary) = $6,250
  2026-10-15: $6,250 - $1,200 (spending) = $5,050
  ...
  
Assumptions Used:
  - Average income: $3,000/month
  - Average spending: $1,100/month
  - Fixed bills: $900/month (rent)
  - Debt payments: $350/month (car), $500/month (LOC)
  
Test Invariant: [[forecast-isolation]]
  Forecast computation uses current state (accounts, transactions, income entries)
  but generates read-only outputs. No mutations occur.
  
Verification:
  1. Run forecast query
  2. Attempt to modify a projected transaction (invalid operation)
  3. Verify accounts remain unchanged
  4. Verify no new transactions created
```

### 2026-11: Goal Withdrawal & Linked Transaction Deletion
```
Goal Fixture:
  - id: goal_education_fund
  - workspace_id: workspace_a
  - name: "Education Fund"
  - target: $2,000.00
  - current_progress: $550.00 (from contributions in 2026-04)
  - linked_account_id: account_goal_resp_a
  - type: savings
  
Transactions Contributing to Goal:
  - 2026-04-15: $200.00 credit, category=savings, linkedGoalId=goal_education_fund
  - 2026-05-20: $150.00 credit, category=savings, linkedGoalId=goal_education_fund
  
Withdrawal Scenario:
  User wants to withdraw $100 from education fund for school expenses
  1. Creates transaction: $100.00 debit, linked_goal_id=goal_education_fund
  2. Account balance decreases: $550 → $450
  3. Goal progress recalculates:
     New Progress = $200 + $150 - $100 = $250.00
  
Deletion & Reversal:
  User later deletes one contribution transaction (2026-05-20, $150)
  1. Transaction deleted from ledger
  2. Goal progress recalculates:
     New Progress = $200 - $100 = $100.00
  3. Account balance reflects deletion:
     Balance = original + $150 (removed contribution) = $450 + $150 = $600.00
  
Test Invariant: [[goal-integrity]]
  Goal progress must remain consistent with linked transactions
  Deletion of linked transaction must trigger recalculation
  No orphaned allocations from deleted transaction
  
Verification:
  1. Query goal progress before deletion: $250
  2. Delete linked transaction
  3. Query goal progress after deletion: $100 (recalculated)
  4. Verify bucket balance reflects deletion
```

### 2026-12: Reconciliation Adjustment & Year-End
```
Reconciliation Scenario:
  Bank statement (2026-12-31): $4,100.00
  Calculated balance (from transactions): $4,050.00
  DISCREPANCY: +$50.00
  
Reconciliation Record Created:
  - statement_balance: $4,100.00
  - calculated_balance: $4,050.00
  - adjusted_balance: $4,100.00
  - adjustment_amount: +$50.00
  - reason: "Interest credit from bank"
  
Adjustment Transaction Created:
  - amount: $50.00
  - direction: credit
  - category: null (system adjustment)
  - description: "Reconciliation adjustment for 2026-12"
  
Test Invariant: [[account-conservation]]
  Reconciliation adjustments must reconcile calculated balance to statement
  Adjustment transactions must be recorded for audit
  Verify: balance = opening + transactions + adjustments = statement balance
  
Year-End Verification:
  Total income (2026): $24,500
  Total spending (2026): ~$8,100
  Total allocations (per plan): ~$24,000
  Total adjustments: $50
  Final balance: $4,100 ✓
  
Test Invariant: [[transfer-neutrality]]
  All internal transfers (between accounts within household) sum to zero
  Net household position = income - spending - external transfers
```

---

## Scenario Matrix: Which Invariant Does Each Month Test?

| Month | Primary Scenario | Invariant Tested | Expected Outcome |
|-------|---|---|---|
| **2026-01** | Baseline | Account conservation | Opening balance + income - spending = calculated balance ✓ |
| **2026-02** | Bonus income + overspending | Allocation conservation | Allocations per income ≤ received; deficit surfaces correctly ✓ |
| **2026-03** | Reconciliation | Account conservation | Reconciliation adjustment bridges gap; statement balance matched ✓ |
| **2026-04** | Import duplicate detection | Transfer neutrality (imports) | Duplicate rejected; balance counted once only ✓ |
| **2026-05** | Late income allocation | Allocation conservation | Late income allocated correctly; no double-booking ✓ |
| **2026-06** | Account-backed debt balance | Debt obligation integrity | Balance authority resolves from account, not manual entry ✓ |
| **2026-07** | Above-plan payment + interest | **Debt trajectory independence** | pace=above_plan AND trajectory=increasing both TRUE ✓ |
| **2026-08** | Monthly close | Close integrity | Closed month immutable; audit trail preserved ✓ |
| **2026-09** | Reopen & reclose | Close integrity (reopen variant) | Reopen/reclose cycle doesn't duplicate allocations ✓ |
| **2026-10** | Forecast projection | Forecast isolation | Forecast reads state; no mutations occur ✓ |
| **2026-11** | Goal withdrawal & deletion | Goal integrity | Goal progress recalculates on linked transaction deletion ✓ |
| **2026-12** | Reconciliation adjustment | Account conservation + adjustment integrity | Final balance = opening + income - spending + adjustments ✓ |

---

## Cross-Workspace Denial Tests (Throughout)

Each month's test runs with:
1. **Workspace A user (alice)**: Can read/write all Workspace A data ✓
2. **Workspace A member (bob)**: Can read all; write restricted ✓
3. **Workspace B user (charlie)**: Gets 403 or empty on Workspace A queries ✓
4. **Workspace C user (diana)**: Isolated; minimal fixture ✓

**Test Vectors**:
- `GET /financial-accounts?workspaceId=workspace_b` (from alice) → 403
- `GET /debts/debt_visa_a` (from charlie) → 403
- `PATCH /financial-accounts/account_chequing_a` (from bob, if role=viewer) → 403
- RLS joins: Workspace B cannot see Workspace A's transactions via join on accounts

---

## Seed Data Generation (Not Implemented in Phase 1)

Phase 2 will:
1. Create `/scripts/seedAdversarialHousehold.js` to populate all fixtures
2. Deterministic UUIDs (not random) so tests are reproducible
3. Seed fixture executed once per test suite run (or optionally in-memory for each test)
4. Cleanup: Optionally delete all Workspace A data after test suite completes

---

## Dependencies & Assumptions

- **No new product features**: All events use existing APIs
- **No Plan Engine changes**: Monthly review semantics remain as-is
- **No RLS policy changes**: Postgres RLS remains enforced
- **Deterministic dates**: All dates are fixed; no random/current-date calls
- **No external integrations**: All transactions are manual or via imports (not bank sync)

---

## Success Criteria for Phase 2

All tests pass:
1. ✓ Account balances reconcile across all 12 months
2. ✓ Allocation conservation verified per month
3. ✓ Debt trajectory independence confirmed (July scenario)
4. ✓ Goal progress recalculates on linked transaction changes
5. ✓ Monthly close immutability enforced
6. ✓ Forecast isolation verified (no mutations)
7. ✓ Cross-workspace denial verified for all operations
8. ✓ Import duplicate detection works correctly
9. ✓ Reconciliation adjustments reconcile balances

---

**End of Seed Plan**
