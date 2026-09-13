import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const readPlan = () => readFile(new URL("../src/pages/Plan.tsx", import.meta.url), "utf8");
const readLayout = () => readFile(new URL("../src/components/layout/AppLayout.tsx", import.meta.url), "utf8");

test("Plan.tsx exists and exports Plan component", async () => {
  const source = await readPlan();
  assert.match(source, /export function Plan/, "Plan.tsx must export Plan component");
});

test("Plan.tsx uses useSearchParams for tab routing", async () => {
  const source = await readPlan();
  assert.match(source, /useSearchParams/, "Plan must use useSearchParams for tab routing");
});

test("Plan.tsx has allocations and goals tabs", async () => {
  const source = await readPlan();
  assert.match(source, /allocations/, "Plan must have allocations tab");
  assert.match(source, /goals/, "Plan must have goals tab");
});

test("Plan.tsx defaults to allocations tab", async () => {
  const source = await readPlan();
  assert.match(source, /allocations.*allocations|default.*allocations|:\s*["']allocations["']/, "Plan must default to allocations tab");
});

test("Plan.tsx renders AllocationPreferences with embedded prop", async () => {
  const source = await readPlan();
  assert.match(source, /AllocationPreferences embedded|AllocationPreferences.*embedded/, "Plan must render AllocationPreferences with embedded prop");
});

test("Plan.tsx renders Goals with embedded prop", async () => {
  const source = await readPlan();
  assert.match(source, /Goals embedded|Goals.*embedded/, "Plan must render Goals with embedded prop");
});

test("App.tsx routes /plan to Plan component", async () => {
  const source = await readApp();
  assert.match(source, /import.*Plan.*from.*pages\/Plan/, "App must import Plan from pages/Plan");
  assert.match(source, /path="plan".*element=\{<Plan/, "App must route /plan to Plan component");
});

test("App.tsx redirects /allocation-preferences to /plan?tab=allocations", async () => {
  const source = await readApp();
  assert.match(source, /allocation-preferences.*Navigate.*plan.*tab=allocations/, "App must redirect /allocation-preferences to /plan?tab=allocations");
});

test("App.tsx redirects /goals to /plan?tab=goals", async () => {
  const source = await readApp();
  assert.match(source, /path="goals".*Navigate.*plan.*tab=goals/, "App must redirect /goals to /plan?tab=goals");
});

test("AppLayout desktop nav has /plan link and no /allocation-preferences or /goals", async () => {
  const source = await readLayout();
  assert.match(source, /to:.*"\/plan"/, "AppLayout must have /plan nav link");
  assert.doesNotMatch(source, /to:.*"\/allocation-preferences"/, "AppLayout must not have /allocation-preferences nav link");
  assert.doesNotMatch(source, /to:.*"\/goals"/, "AppLayout must not have /goals nav link");
});
