import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Data Freshness card uses factual timestamps without color or threshold semantics', async () => {
  const source = await readFile(new URL('../src/pages/Dashboard.tsx', import.meta.url), 'utf8');

  assert.match(source, /Data Freshness/, 'card must be present');
  assert.match(source, /formatFreshnessTimestamp/, 'must use the formatting helper');
  assert.match(source, /RAF does not treat age alone as proof/, 'must include the factual note');

  assert.doesNotMatch(source, /color.*fresh|fresh.*color/i, 'must not apply color based on freshness');
  assert.doesNotMatch(source, /FRESHNESS_THRESHOLD|freshnessThreshold|freshness_threshold/i, 'must not define an age threshold');
  assert.doesNotMatch(source, /rose.*fresh|amber.*fresh|red.*fresh/i, 'must not apply danger/warning tones to freshness');
});

test('transparency slice avoids Financial Inbox-owned review state', async () => {
  const [transactionsSource, workflowSource] = await Promise.all([
    readFile(new URL('../src/pages/Transactions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/TransactionImportWorkflow.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(workflowSource, /Import History/, 'Import History card must exist in the Transactions import workflow');
  assert.match(workflowSource, /read-only record/, 'card must be clearly labeled read-only');

  assert.doesNotMatch(`${transactionsSource}\n${workflowSource}`, /importHistory.*Mark reviewed|Mark reviewed.*importHistory/s, 'Import History must not render Financial Inbox review controls');
});
