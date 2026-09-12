import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readDashboard = () => readFile(new URL("../src/pages/Dashboard.tsx", import.meta.url), "utf8");
const readMonthlyReview = () => readFile(new URL("../src/pages/MonthlyReview.tsx", import.meta.url), "utf8");

test("Dashboard does not import applyMonthlyReview", async () => {
  const source = await readDashboard();
  assert.doesNotMatch(source, /import.*applyMonthlyReview/,
    "Dashboard must not import applyMonthlyReview — Monthly Review is the sole execution authority");
});

test("Dashboard source does not call applyMonthlyReview directly", async () => {
  const source = await readDashboard();
  assert.doesNotMatch(source, /applyMonthlyReview\s*\(/,
    "Dashboard must not call applyMonthlyReview() — surplus execution belongs exclusively in Monthly Review");
});

test("Dashboard does not expose Quick Apply surplus execution", async () => {
  const source = await readDashboard();
  assert.doesNotMatch(source, /Quick apply/i, "Quick apply button must be removed from Dashboard");
  assert.doesNotMatch(source, /handleQuickApplySurplus/, "handleQuickApplySurplus must be removed from Dashboard");
  assert.doesNotMatch(source, /isQuickApplyingSurplus/, "Quick-apply loading state must be removed from Dashboard");
});

test("Dashboard does not expose editable surplus draft rows", async () => {
  const source = await readDashboard();
  assert.doesNotMatch(source, /surplusDraftRows/, "Editable surplus draft rows must be removed from Dashboard");
  assert.doesNotMatch(source, /editingSurplusRowId/, "Row editor state must be removed from Dashboard");
  assert.doesNotMatch(source, /surplusRowDraft/, "Row draft state must be removed from Dashboard");
  assert.doesNotMatch(source, /openSurplusRowEditor/, "Row editor handler must be removed from Dashboard");
  assert.doesNotMatch(source, /handleApplySurplusRowEdit/, "Row edit handler must be removed from Dashboard");
  assert.doesNotMatch(source, /handleCancelSurplusRowEdit/, "Row cancel handler must be removed from Dashboard");
  assert.doesNotMatch(source, /handleResetSurplusDraftRows/, "Row reset handler must be removed from Dashboard");
});

test("Dashboard shows read-only surplus prompt with Review CTA when surplus exists", async () => {
  const source = await readDashboard();
  assert.match(source, /surplusExists/, "Dashboard must check whether surplus exists for conditional display");
  assert.match(source, /Surplus available/, "Dashboard must display surplus availability label");
  assert.match(source, /Review allocation/, "Dashboard must show Review allocation CTA");
  assert.match(source, /to="\/monthly-review"/, "Review CTA must route to /monthly-review");
});

test("Dashboard surplus prompt is conditional on non-closed month", async () => {
  const source = await readDashboard();
  assert.match(source, /surplusExists && activeMonthStatus !== "closed"/,
    "Dashboard surplus prompt must not appear when the month is already closed");
});

test("Dashboard surplus amount uses Money component (privacy-aware rendering)", async () => {
  const source = await readDashboard();
  assert.match(source, /<Money value=\{dashboardData\.surplusRecommendations\.netSurplus\}/,
    "Surplus amount must be rendered via the Money component to respect Privacy Mode");
});

test("Monthly Review still imports and uses applyMonthlyReview", async () => {
  const source = await readMonthlyReview();
  assert.match(source, /from "\.\.\/api\/monthlyReviewApi"/, "Monthly Review must import from monthlyReviewApi");
  assert.match(source, /applyMonthlyReview/, "Monthly Review must still use applyMonthlyReview");
  assert.match(source, /await applyMonthlyReview\(\{/, "Monthly Review must call applyMonthlyReview with await");
  assert.match(source, /splitOverride/, "Monthly Review must pass splitOverride to the apply call");
});

test("Monthly Review still exposes full surplus workflow", async () => {
  const source = await readMonthlyReview();
  assert.match(source, /splitDraftRows/, "Monthly Review must maintain editable split draft rows");
  assert.match(source, /saveSurplusAllocationPreferences/, "Monthly Review must allow saving surplus preferences");
  assert.match(source, /getSurplusRecommendations/, "Monthly Review must fetch surplus recommendations");
});

test("surplusExists on Dashboard is derived from netSurplus without requiring distributions array", async () => {
  const source = await readDashboard();
  assert.match(source, /surplusExists\s*=\s*netSurplus\s*>\s*0/,
    "surplusExists must be computed from the scalar netSurplus amount, not distribution row length");
  assert.doesNotMatch(source, /surplusExists.*suggestedRows\.length/,
    "surplusExists must not gate on suggestedRows.length which required the removed draft rows state");
});
