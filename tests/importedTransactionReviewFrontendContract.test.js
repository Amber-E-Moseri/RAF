import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("imported transaction review UI requires bucket assignment for approvals", async () => {
  const [transactionsSource, workflowSource] = await Promise.all([
    readFile(new URL("../src/pages/Transactions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/TransactionImportWorkflow.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(`${transactionsSource}\n${workflowSource}`, /Leave unassigned/);
  assert.match(workflowSource, /Select allocation bucket/);
  assert.match(workflowSource, /Remember this choice/);
  assert.match(transactionsSource, /must end in an allocation bucket/);
});
