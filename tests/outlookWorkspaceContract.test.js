import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const readOutlook = () => readFile(new URL("../src/pages/Outlook.tsx", import.meta.url), "utf8");
const readForecast = () => readFile(new URL("../src/pages/CashFlowForecast.tsx", import.meta.url), "utf8");
const readInsights = () => readFile(new URL("../src/pages/Insights.tsx", import.meta.url), "utf8");
const readLayout = () => readFile(new URL("../src/components/layout/AppLayout.tsx", import.meta.url), "utf8");

test("Outlook.tsx exists and exports Outlook component", async () => {
  const source = await readOutlook();
  assert.match(source, /export function Outlook/, "Outlook.tsx must export Outlook component");
});

test("Outlook.tsx uses useSearchParams for tab routing", async () => {
  const source = await readOutlook();
  assert.match(source, /useSearchParams/, "Outlook must use useSearchParams for tab routing");
});

test("Outlook.tsx has forecast and reports tabs", async () => {
  const source = await readOutlook();
  assert.match(source, /forecast/, "Outlook must have forecast tab");
  assert.match(source, /reports/, "Outlook must have reports tab");
});

test("Outlook.tsx defaults to forecast tab", async () => {
  const source = await readOutlook();
  assert.match(source, /:\s*["']forecast["']/, "Outlook must default to forecast tab");
});

test("Outlook.tsx renders CashFlowForecast with embedded prop", async () => {
  const source = await readOutlook();
  assert.match(source, /CashFlowForecast embedded|CashFlowForecast.*embedded/, "Outlook must render CashFlowForecast with embedded prop");
});

test("Outlook.tsx renders Insights with embedded prop", async () => {
  const source = await readOutlook();
  assert.match(source, /Insights embedded|Insights.*embedded/, "Outlook must render Insights with embedded prop");
});

test("CashFlowForecast.tsx accepts and passes embedded prop", async () => {
  const source = await readForecast();
  assert.match(source, /embedded.*boolean|boolean.*embedded/, "CashFlowForecast must accept embedded prop");
  assert.match(source, /embedded=\{embedded\}/, "CashFlowForecast must pass embedded to PageShell");
});

test("Insights.tsx accepts and passes embedded prop", async () => {
  const source = await readInsights();
  assert.match(source, /embedded.*boolean|boolean.*embedded/, "Insights must accept embedded prop");
  assert.match(source, /embedded=\{embedded\}/, "Insights must pass embedded to PageShell");
});

test("App.tsx routes /outlook to Outlook component", async () => {
  const source = await readApp();
  assert.match(source, /import.*Outlook.*from.*pages\/Outlook/, "App must import Outlook from pages/Outlook");
  assert.match(source, /path="outlook".*element=\{<Outlook/, "App must route /outlook to Outlook component");
});

test("App.tsx redirects /cash-flow-forecast and /insights to Outlook tabs", async () => {
  const source = await readApp();
  assert.match(source, /cash-flow-forecast.*Navigate.*outlook.*tab=forecast/, "App must redirect /cash-flow-forecast to /outlook?tab=forecast");
  assert.match(source, /insights.*Navigate.*outlook.*tab=reports/, "App must redirect /insights to /outlook?tab=reports");
});

test("AppLayout desktop nav has /outlook and no /cash-flow-forecast or /insights direct links", async () => {
  const source = await readLayout();
  assert.match(source, /to:.*"\/outlook"/, "AppLayout must have /outlook nav link");
  assert.doesNotMatch(source, /to:.*"\/cash-flow-forecast"/, "AppLayout must not have /cash-flow-forecast nav link");
  assert.doesNotMatch(source, /to:.*"\/insights"/, "AppLayout must not have /insights nav link");
});
