import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("goals are wired into planning navigation and the frontend route", async () => {
  const [appSource, layoutSource, goalsPageSource, goalsApiSource] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/layout/AppLayout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Goals.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/api/goalsApi.ts", import.meta.url), "utf8"),
  ]);

  assert.match(appSource, /path="goals"/);
  assert.match(appSource, /path="goals".*Navigate.*\/plan\?tab=goals/);
  assert.match(layoutSource, /to: "\/plan\?tab=goals", label: "Goals"/);
  assert.match(goalsPageSource, /title="Goals"/);
  assert.match(goalsPageSource, /Paid so far/);
  assert.match(goalsPageSource, /getDashboardReport/);
  assert.match(goalsPageSource, /createGoal/);
  assert.match(goalsPageSource, /updateGoal/);
  assert.match(goalsApiSource, /export function createGoal/);
  assert.match(goalsApiSource, /export function updateGoal/);
  assert.match(goalsApiSource, /export function deleteGoal/);
});
