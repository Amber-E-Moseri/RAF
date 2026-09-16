# Wave A — Acceptance Carry-Forward Ledger

Recorded at Wave A formal closure. Commit: `426dc8f`

---

## CF-01 — F2 Import Categorization Memory E2E

**Status:** `IMPLEMENTED — E2E DATA PENDING`

**Reason:** The authenticated workspace contained no suitable import rows/rules for a natural end-to-end test.

**Required future verification:**

1. Import statement
2. Review imported transaction → suggestion appears
3. Accept suggestion → verify category
4. Override suggestion → verify user selection wins
5. Explicitly remember/save rule
6. Import/match same merchant again → verify remembered suggestion appears

**Constraint:** Categorization memory remains USER-CONFIRMED. Do not introduce silent auto-apply merely to satisfy this test.

---

## CF-02 — F4 Import History E2E

**Status:** `IMPLEMENTED — E2E DATA PENDING`

**Reason:** No completed import batch existed in the authenticated workspace.

**Required future verification:**

1. Create/use legitimate test import → complete import review
2. Return to Import → open History → completed batch appears
3. Open batch → rows appear
4. Close History → active import/review state remains intact

**Constraint:** Do not manufacture production records directly in Postgres if the workflow can create the required data naturally through RAF. Prefer actual UI/API workflow-generated E2E data. Clean up test artifacts afterward where safe.

---

## CF-03 — Mobile Transaction Action Popover

**Status:** `KNOWN PRE-EXISTING UX DEFECT — UI MIGRATION`

**Observed at:** `390×844`

**Problem:** Goal/Debt action popovers are positioned inside the horizontally scrollable transaction table/container and can render outside the visible viewport or be clipped.

**Classification:** NOT a Wave A financial/domain defect. Do not reopen F6/F7 financial logic.

**Resolution:** Correct during the approved Transactions UI/structure migration.

**Preferred solution:** Choose an architecture appropriate to the new responsive Transactions design:
- Viewport-aware popover/portal on desktop
- Bottom sheet/action sheet on mobile
- Responsive transaction cards replacing table-dependent row actions

Do not merely increase z-index if the clipping ancestor uses overflow. Preserve the canonical F6/F7 callbacks and mutation pathways.

---

## Retest Gate

When UI migration/Wave B reaches authenticated E2E, retest CF-01, CF-02, CF-03 with reversible data created through canonical application workflows.

- **PASS** → mark CLOSED
- **FAIL (CF-01 or CF-02) with suitable data** → reclassify as product defect and fix root cause
- Do not preemptively modify implementations now
