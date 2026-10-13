/**
 * Paged transaction reader: walks every page, and fails loudly rather than returning partial totals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { listAllTransactionsInRange } from '../lib/raf/reporting.js';

test('reads every page until the cursor is exhausted', async () => {
  const pages = [
    { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' },
    { items: [{ id: 'c' }], nextCursor: 'c' },
    { items: [{ id: 'd' }], nextCursor: null },
  ];
  const seenCursors = [];
  const tx = {
    async listTransactions({ cursor }) {
      seenCursors.push(cursor);
      return pages[seenCursors.length - 1];
    },
  };
  const rows = await listAllTransactionsInRange(tx, { householdId: 'h1', from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(seenCursors, [null, 'b', 'c']);
});

test('accepts a plain array result (in-memory style) without paging', async () => {
  const tx = { async listTransactions() { return [{ id: 'x' }]; } };
  assert.deepEqual(await listAllTransactionsInRange(tx, { householdId: 'h1' }), [{ id: 'x' }]);
});

test('a cursor that does not advance throws instead of looping or returning partial data', async () => {
  const tx = { async listTransactions() { return { items: [{ id: 'a' }], nextCursor: 'a' }; } };
  await assert.rejects(
    () => listAllTransactionsInRange(tx, { householdId: 'h1' }),
    /did not advance/,
  );
});

test('a page loop beyond the cap throws instead of returning a partial read', async () => {
  let call = 0;
  const tx = {
    async listTransactions() {
      call += 1;
      return { items: [{ id: `t${call}` }], nextCursor: `t${call}` };
    },
  };
  await assert.rejects(
    () => listAllTransactionsInRange(tx, { householdId: 'h1' }),
    /page limit/,
  );
});

test('defaults to the full open range when from and to are omitted', async () => {
  let received = null;
  const tx = { async listTransactions(args) { received = args; return []; } };
  await listAllTransactionsInRange(tx, { householdId: 'h1' });
  assert.equal(received.from, '0001-01-01');
  assert.equal(received.to, '9999-12-31');
});
