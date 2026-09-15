import test from 'node:test';
import assert from 'node:assert/strict';

import { listImportHistory, getImportHistoryDetail } from '../lib/imports/importHistory.js';
import { ImportHttpError } from '../lib/imports/shared.js';

function makeDb(overrides = {}) {
  const methods = {
    async listImportBatches() { return []; },
    async listImportedRowsForBatches() { return []; },
    async listTransactionsByImportBatchIds() { return []; },
    async listImportedTransactions() { return []; },
    async listFinancialAccounts() { return []; },
    async listAccountReconciliationsForAccounts() { return []; },
    async listImportedRows() { return []; },
    ...overrides,
  };

  return {
    async transaction(callback) {
      return callback(methods);
    },
  };
}

test('listImportHistory rejects missing householdId', async () => {
  const db = makeDb();
  await assert.rejects(
    () => listImportHistory({ db, householdId: '' }),
    (err) => err instanceof ImportHttpError && err.status === 400,
  );
});

test('listImportHistory rejects db without transaction()', async () => {
  await assert.rejects(
    () => listImportHistory({ db: {}, householdId: 'hh1' }),
    /must implement transaction/,
  );
});

test('listImportHistory returns empty list when no data', async () => {
  const db = makeDb();
  const result = await listImportHistory({ db, householdId: 'hh1' });
  assert.deepEqual(result, { items: [] });
});

test('listImportHistory returns import_batch items', async () => {
  const db = makeDb({
    async listImportBatches() {
      return [{
        id: 'batch_1',
        status: 'review',
        filename: 'statement.pdf',
        source: null,
        accountId: null,
        rowCount: 5,
        createdAt: '2025-01-10T00:00:00Z',
        updatedAt: '2025-01-10T01:00:00Z',
      }];
    },
    async listImportedRowsForBatches() {
      return [
        { batchId: 'batch_1', id: 'r1', status: 'pending' },
        { batchId: 'batch_1', id: 'r2', status: 'approved' },
        { batchId: 'batch_1', id: 'r3', status: 'pending' },
      ];
    },
  });

  const result = await listImportHistory({ db, householdId: 'hh1' });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.id, 'batch_1');
  assert.equal(item.source_kind, 'import_batch');
  assert.equal(item.filename, 'statement.pdf');
  assert.equal(item.counts.pending_rows, 2);
  assert.equal(item.counts.approved_rows, 1);
  assert.equal(item.counts.imported_rows, 3);
  assert.equal(item.account, null);
  assert.equal(item.reconciliation, null);
});

test('listImportHistory includes bank_import_rows when imported transactions exist', async () => {
  const db = makeDb({
    async listImportedTransactions() {
      return [
        { id: 'it1', status: 'unreviewed', date: '2025-02-01', description: 'Coffee', amount: '5.00', createdAt: '2025-02-01T00:00:00Z' },
        { id: 'it2', status: 'classified', date: '2025-02-02', description: 'Groceries', amount: '50.00', createdAt: '2025-02-02T00:00:00Z' },
      ];
    },
  });

  const result = await listImportHistory({ db, householdId: 'hh1' });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.source_kind, 'bank_import_rows');
  assert.equal(item.row_count, 2);
  assert.equal(item.counts.pending_rows, 1);
  assert.equal(item.counts.approved_rows, 1);
});

test('listImportHistory attaches account summary when accountId present', async () => {
  const db = makeDb({
    async listImportBatches() {
      return [{
        id: 'batch_2',
        status: 'approved',
        filename: 'stmt.pdf',
        accountId: 'acc_1',
        rowCount: 2,
        createdAt: '2025-03-01T00:00:00Z',
        updatedAt: null,
      }];
    },
    async listFinancialAccounts() {
      return [{ id: 'acc_1', name: 'Chequing', institution: 'TD', accountType: 'checking', status: 'active' }];
    },
  });

  const result = await listImportHistory({ db, householdId: 'hh1' });
  const item = result.items[0];
  assert.ok(item.account);
  assert.equal(item.account.id, 'acc_1');
  assert.equal(item.account.name, 'Chequing');
  assert.equal(item.account.institution, 'TD');
});

