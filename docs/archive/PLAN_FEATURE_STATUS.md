# RAF Plan Feature Development Status

**Last Updated:** March 31, 2026

## Completed Tasks

### 1. Type Safety & Compilation Fixes ✅
- **PlanEngine Module** (`src/lib/planEngine.ts`):
  - Added comprehensive TypeScript types:
    - `Frequency` type for income/expense frequencies (monthly, weekly, biweekly, annual)
    - `IncomeRow`, `ExpenseRow`, `DebtRow`, `GoalRow` types
    - `PlanState` type aggregating all planning data
  - Fixed implicit `any` types in reducer functions
  - All parameters now properly typed: `calculatePlanAllocation(plan: PlanState)`
  - Exports: `normalizeToMonthly()`, `getInitialPlanState()`, `calculatePlanAllocation()`

- **PlanContext Module** (`src/context/PlanContext.tsx`):
  - Defined `PlanContextType` with `plan`, `allocation`, `updatePlan`
  - `usePlan()` hook with error boundary for out-of-provider usage
  - `PlanProvider` wrapper component
  - Deep-clones plan state on updates (immutable pattern)

### 2. Frontend Components ✅
- **PlanWizard Page** (`src/pages/PlanWizard.tsx`):
  - Multi-step wizard interface (framework ready)
  - Income, expense, debt, and goal data entry forms
  - Real-time allocation calculation via `usePlan()` hook
  - Summary display with status (surplus/deficit)

- **App Integration** (`src/App.tsx`):
  - `PlanProvider` wraps application
  - `/plan` route mounted to `PlanWizard` component
  - Routes accessible from navigation

### 3. Development Environment ✅
- ✅ TypeScript build compilation passes
- ✅ Vite dev server running on `http://localhost:5174/`
- ✅ Backend API running on `http://localhost:3000/` with CORS headers configured
- ✅ Parser and transaction endpoints ready

## Current State

### Available Endpoints
- Health: `GET http://localhost:3000/` → 404 (expected, no root route)
- Add more specific endpoints as needed (e.g., `/api/v1/plans`, `/api/v1/transactions`)

### Frontend Routes
1. **Dashboard** → `/dashboard` (default home page)
2. **Plan Wizard** → `/plan` (new multi-step planner)
3. Other existing routes (transactions, reports, etc.)

## TODO: Next Steps

### Phase 1: Core Plan Wizard Enhancement
- [ ] Implement income entry form UI
- [ ] Implement fixed/variable expense forms
- [ ] Implement debt entry form (balance, apr, min payment)
- [ ] Implement goals entry form (target, deadline, monthly contribution)
- [ ] Add form validation and error messages
- [ ] Add row deletion/editing for all categories

### Phase 2: Backend API Integration
- [ ] Create `POST /api/v1/plans` endpoint to save plan
- [ ] Create `GET /api/v1/plans/:id` endpoint to load plan
- [ ] Create `PUT /api/v1/plans/:id` endpoint to update plan
- [ ] Add database migration for `plans` table if needed
- [ ] Connect PlanContext to backend via API calls

### Phase 3: Allocation Engine Refinement
- [ ] Review allocation logic for edge cases (surplus/deficit handling)
- [ ] Implement surplus distribution strategy (savings, retirement, etc.)
- [ ] Implement deficit warning and recommendations
- [ ] Add goal tracking (progress toward deadline)
- [ ] Add debt payoff timeline calculation

### Phase 4: Dashboard Integration
- [ ] Display plan summary on dashboard
- [ ] Show current month allocation status
- [ ] Show goals progress
- [ ] Link to plan wizard for updates

### Phase 5: Persistence
- [ ] Serialize plan state to localStorage for session retention
- [ ] Optional: Add ability to save multiple plan scenarios

### Phase 6: PDF import integration (existing feature expansion)
- [ ] Connect BMO parser to plan categorization
- [ ] Auto-classify imported transactions by expense category
- [ ] Update plan based on actual spending

### Phase 7: Mobile optimization
- [ ] Make plan wizard responsive
- [ ] Test on mobile device sizes
- [ ] Simplify forms for touch input

## Technical Notes

- **Type Safety**: All reducer functions now have proper types to prevent runtime errors
- **State Management**: Immutable pattern via deep clone on updates (performant for this schema size)
- **Parser Status**: BMO bank statement parser fully functional with collapsed amount handling
- **Frontend**: React 18 + TypeScript strict mode enabled
- **Backend**: Express.js with CORS and error handling middleware in place

## Testing Checklist

- [ ] Manual test: Open plan wizard at `http://localhost:5174/plan`
- [ ] Manual test: Add income row and see calculation update
- [ ] Manual test: Add expense rows and verify total is deducted
- [ ] Manual test: Trigger deficit scenario and verify status changes
- [ ] API test: POST new plan to backend once endpoint created
- [ ] Integration test: Import transaction and map to plan category

## File Structure Reference

```
src/
  ├─ App.tsx (PlanProvider wrapper + routes)
  ├─ pages/
  │  └─ PlanWizard.tsx (multi-step form component)
  ├─ context/
  │  └─ PlanContext.tsx (state management)
  ├─ lib/
  │  └─ planEngine.ts (calculation engine + types)
  └─ ... (existing pages/components)
```
