import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const readPlan = () => readFile(new URL("../src/pages/Plan.tsx", import.meta.url), "utf8");
const readDebts = () => readFile(new URL("../src/pages/Debts.tsx", import.meta.url), "utf8");
const readLayout = () => readFile(new URL("../src/components/layout/AppLayout.tsx", import.meta.url), "utf8");

test("Debts.tsx accepts embedded prop", async () => {
  const source = await readDebts();
  assert.match(source, /embedded.*boolean|boolean.*embedded/, "Debts must accept embedded prop");
});

test("Debts.tsx passes embedded to PageShell", async () => {
  const source = await readDebts();
  assert.match(source, /embedded=\{embedded\}/, "Debts must pass embedded to PageShell");
});

test("Plan.tsx has debts tab", async () => {
  const source = await readPlan();
  assert.match(source, /debts/, "Plan must have debts tab");
});

test("Plan.tsx renders Debts with embedded prop", async () => {
  const source = await readPlan();
  assert.match(source, /Debts embedded|Debts.*embedded/, "Plan must render Debts with embedded prop");
});

test("App.tsx redirects /debts to /plan?tab=debts", async () => {
  const source = await readApp();
  assert.match(source, /path="debts".*Navigate.*plan.*tab=debts/, "App must redirect /debts to /plan?tab=debts");
  assert.doesNotMatch(source, /import.*Debts.*from/, "App must not directly import Debts");
});

test("Mobile nav has Home, Transactions, Plan, Outlook, More", async () => {
  const source = await readLayout();
  assert.match(source, /to:.*"\/dashboard".*label:.*"Home"/, "Mobile nav must have Home tab");
  assert.match(source, /to:.*"\/transactions".*label:.*"Transactions"/, "Mobile nav must have Transactions tab");
  assert.match(source, /to:.*"\/plan".*label:.*"Plan"/, "Mobile nav must have Plan tab");
  assert.match(source, /to:.*"\/outlook".*label:.*"Outlook"/, "Mobile nav must have Outlook tab pointing to /outlook");
  assert.match(source, /to:.*"\/settings".*label:.*"More"/, "Mobile nav must have More tab");
});

test("Mobile nav does not have Remi or Review as primary tabs", async () => {
  const source = await readLayout();
  const mobileTabsSection = source.match(/const mobileTabs\s*=\s*\[[\s\S]*?\];/)?.[0] ?? "";
  assert.doesNotMatch(mobileTabsSection, /\/remi/, "Mobile nav must not have Remi as a primary tab");
  assert.doesNotMatch(mobileTabsSection, /\/monthly-review/, "Mobile nav must not have Monthly Review as a primary tab");
});

test("Desktop Money nav does not include Debts or Goals direct links", async () => {
  const source = await readLayout();
  assert.doesNotMatch(source, /to:.*"\/debts"/, "AppLayout desktop nav must not have /debts direct link");
  assert.doesNotMatch(source, /to:.*"\/goals"/, "AppLayout desktop nav must not have /goals direct link");
});
