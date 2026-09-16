# MONTH LIFECYCLE AUTHORITY MAP

**Wave C F15 Implementation | Date:** 2026-09-16

---

## CANONICAL STATE MACHINE

```
OPEN → REVIEWING → CLOSED → REOPENED (if re-closed)
```

Each transition is idempotent, versioned, and audited.

---

## TRANSITION DETAILS

### OPEN → REVIEWING
**API:** `transitionToReviewing()` | **Mutation:** `monthly_reviews.status = 'reviewing'`
**Effect:** Marks month under review | **Reversible:** Yes (abandon review or navigate away)
**Audit:** `logAuditEvent(event: 'month.reviewing_started')`

### REVIEWING → CLOSED  
**API:** `closeMonth()` | **Mutation:** INSERT `monthly_closes` + UPDATE `monthly_reviews.status = 'closed'`
**Snapshot:** Income, allocations, buffer, goals, debts, transaction review summary (immutable JSON)
**Effect:** Marks month closed, snapshot captured, transactions remain mutable
**Idempotent:** YES (calling twice = same result, 409 if already closed)
**Reversible:** YES via `reopenMonth()`
**Audit:** `logAuditEvent(event: 'month.closed', metadata: { period, version })`

### CLOSED → REOPENED
**API:** `reopenMonth()` | **Mutation:** UPDATE `monthly_closes.status = 'REOPENED'` + UPDATE `monthly_reviews.status = 'reviewing'`
**Effect:** Previous close marked reopened, reverted to reviewing, can close again with new version
**Reversible:** YES (can close again)
**Permission:** Admin/Owner only (stricter than close)
**Audit:** `logAuditEvent(event: 'month.reopened', metadata: { reason, version })`

---

## BUFFER DISPOSITION (During Close)

| Type | Effect |
|------|--------|
| `roll_to_next_buffer` | Creates IncomeEntry for next month's buffer allocation |
| `apply_to_goal` | Creates Transaction linked to goal |
| `apply_to_debt` | Creates Transaction + DebtPayment entry |
| `return_to_plan` | No action (funds remain unallocated) |

**Not Implemented:** Automatic disposition, generic rollover, buffer→savings movement

---

## FINANCIAL AUTHORITY PRESERVATION

| Authority | During Close |
|-----------|---|
| **Goal.currentAmount** | ✅ NEVER directly mutated |
| **Debt.balance** | ✅ NEVER decremented |
| **Debt payment ledger** | ✅ Separate from transaction attribution |
| **Plan allocations** | ✅ Canonical backend values used |
| **Buffer flag** | ✅ Display-only (not savings floor) |
| **Transactions** | ✅ Remain mutable after close |
| **Review state** | ✅ Independent from financial state |

---

## IMMUTABILITY BOUNDARIES

**Read-Only:** Snapshot JSON, close record, version number, audit events
**Mutable After Close:** Transactions, review state, allocations, goals, debts, income entries

---

## IDEMPOTENCY

**Close:** Calling `closeMonth(period, bufferDisp=X)` twice returns same result. Third call throws 409.
**Reopen:** Can only reopen if currently CLOSED (prevents double-reopen).
**Buffer Carry-Forward:** Uses idempotency key to prevent duplicate income entries.

---

## PERMISSIONS

| Action | Role | Details |
|--------|------|---------|
| Start Review | Member+ | Any member |
| Close Month | Member+ | Any member (logged in audit) |
| Reopen Month | Admin/Owner | Stricter to prevent frivolous reopens |
| View Lifecycle | Member+ | All members |

---

## TENANT ISOLATION

- `monthly_closes` table includes `workspace_id`
- RLS policy enforced: `workspace_id = current_workspace_id()`
- Cross-workspace close/reopen prevented at database level

---

## HISTORICAL MONTH BEHAVIOR

**Visible in Historical Month:**
- Lifecycle state (OPEN/REVIEWING/CLOSED)
- Snapshot summary
- Debt balances (shown as current outstanding, not month-end historical)

**Not Available:**
- Cannot close ancient historical months
- Cannot start new review of historical month

---

## KEY LIMITATIONS

1. **Metadata-Only Close** — Not immutable accounting ledger
2. **Historical Balances** — Debt shows current, not month-end values
3. **No Auto-Disposition** — Buffer requires explicit user choice
4. **No Generic Rollover** — Deferred feature

---

## TESTING

**51 Wave C Lifecycle Tests + 3 Remi Fix Tests = 54 Total**
- State machine transitions
- Snapshot accuracy & immutability
- Idempotency (no double-application)
- Permission enforcement
- Authority invariants
- Concurrency safety
- Workspace isolation

All tests passing. Zero new regressions from Wave B baseline.
