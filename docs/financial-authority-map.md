# RAF Financial Authority Map

> Last updated: 2026-09-15 (branch: fix/financial-authority-consumer-remediation)
> Authority A (PR #16) merged. Financial Inbox Phase 1 (PR #17) merged.

## Core Principle

RAF must never create false certainty by collapsing different financial truths into one number.

| Domain | Answers | Must Never |
|---|---|---|
| Account balance | Current observed position | Be replaced by transaction sums |
| Transactions + payment ledger | Activity evidence | Overwrite account balance |
| Goals | Designated funding | Be inferred from bucket or account balance |
| Allocations | Intent | Be treated as actual spending |
| Forecasting | Projection from authoritative inputs | Invent balance timestamps |
| Remi | Consume authorities, not raw rows | Perform independent financial calculations |

---

## 1. Authoritative Source by Financial Domain

| Domain | Authoritative Source | Code Entry Point |
|---|---|---|
| Asset account balance | `financial_accounts.current_balance` | `tx.listFinancialAccounts()` |
| Liability account balance | `financial_accounts.current_balance` | `tx.listFinancialAccounts()` |
| Manual debt current balance | Ledger-derived: `startingBalance − totalPaid + totalAdjustments` | `deriveDebtSnapshot()` → `lib/raf/debts.js` |
| Account-backed debt balance | Linked `financial_accounts.current_balance` (via Authority A) | `resolveDebtBalanceAuthority()` → `lib/debts/debtBalanceAuthority.js` |
| Debt payment pace | `debt_payments` ledger | `classifyPaymentPace()` → `lib/raf/debts.js` |
| Goal funding/progress | Canonical transactions with `linkedGoalId` | `sumGoalLinkedContributionCents()` → `lib/reports/goalContributions.js` |
| Canonical spending | `transactions` with `direction === 'debit'` | `tx.listTransactions()` |
| Transaction review status | `transactions.reviewed_at / reviewed_by` | Financial Inbox domain (PR #17) |
| Allocation intent | `income_allocations` | `tx.listIncomeAllocations()` |
| Cash-flow opening balance | Liquid `financial_accounts.current_balance` only | `computeCashFlowForecast()` → `lib/raf/cashFlowForecasting.js` |

---

## 2. Debt Balance Authority (Authority A)

`resolveDebtBalanceAuthority({ debt, financialAccount })` in `lib/debts/debtBalanceAuthority.js`:

**Manual debt** (no `financialAccountId`):
```js
{ source: 'manual_derived', balance: null, asOf: null, financialAccountId: null }
```
Authoritative balance comes from `deriveDebtSnapshot` ledger computation.

**Account-backed debt** (has `financialAccountId`):
```js
{ source: 'financial_account', balance: '3200.00', asOf: '2026-09-12', financialAccountId: 'acct_cc' }
```
Authoritative balance is `financial_accounts.current_balance` for the linked account.

**Broken link** (linked but account missing): throws `"linked debt requires a financial account to resolve balance authority"`. Never silently falls back to manual authority.

All debt consumers (Remi summary, tool loop, health score, trajectory) must pass the debt through `resolveDebtBalanceAuthority` before calling `deriveDebtSnapshot` or `buildDebtListResponse`.

---

## 3. Known Cross-Authority Seams

### Remi Summary vs. Tool Loop

`buildFinancialContext` (the summary route) and the `dispatchToolCall` tool loop are separate code paths. Both now route through `resolveDebtBalanceAuthority` and `buildDebtListResponse`. Spending in both routes uses `direction === 'debit'`.

### Goal Progress: Transactions vs. Bucket Balance

Goal progress is the **sum of transactions with `linkedGoalId`** via `sumGoalLinkedContributionCents`. The bucket allocation balance is context, not progress. `goal.currentAmount` is a raw DB field that must not be used as goal funding authority.

### Forecast: Opening Balance vs. Canonical Spending

The forecast uses `financial_accounts.current_balance` as the opening position. Historical transactions are used only for trailing-average baselines. These are separate authorities — balance and spending evidence are never added together.

---

## 4. What RAF Must Never Auto-Correct

- Do not synchronize debt ledger balance with account balance automatically.
- Do not update goal progress when a transaction changes — progress is always computed on read.
- Do not update account balance from debt payment activity.
- Do not infer a balance observation timestamp when none is known. Use `balanceAsOf: null`.
- Do not use account creation time as a proxy for when the balance was observed.
- Do not treat `goal.currentAmount` as authoritative goal funding.
- Do not treat `transaction.amount` sign as authoritative debit/credit direction — use `direction`.

---

## 5. Remi Authority Rules

Remi is a consumer of RAF's domain authorities — never an independent calculator.

| What Remi receives | Source |
|---|---|
| Spending totals | `buildRemiSpendingContext()` — filters by `transaction.direction === 'debit'` only |
| Goal progress | `buildRemiGoalContext()` — pre-computed via `sumGoalLinkedContributionCents()` |
| Debt balances | `buildRemiDebtContext()` — authoritative snapshots from `buildDebtListResponse()` → `deriveDebtSnapshot()` via `resolveDebtBalanceAuthority()` |
| Debt strategy (tool loop) | `handleGetDebtStrategy()` → `buildDebtListResponse()` with authority-resolved debts |
| Goal dashboard (tool loop) | `handleGetGoalProgress()` → `getDashboardReport()` → `buildGoalProgress()` |

---

## 6. Forecast Balance Provenance

`computeCashFlowForecast()` returns factual provenance in `assumptions`:

```ts
assumptions: {
  // ...existing fields (numeric calculations unchanged)...
  accountBalanceAsOf: string | null,     // oldest known as-of date across liquid accounts
  daysSinceOldestBalance: number | null, // days from oldest as-of to forecast start
  accountBreakdown: [
    {
      accountId: string | null,
      type: string,
      balance: string,
      balanceAsOf: string | null,        // null = not known, never substituted
    }
  ]
}
```

Investment and liability accounts are excluded from `accountBreakdown` (they are excluded from the opening balance). No qualitative freshness labels (e.g. "stale", "aging") are applied — these are deferred pending approved product-level policy.

---

## 7. Debt Account-vs-Ledger Divergence

**Not implemented in this branch.** The resolver (`resolveDebtBalanceAuthority`) answers: "what balance is authoritative?" Future reconciliation work will answer: "how does the authoritative account balance compare with other evidence?" — producing `ledgerDerivedBalance` and `divergence`. This belongs in a dedicated reconciliation layer, not inside `deriveDebtSnapshot` or Remi consumers.

---

## 8. Remaining Authority Risks (Follow-Up Work)

### LEGACY_DIRECT_READ — `toolHandlers.js` belt-and-suspenders debit filter

**Location**: `lib/remi/toolHandlers.js` `handleExplainVariance` and `handleGetTransactionSummary`

**Pattern**: `transaction.direction === 'debit' || Number(transaction.amount ?? 0) < 0`

The `direction === 'debit'` check is present, so canonical transactions are handled correctly. The `|| amount < 0` fallback is a legacy safety net for direction-less rows. The same class of defect fixed in Phase 1 here.

**Risk**: A transaction with `direction: 'credit'` and a negative amount (e.g. a reversal) would be erroneously counted as spending by the fallback.

**Recommended fix**: Remove the `|| amount < 0` fallback from both handlers.

**Blast radius**: Low — only affects Remi tool loop handlers, not stored data or Plan Engine.