test('listImportHistory attaches reconciliation summary when reconciliations exist', async () => {
  const db = makeDb({
    async listImportBatches() {
      return [{ id: 'batch_3', status: 'approved', filename: null, accountId: 'acc_2', rowCount: 1, createdAt: '2025-04-01T00:00:00Z', updatedAt: null }];
    },
    async listFinancialAccounts() {
      return [{ id: 'acc_2', name: 'Savings', institution: null, accountType: 'savings', status: 'active' }];
    },
    async listAccountReconciliationsForAccounts() {
      return [{ accountId: 'acc_2', status: 'confirmed', reportedAsOf: '2025-04-01', discrepancy: '0.00', createdAt: '2025-04-01T00:00:00Z' }];
    },
  });

  const result = await listImportHistory({ db, householdId: 'hh1' });
  const item = result.items[0];
  assert.ok(item.reconciliation);
  assert.equal(item.reconciliation.count, 1);
  assert.equal(item.reconciliation.latest_status, 'confirmed');
  assert.equal(item.reconciliation.latest_discrepancy, '0.00');
});

test('getImportHistoryDetail rejects missing importId', async () => {
  const db = makeDb();
  await assert.rejects(
    () => getImportHistoryDetail({ db, householdId: 'hh1', importId: '' }),
    (err) => err instanceof ImportHttpError && err.status === 400,
  );
});

test('getImportHistoryDetail returns 404 for unknown importId', async () => {
  const db = makeDb();
  await assert.rejects(
    () => getImportHistoryDetail({ db, householdId: 'hh1', importId: 'nonexistent' }),
    (err) => err instanceof ImportHttpError && err.status === 404,
  );
});

test('getImportHistoryDetail returns batch detail with rows', async () => {
  const db = makeDb({
    async listImportBatches() {
      return [{ id: 'batch_4', status: 'review', filename: 'bank.pdf', accountId: null, rowCount: 2, createdAt: '2025-05-01T00:00:00Z', updatedAt: null }];
    },
    async listImportedRows() {
      return [
        { id: 'r1', batchId: 'batch_4', status: 'pending', parsedDate: '2025-05-01', parsedDescription: 'Coffee', parsedAmount: '4.50' },
        { id: 'r2', batchId: 'batch_4', status: 'approved', parsedDate: '2025-05-02', parsedDescription: 'Groceries', parsedAmount: '80.00' },
      ];
    },
  });

  const result = await getImportHistoryDetail({ db, householdId: 'hh1', importId: 'batch_4' });
  assert.equal(result.id, 'batch_4');
  assert.equal(result.source_kind, 'import_batch');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].id, 'r1');
  assert.equal(result.rows[0].date, '2025-05-01');
  assert.equal(result.rows[1].status, 'approved');
});

test('getImportHistoryDetail returns bank_import_rows detail', async () => {
  const db = makeDb({
    async listImportedTransactions() {
      return [
        { id: 'it1', status: 'unreviewed', date: '2025-06-01', description: 'Netflix', amount: '15.99', createdAt: '2025-06-01T00:00:00Z' },
      ];
    },
  });

  const result = await getImportHistoryDetail({ db, householdId: 'hh1', importId: 'bank_import_rows' });
  assert.equal(result.source_kind, 'bank_import_rows');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, 'it1');
  assert.equal(result.rows[0].description, 'Netflix');
  assert.equal(result.rows[0].status, 'unreviewed');
});

test('listImportHistory sorts items by createdAt descending', async () => {
  const db = makeDb({
    async listImportBatches() {
      return [
        { id: 'batch_old', status: 'approved', filename: null, accountId: null, rowCount: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: null },
        { id: 'batch_new', status: 'review', filename: null, accountId: null, rowCount: 1, createdAt: '2025-06-01T00:00:00Z', updatedAt: null },
      ];
    },
  });

  const result = await listImportHistory({ db, householdId: 'hh1' });
  assert.equal(result.items[0].id, 'batch_new');
  assert.equal(result.items[1].id, 'batch_old');
});

test('import history domain is read-only (no insert/update/delete calls made)', async () => {
  const mutationCalls = [];
  const db = {
    async transaction(callback) {
      const tx = {
        async listImportBatches() { return []; },
        async listImportedRowsForBatches() { return []; },
        async listTransactionsByImportBatchIds() { return []; },
        async listImportedTransactions() { return []; },
        async listFinancialAccounts() { return []; },
        async listAccountReconciliationsForAccounts() { return []; },
        async listImportedRows() { return []; },
        async insertImportBatch() { mutationCalls.push('insertImportBatch'); },
        async updateImportBatch() { mutationCalls.push('updateImportBatch'); },
        async insertImportedRows() { mutationCalls.push('insertImportedRows'); },
        async insertTransaction() { mutationCalls.push('insertTransaction'); },
        async updateTransaction() { mutationCalls.push('updateTransaction'); },
      };
      return callback(tx);
    },
  };

  await listImportHistory({ db, householdId: 'hh1' });
  assert.deepEqual(mutationCalls, [], 'listImportHistory must not call any mutation methods');
});
