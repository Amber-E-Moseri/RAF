/**
 * PHASE 12 — Wave B targeted frontend contract tests.
 *
 * Verifies that source-level contracts match the approved spec for F10–F14.
 * These are static analysis tests: they read source files and assert key patterns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ── Helpers ──────────────────────────────────────────────────────────────────

function src(rel) {
  return readFile(new URL(`../${rel}`, import.meta.url), "utf8");
}

// ── F13 Plan — tabs, URL state, Planned/Used/Remaining ───────────────────────

test("F13: Plan.tsx exposes three tabs via useSearchParams ?tab= pattern", async () => {
  const planSource = await src("src/pages/Plan.tsx");

  assert.match(planSource, /useSearchParams/, "must use URL-state tab routing");
  assert.match(planSource, /allocations/, "allocations tab must exist");
  assert.match(planSource, /goals/, "goals tab must exist");
  assert.match(planSource, /debts/, "debts tab must exist");
  assert.match(planSource, /searchParams\.get\("tab"\)/, "must read tab from search params");
  assert.match(planSource, /setSearchParams.*tab/, "must write tab to search params");
});

test("F13: Plan.tsx embeds PlanExecutionCard in the allocations tab", async () => {
  const planSource = await src("src/pages/Plan.tsx");

  assert.match(planSource, /PlanExecutionCard/, "PlanExecutionCard must be imported/used");
  assert.match(planSource, /validTab === "allocations"[\s\S]{0,500}PlanExecutionCard/, "PlanExecutionCard must render inside allocations tab");
});

test("F13: PlanExecutionCard exposes Planned/Used/Remaining from MonthlyBucketProgress (no React-side math)", async () => {
  const cardSource = await src("src/components/plan/PlanExecutionCard.tsx");

  assert.match(cardSource, /allocated_this_month/, "Planned must come from allocated_this_month");
  assert.match(cardSource, /used_this_month/, "Used must come from used_this_month");
  assert.match(cardSource, /remaining_this_month/, "Remaining must come from remaining_this_month");
  assert.match(cardSource, /getDashboardReport/, "must fetch from getDashboardReport (server authority)");
  assert.match(cardSource, /Planned/, "must label Planned column");
  assert.match(cardSource, /Used/, "must label Used column");
  assert.match(cardSource, /Remaining/, "must label Remaining column");
});

// ── F10 Goals — transaction-derived progress, pace copy ───────────────────────

test("F10: Goals.tsx derives pace from period transactions filtered by linkedGoalId", async () => {
  const goalsSource = await src("src/pages/Goals.tsx");

  assert.match(goalsSource, /linkedGoalId/, "must filter transactions by linkedGoalId");
  assert.match(goalsSource, /direction.*credit|credit.*direction/, "must filter to credit direction for pace");
  assert.match(goalsSource, /allocated_this_month|getDashboardReport|goal_progress/, "must use server-authoritative goal data");
});

test("F10: Goals.tsx pace copy does not imply predictive certainty", async () => {
  const goalsSource = await src("src/pages/Goals.tsx");

  assert.match(goalsSource, /if this period.*pace holds/, "pace copy must qualify single-period basis");
  assert.doesNotMatch(goalsSource, /at current pace/, "must not use 'at current pace' (implies ongoing accuracy)");
});

test("F10: Goals.tsx pace label in detail modal is 'Est. at this pace' not 'Projected to target'", async () => {
  const goalsSource = await src("src/pages/Goals.tsx");

  assert.match(goalsSource, /Est\. at this pace/, "modal pace label must say 'Est. at this pace'");
  assert.doesNotMatch(goalsSource, /Projected to target/, "must not use 'Projected to target'");
});

test("F10: Goals.tsx never directly mutates goal.currentAmount", async () => {
  const goalsSource = await src("src/pages/Goals.tsx");

  assert.doesNotMatch(goalsSource, /currentAmount\s*[+\-]?=/, "goal.currentAmount must never be mutated");
  assert.doesNotMatch(goalsSource, /currentAmount\s*\+=/, "goal.currentAmount must never be incremented");
});

// ── F11 Debts — trajectory independence, historical disclosure ────────────────

test("F11: Debts.tsx uses isCurrentMonth for historical period detection", async () => {
  const debtsSource = await src("src/pages/Debts.tsx");

  assert.match(debtsSource, /isCurrentMonth/, "must import and use isCurrentMonth from usePeriod");
});

test("F11: Debts.tsx shows a disclosure banner when viewing a non-current month", async () => {
  const debtsSource = await src("src/pages/Debts.tsx");

  assert.match(debtsSource, /!isCurrentMonth/, "must conditionally render banner when not current month");
  assert.match(
    debtsSource,
    /current.*balance|balance.*current/i,
    "disclosure must mention that balance reflects current state"
  );
  assert.match(debtsSource, /past period|non-current|Viewing a past/i, "disclosure must identify the viewing context");
});

test("F11: PaymentPaceInsight keeps balance trajectory independent from payment pace", async () => {
  const paceSource = await src("src/components/debt/PaymentPaceInsight.tsx");

  assert.match(paceSource, /balanceGrowing/, "must track balanceGrowing as independent signal");
  assert.match(
    paceSource,
    /Balance is growing|balance.*growing|growing.*balance/i,
    "must surface balance trajectory separately from pace"
  );
});

// ── F14 Buffer — isBuffer identification, Starting/Used/Remaining, display only ─

test("F14: BufferStatusCard identifies buffer via isBuffer flag (not savings floor)", async () => {
  const bufferSource = await src("src/components/plan/BufferStatusCard.tsx");

  assert.match(bufferSource, /isBuffer/, "must find isBuffer category");
  assert.match(bufferSource, /getAllocationCategories/, "must use getAllocationCategories to locate buffer");
  assert.doesNotMatch(bufferSource, /getFinancialHealthReport/, "must NOT use getFinancialHealthReport (savings floor)");
  assert.doesNotMatch(bufferSource, /savingsFloor/, "must NOT reference savingsFloor");
});

test("F14: BufferStatusCard shows Starting/Used/Remaining from MonthlyBucketProgress", async () => {
  const bufferSource = await src("src/components/plan/BufferStatusCard.tsx");

  assert.match(bufferSource, /allocated_this_month/, "Starting must come from allocated_this_month");
  assert.match(bufferSource, /used_this_month/, "Used must come from used_this_month");
  assert.match(bufferSource, /remaining_this_month/, "Remaining must come from remaining_this_month");
  assert.match(bufferSource, /Starting/, "must label Starting field");
  assert.match(bufferSource, /Used/, "must label Used field");
  assert.match(bufferSource, /Remaining/, "must label Remaining field");
});

test("F14: BufferStatusCard is display-only with no disposition mutation", async () => {
  const bufferSource = await src("src/components/plan/BufferStatusCard.tsx");

  assert.match(bufferSource, /Display only|display only/i, "must show display-only disclaimer");
  assert.doesNotMatch(bufferSource, /transfer|rollover|dispose|mutation/, "must not expose any mutation action");
});

// ── F12 Cash Flow — 5 required Wave B components ─────────────────────────────

test("F12: CashFlowForecast renders HeadroomShortfallCard using summaryMetrics.headroom/shortfall", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  assert.match(forecastSource, /HeadroomShortfallCard/, "HeadroomShortfallCard component must exist");
  assert.match(forecastSource, /summaryMetrics/, "must reference summaryMetrics for headroom/shortfall data");
  assert.match(forecastSource, /headroom/, "must use headroom field");
  assert.match(forecastSource, /shortfall/, "must use shortfall field");
});

test("F12: CashFlowForecast renders FreshnessPanel using freshnessBreakdown", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  assert.match(forecastSource, /FreshnessPanel/, "FreshnessPanel component must exist");
  assert.match(forecastSource, /freshnessBreakdown/, "must use assumptions.freshnessBreakdown");
  assert.match(forecastSource, /daysSinceOldestBalance/, "must surface daysSinceOldestBalance");
});

test("F12: CashFlowForecast renders AccountCompositionPanel using accountBreakdown", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  assert.match(forecastSource, /AccountCompositionPanel/, "AccountCompositionPanel component must exist");
  assert.match(forecastSource, /accountBreakdown/, "must use assumptions.accountBreakdown");
});

test("F12: CashFlowForecast renders CoverageGapWarning using coverageGaps", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  assert.match(forecastSource, /CoverageGapWarning/, "CoverageGapWarning component must exist");
  assert.match(forecastSource, /coverageGaps/, "must use assumptions.coverageGaps");
});

test("F12: CashFlowForecast renders PendingReviewWarning using pendingReviewCount", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  assert.match(forecastSource, /PendingReviewWarning/, "PendingReviewWarning component must exist");
  assert.match(forecastSource, /pendingReviewCount/, "must use assumptions.pendingReviewCount");
});

test("F12: CashFlowForecast does not invent confidence scores or React-side balance authority", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  assert.doesNotMatch(forecastSource, /confidenceScore|riskScore|financialRisk/, "must not invent confidence/risk scores");
  assert.doesNotMatch(forecastSource, /currentBalance\s*[+\-]=/, "must not mutate balance on client side");
});

test("F12: FreshnessPanel distinguishes data age from financial incorrectness", async () => {
  const forecastSource = await src("src/pages/CashFlowForecast.tsx");

  // The freshness panel must not say "incorrect" or "wrong" for old data
  // It may say "stale" or note days old
  assert.doesNotMatch(
    forecastSource,
    /financially incorrect|balance.*wrong|incorrect.*balance/i,
    "data age must NOT be labeled as financially incorrect"
  );
});

// ── CF-03 Mobile transaction actions architecture ─────────────────────────────

test("CF-03: Transactions.tsx exposes a mobile action trigger (⋯ button) sharing the same handlers as desktop", async () => {
  const source = await src("src/pages/Transactions.tsx");

  // Mobile ⋯ trigger exists and sets mobileActionsId state
  assert.match(source, /mobileActionsId/, "must track open mobile action sheet by transaction id");
  assert.match(source, /setMobileActionsId/, "must expose a setter for mobileActionsId");

  // The ⋯ trigger is inline in the Description cell (visible without horizontal scroll)
  // sm:hidden hides the button on desktop; the ⋯ character is the button label
  assert.match(source, /sm:hidden/, "mobile trigger must use sm:hidden to be hidden on sm+ breakpoints");
  assert.match(source, /⋯/, "⋯ character must appear as the mobile action trigger label");
  assert.match(source, /aria-label="Transaction actions"/, "⋯ trigger must have accessible label");

  // Bottom sheet renders at fixed viewport level (not inside overflow container)
  assert.match(source, /fixed inset-0/, "mobile sheet must use fixed positioning to escape overflow container");

  // Same handlers are reused — no duplicate mutation logic
  assert.match(source, /handleQuickLink.*mobileActionsTx|mobileActionsTx.*handleQuickLink/, "mobile sheet must invoke handleQuickLink (not a new pathway)");
  assert.match(source, /mapTransactionToEditState.*mobileActionsTx|mobileActionsTx.*mapTransactionToEditState/, "mobile sheet must reuse mapTransactionToEditState");
  assert.match(source, /handleDeleteTransaction.*mobileActionsTx|mobileActionsTx.*handleDeleteTransaction/, "mobile sheet must reuse handleDeleteTransaction");

  // Desktop-only columns hidden on mobile, desktop actions column hidden on mobile
  assert.match(source, /hidden sm:table-cell/, "desktop-only columns must be hidden on mobile");

  // Backdrop dismiss works
  assert.match(source, /setMobileActionsId\(null\)/, "must support dismissal via backdrop or cancel");
});

test("CF-03: Table.tsx supports per-column thClassNames without breaking existing usage", async () => {
  const source = await src("src/components/ui/Table.tsx");

  assert.match(source, /thClassNames/, "Table must accept thClassNames prop");
  // Existing base class is preserved
  assert.match(source, /px-4 py-3\.5/, "existing th base class must remain");
  // Per-column class is merged, not replaced
  assert.match(source, /thClassNames\?\.\[index\]/, "per-column class must be indexed from thClassNames array");
});

// ── Debts.tsx transaction limit contract ─────────────────────────────────────

test("Debts.tsx transaction request limit does not exceed the transactions API maximum (100)", async () => {
  const source = await src("src/pages/Debts.tsx");

  // Must request limit <= 100 (API enforces this hard cap)
  assert.match(source, /limit:\s*100/, "Debts must request at most 100 transactions (API max)");
  // Must NOT request limit > 100 (101-109, 110-199, 200-999, 1000+)
  assert.doesNotMatch(source, /limit:\s*(?:10[1-9]|1[1-9]\d|[2-9]\d{2}|\d{4,})/, "Debts must not request more than 100 transactions");
});
