import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const readOutlook = () => readFile(new URL("../src/pages/Outlook.tsx", import.meta.url), "utf8");
const readScenarios = () => readFile(new URL("../src/pages/Scenarios.tsx", import.meta.url), "utf8");
const readLayout = () => readFile(new URL("../src/components/layout/AppLayout.tsx", import.meta.url), "utf8");

test("Scenarios.tsx accepts and passes embedded prop", async () => {
  const source = await readScenarios();
  assert.match(source, /embedded.*boolean|boolean.*embedded/, "Scenarios must accept embedded prop");
  assert.match(source, /embedded=\{embedded\}/, "Scenarios must pass embedded to PageShell");
});

test("Outlook.tsx has scenarios tab as third tab", async () => {
  const source = await readOutlook();
  assert.match(source, /scenarios/, "Outlook must have scenarios tab");
});

test("Outlook.tsx tab order is forecast, reports, scenarios", async () => {
  const source = await readOutlook();
  const forecastIdx = source.indexOf('"forecast"');
  const reportsIdx = source.indexOf('"reports"');
  const scenariosIdx = source.indexOf('"scenarios"');
  assert.ok(forecastIdx < reportsIdx, "forecast tab must come before reports");
  assert.ok(reportsIdx < scenariosIdx, "reports tab must come before scenarios");
});

test("Outlook.tsx renders Scenarios with embedded prop", async () => {
  const source = await readOutlook();
  assert.match(source, /Scenarios embedded|Scenarios.*embedded/, "Outlook must render Scenarios with embedded prop");
});

test("App.tsx redirects /scenarios to /outlook?tab=scenarios", async () => {
  const source = await readApp();
  assert.match(source, /path="scenarios".*Navigate.*outlook.*tab=scenarios/, "App must redirect /scenarios to /outlook?tab=scenarios");
  assert.doesNotMatch(source, /import.*Scenarios.*from/, "App must not directly import Scenarios");
});

test("AppLayout has floating Remi button linking to /remi", async () => {
  const source = await readLayout();
  assert.match(source, /to="\/remi"/, "AppLayout must have a link to /remi");
  assert.match(source, /fixed.*bottom|bottom.*fixed/, "Remi button must be fixed-positioned");
});

test("AppLayout does not have Remi in the primary sidebar nav groups", async () => {
  const source = await readLayout();
  assert.doesNotMatch(source, /label:.*"AI Advisor"/, "AppLayout must not have AI Advisor nav group");
  const navGroupsSection = source.match(/const desktopNavigation\s*=\s*\[[\s\S]*?\];/)?.[0] ?? "";
  assert.doesNotMatch(navGroupsSection, /\/remi/, "Desktop nav groups must not include /remi as a nav item");
});

test("AppLayout does not have /scenarios in desktop nav", async () => {
  const source = await readLayout();
  const navGroupsSection = source.match(/const desktopNavigation\s*=\s*\[[\s\S]*?\];/)?.[0] ?? "";
  assert.doesNotMatch(navGroupsSection, /\/scenarios/, "Desktop nav groups must not include /scenarios");
});
