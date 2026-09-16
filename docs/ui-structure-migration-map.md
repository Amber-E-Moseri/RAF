# UI Structure Migration Map

> Phase 1 audit document. Maps every current route/component to its new destination.

## Route / Component Map

| Current route | Current component | Existing functions / actions | New destination | Reused component | Removed from nav? | Redirect? | Functionality preserved? |
|---|---|---|---|---|---|---|---|
| `/dashboard` | `Dashboard.tsx` | Financial attention, net surplus, plan execution, cash-flow outlook, data freshness, mark-reviewed inline | `/dashboard` (label: Home) | Yes | No | No | ✅ |
| `/transactions` | `Transactions.tsx` | List, search, filter, needs-review queue, mark reviewed, edit, import statement, import history, categorization recall/suggestions, split, goal attribution, debt attribution, transaction purpose, canonical account relationship | `/transactions` | Yes | No | No | ✅ |
| `/goals` | `Goals.tsx` | CRUD, progress (transaction-derived), milestones, achievements, transaction linking | `/plan?tab=goals` | Yes (rendered inside Plan tab) | Yes (top-level) | `/goals → /plan?tab=goals` | ✅ |
| `/debts` | `Debts.tsx` | Debt CRUD, payment attribution, payment obligation, payment pace, balance trajectory, acknowledgement, payoff assumptions | `/plan?tab=debts` | Yes (rendered inside Plan tab) | Yes (top-level) | `/debts → /plan?tab=debts` | ✅ |
| `/allocation-preferences` | `AllocationPreferences.tsx` | Allocation category CRUD, percentage editing, history, validation | `/plan?tab=allocations` | Yes (rendered inside Plan tab) | Yes (top-level) | `/allocation-preferences → /plan` | ✅ |
| `/cash-flow-forecast` | `CashFlowForecast.tsx` | Projected position, headroom/shortfall, upcoming expenses, coverage gaps, account composition, pending review, freshness/provenance | `/outlook?tab=forecast` | Yes (rendered inside Outlook tab) | Yes (top-level) | `/cash-flow-forecast → /outlook` | ✅ |
| `/insights` | `Insights.tsx` | Reports: spending mix, income vs. spending, financial health, year-to-date breakdown | `/outlook?tab=reports` | Yes (rendered inside Outlook tab) | Yes (top-level) | `/insights → /outlook?tab=reports` | ✅ |
| `/monthly-review` | `MonthlyReview.tsx` | Close month, surplus allocation, review checklist, goal/debt summary | `/monthly-review` | Yes | No | No | ✅ |
| `/remi` | `Remi.tsx` | Chat workspace, conversation history, message composer, send, starter prompts, conversation list, new chat | `/remi` | Yes | No | No | ✅ |
| `/settings` (was `/appearance-settings`) | `AppearanceSettings.tsx` | Theme, typography, scale, savings floor, import rules, household settings | `/settings` (tabs: Profile \| Household \| Appearance \| Financial \| Import Rules) | Partially (new Settings.tsx wraps) | No | `/appearance-settings → /settings` | ✅ |
| `/profile` | `Profile.tsx` | Goal achievements, allocation count, monthly review count, badge display | `/settings?tab=profile` | Yes (rendered inside Settings tab) | Yes (top-level) | `/profile → /settings?tab=profile` | ✅ |
| `/members` | `Members.tsx` | Household member management, invites | `/settings?tab=household` | Yes (linked from Household tab) | Yes (top-level) | `/members` still works; linked from Household tab | ✅ |
| `/scenarios` | `Scenarios.tsx` | What-if scenarios | `/scenarios` (kept alive, not in nav per spec — no Scenarios exposure) | Yes | Yes | No | ✅ (accessible via direct URL) |
| `/income/new` | `AddIncome.tsx` | Add income record | `/income/new` (accessible via Quick Add) | Yes | Yes (top-level) | No | ✅ (via Quick Add) |
| `/plan-wizard` | `PlanWizard.tsx` | Onboarding plan wizard | `/plan-wizard` (kept, accessible from Plan page if needed) | Yes | Yes | No | ✅ (accessible via direct URL) |

## New Routes Added

| Route | Component | Purpose |
|---|---|---|
| `/plan` | `Plan.tsx` (new) | Tab wrapper: Allocations \| Goals \| Debts |
| `/outlook` | `Outlook.tsx` (new) | Tab wrapper: Forecast \| Reports |
| `/settings` | `Settings.tsx` (new) | Tab wrapper: Profile \| Household \| Appearance \| Financial \| Import Rules |

## Compatibility Redirects

| From | To |
|---|---|
| `/goals` | `/plan?tab=goals` |
| `/debts` | `/plan?tab=debts` |
| `/insights` | `/outlook?tab=reports` |
| `/cash-flow-forecast` | `/outlook` |
| `/allocation-preferences` | `/plan` |
| `/appearance-settings` | `/settings` |
| `/profile` | `/settings?tab=profile` |

## Navigation Structure

### Desktop Sidebar

```
Overview
  Home             /dashboard
  Transactions     /transactions

Planning
  Plan             /plan
  Outlook          /outlook
  Monthly Review   /monthly-review

System
  Remi             /remi
  Settings         /settings
```

### Mobile Bottom Nav (390px)

```
Home | Transactions | Plan | Outlook | More
```

More exposes: Monthly Review, Remi, Settings

## Functionality Preservation Notes

- **Goals**: All functionality preserved inside Plan → Goals tab. Goal progress remains transaction-derived. No direct mutation of `goal.currentAmount`.
- **Debts**: All functionality preserved inside Plan → Debts tab. Debt balance is not directly decremented by transaction linking.
- **Allocation categories**: Preserved inside Plan → Allocations tab. Plan Engine remains authoritative.
- **Cash-Flow Forecast**: Full forecast page preserved inside Outlook → Forecast tab.
- **Insights / Reports**: Full reporting page preserved inside Outlook → Reports tab.
- **Monthly Review**: Standalone page, unchanged.
- **Remi**: Full production Remi (real backend, conversation history, send message) preserved.
- **Settings**: All settings preserved across tabs — Profile (achievements), Household (savings floor, members), Appearance (theme/typography), Financial (allocation categories), Import Rules.
- **Quick Add**: Top-right + button opens modal with navigation to canonical production workflows.
- **Period control**: PeriodProvider remains canonical; all period-aware pages share one context.
