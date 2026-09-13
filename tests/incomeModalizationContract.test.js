import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readDashboard = () => readFile(new URL("../src/pages/Dashboard.tsx", import.meta.url), "utf8");
const readTransactions = () => readFile(new URL("../src/pages/Transactions.tsx", import.meta.url), "utf8");
const readModal = () => readFile(new URL("../src/components/income/IncomeModal.tsx", import.meta.url), "utf8");

test("IncomeModal.tsx exists and exports IncomeModal component", async () => {
  const source = await readModal();
  assert.match(source, /export function IncomeModal/, "IncomeModal.tsx must export IncomeModal");
});

test("IncomeModal accepts isOpen, onClose, onSuccess props", async () => {
  const source = await readModal();
  assert.match(source, /isOpen/, "IncomeModal must accept isOpen prop");
  assert.match(source, /onClose/, "IncomeModal must accept onClose prop");
  assert.match(source, /onSuccess/, "IncomeModal must accept onSuccess callback");
});

test("IncomeModal uses createIncome from incomeApi (not a separate financial pathway)", async () => {
  const source = await readModal();
  assert.match(source, /createIncome/, "IncomeModal must use the canonical createIncome API function");
  assert.match(source, /from.*incomeApi/, "IncomeModal must import from incomeApi");
});

test("Dashboard imports and renders IncomeModal", async () => {
  const source = await readDashboard();
  assert.match(source, /import.*IncomeModal/, "Dashboard must import IncomeModal");
  assert.match(source, /<IncomeModal/, "Dashboard must render IncomeModal in JSX");
});

test("Dashboard has state to control income modal visibility", async () => {
  const source = await readDashboard();
  assert.match(source, /showIncomeModal/, "Dashboard must have showIncomeModal state");
});

test("Transactions imports and renders IncomeModal", async () => {
  const source = await readTransactions();
  assert.match(source, /import.*IncomeModal/, "Transactions must import IncomeModal");
  assert.match(source, /<IncomeModal/, "Transactions must render IncomeModal in JSX");
});

test("Transactions has Add Income button triggering the modal", async () => {
  const source = await readTransactions();
  assert.match(source, /Add Income/, "Transactions must have an Add Income button");
  assert.match(source, /showIncomeModal/, "Transactions must have showIncomeModal state");
});

test("/income/new route still exists in App.tsx (preserved)", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /income\/new/, "/income/new route must still be registered in App.tsx");
  assert.match(source, /AddIncome/, "AddIncome component must still be used for /income/new route");
});
