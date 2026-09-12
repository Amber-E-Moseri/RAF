import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const editorUrl = new URL("../src/components/transactions/SplitTransactionEditor.tsx", import.meta.url);
const transactionsUrl = new URL("../src/pages/Transactions.tsx", import.meta.url);
const apiUrl = new URL("../src/api/transactionsApi.ts", import.meta.url);

test("Transactions edit flow exposes SplitTransactionEditor without changing credits", async () => {
  const source = await readFile(transactionsUrl, "utf8");

  assert.match(source, /SplitTransactionEditor/);
  assert.match(source, /transaction=\{\{/);
  assert.match(source, /direction: editingTransaction\.direction/);
  assert.match(source, /categories=\{data\?\.categories \?\? \[\]\}/);
  assert.match(source, /setSubmitSuccess\("Transaction split saved\."\)/);
  assert.match(source, /setSubmitSuccess\("Transaction split cleared\."\)/);
});

test("split API helpers use GET, PUT replace, and DELETE clear endpoints", async () => {
  const source = await readFile(apiUrl, "utf8");

  assert.match(source, /getTransactionSplits/);
  assert.match(source, /getJson<TransactionSplitsResponse>\(`\/transactions\/\$\{transactionId\}\/splits`\)/);
  assert.match(source, /setTransactionSplits/);
  assert.match(source, /putJson<TransactionSplitsResponse>\(`\/transactions\/\$\{transactionId\}\/splits`, \{ splits \}\)/);
  assert.match(source, /clearTransactionSplits/);
  assert.match(source, /deleteJson<void>\(`\/transactions\/\$\{transactionId\}\/splits`\)/);
});

test("split editor loads existing splits and initializes unsplit debit transactions safely", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /getTransactionSplits\(transaction\.id\)/);
  assert.match(source, /buildInitialSplitRows\(transaction, response\.splits\)/);
  assert.match(source, /existingSplits\.length/);
  assert.match(source, /amount: transaction\.amount/);
  assert.match(source, /categoryId: transaction\.categoryId \?\? ""/);
  assert.match(source, /if \(transaction\.direction !== "debit"\)/);
  assert.match(source, /return null/);
});

test("split editor supports add, remove, save, clear, and cancel flows", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /function addRow\(\)/);
  assert.match(source, /\+ Add split/);
  assert.match(source, /function removeRow\(localId: string\)/);
  assert.match(source, /Remove split row/);
  assert.match(source, /setTransactionSplits\(transaction\.id, toPayload\(rows\)\)/);
  assert.match(source, /clearTransactionSplits\(transaction\.id\)/);
  assert.match(source, /function cancelEdit\(\)/);
  assert.match(source, /setRows\(buildInitialSplitRows\(transaction, existingSplits\)\)/);
});

test("split validation mirrors backend conservation and row-count rules", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /export function validateSplitRows/);
  assert.match(source, /rows\.length < 2/);
  assert.match(source, /Add at least one more split\./);
  assert.match(source, /cents == null \|\| cents <= 0/);
  assert.match(source, /Enter an amount greater than \$0\./);
  assert.match(source, /remainingCents > 0/);
  assert.match(source, /Split amounts are below the transaction total\./);
  assert.match(source, /remainingCents < 0/);
  assert.match(source, /Split amounts are above the transaction total\./);
  assert.match(source, /isValid: true/);
});

test("duplicate categories and nullable categories remain allowed by payload mapping", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.doesNotMatch(source, /new Set\(.*categoryId/);
  assert.match(source, /categoryId: row\.categoryId \|\| null/);
  assert.match(source, /<option value="">Uncategorized<\/option>/);
});

test("split categories are presented as active attribution while parent category is inactive", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /Split categories replace the transaction's single category while this split is active\./);
  assert.match(source, /Parent category:/);
  assert.match(source, /Clear split/);
});

test("privacy mode-compatible display uses Money for non-editable totals and readable inputs for editing", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /<Money value=\{transaction\.amount\}/);
  assert.match(source, /<Money value=\{centsToMoney\(validation\.totalCents\)\}/);
  assert.match(source, /<Money value=\{centsToMoney\(Math\.abs\(validation\.remainingCents\)\)\}/);
  assert.match(source, /Split amounts match the transaction total\./);
  assert.match(source, /inputMode="decimal"/);
  assert.doesNotMatch(source, /PRIVACY_MASK/);
});

test("split editor includes accessible labels, status, field errors, and keyboard buttons", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /<span className="mb-2 block text-sm font-medium text-\[var\(--text-strong\)\]">Category<\/span>/);
  assert.match(source, /<span className="mb-2 block text-sm font-medium text-\[var\(--text-strong\)\]">Amount<\/span>/);
  assert.match(source, /aria-label=\{`Remove split row \$\{index \+ 1\}`\}/);
  assert.match(source, /aria-invalid=\{hasAmountError\}/);
  assert.match(source, /aria-describedby=\{hasAmountError \? amountErrorId : undefined\}/);
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /role="alert"/);
});

test("split editor has a mobile stacked row contract and desktop compact grid", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.match(source, /grid gap-3 rounded-lg/);
  assert.match(source, /md:grid-cols-\[minmax\(0,1\.2fr\)_minmax\(0,0\.8fr\)_auto\]/);
  assert.doesNotMatch(source, /overflow-x-auto/);
});
