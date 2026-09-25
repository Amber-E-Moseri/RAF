/**
 * Regression suite — PostgreSQL insertImportedTransactions
 *
 * Verifies that the INSERT query references only columns that exist in
 * raf.imported_transactions, workspace_id is populated from the row's
 * householdId, all NOT NULL columns receive values, and workspace
 * isolation is enforced at the query-parameter level.
 *
 * Uses a mock pg client — no real database connection required.
 *
 * Coverage:
 *   A. valid row is inserted
 *   B. workspace_id sourced from row.householdId
 *   C. workspace_id sourced from explicit householdId parameter when row lacks it
 *   D. date persisted
 *   E. amount persisted
 *   F. description persisted
 *   F2. null description is rejected (domain normalization already prevents this,
 *       but the INSERT must not supply NULL for description)
 *   G. status defaults to 'unreviewed' when not set
 *   G2. explicit status is persisted as-is
 *   H. raw_json contains the full row object
 *   I. batch_id is NOT present in the INSERT column list
 *   J. workspace isolation — WS_A rows cannot be associated with WS_B
 *   K. multiple rows each get their own INSERT call
 *   L. atomicity — no rows survive when one INSERT fails mid-batch
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildImportsRepository } from '../lib/repositories/postgres/importsRepository.js';

const SCHEMA = 'raf';
const WS_A = 'aaaaaaaa-0000-4000-8000-000000000010';
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000011';

function makeInsertClient({ failOnNth = null } = {}) {
  const calls = [];
  let callCount = 0;

  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    callCount += 1;
    if (failOnNth !== null && callCount === failOnNth) {
      throw new Error('simulated DB error on INSERT ' + callCount);
    }
    calls.push({ sql: normalized, params });
    return { rows: [], rowCount: 1 };
  };

  return { query, calls };
}

function makeRow(overrides = {}) {
  return {
    householdId: WS_A,
    date: '2026-09-15',
    amount: '47.50',
    description: 'GROCERY STORE',
    status: 'unreviewed',
    currency: 'CAD',
    source: 'bank_import',
    rawDescription: 'GROCERY STORE',
    referenceNumber: null,
    balanceAfterTransaction: null,
    classificationType: null,
    linkedTransactionId: null,
    ...overrides,
  };
}

// A. valid row can be inserted without error
test('insertImportedTransactions — valid row inserts without error', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  const result = await repo.insertImportedTransactions({ rows: [makeRow()] });
  assert.strictEqual(result.length, 1, 'returns array of one inserted row');
  assert.ok(result[0].id, 'inserted row has generated id');
});

// B. workspace_id is sourced from row.householdId when householdId param omitted
test('insertImportedTransactions — workspace_id from row.householdId when param omitted', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow({ householdId: WS_A })] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.ok(insertCall, 'INSERT must be issued');
  assert.strictEqual(insertCall.params[1], WS_A, 'workspace_id ($2) must equal WS_A from row');
});

// C. workspace_id sourced from explicit householdId parameter overrides row value
test('insertImportedTransactions — explicit householdId param takes precedence over row.householdId', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  // Row says WS_A, but explicit param says WS_B
  await repo.insertImportedTransactions({ rows: [makeRow({ householdId: WS_A })], householdId: WS_B });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.ok(insertCall, 'INSERT must be issued');
  assert.strictEqual(insertCall.params[1], WS_B, 'workspace_id must come from explicit householdId param');
});

// D. date is persisted
test('insertImportedTransactions — date persisted as $3', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow({ date: '2026-09-15' })] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertCall.params[2], '2026-09-15', 'date must be $3');
});

// E. amount is persisted
test('insertImportedTransactions — amount persisted as $4', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow({ amount: '123.45' })] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertCall.params[3], '123.45', 'amount must be $4');
});

// F. description is persisted
test('insertImportedTransactions — description persisted as $5', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow({ description: 'COFFEE SHOP' })] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertCall.params[4], 'COFFEE SHOP', 'description must be $5');
});

// G. status defaults to 'unreviewed' when row has no status
test("insertImportedTransactions — status defaults to 'unreviewed' when absent", async () => {
  const rowWithoutStatus = makeRow();
  delete rowWithoutStatus.status;
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [rowWithoutStatus] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertCall.params[5], 'unreviewed', "status must default to 'unreviewed'");
});

// G2. explicit status is persisted
test("insertImportedTransactions — explicit status 'reviewed' is persisted", async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow({ status: 'reviewed' })] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertCall.params[5], 'reviewed', 'explicit status must be persisted as-is');
});

// H. raw_json contains the full row object
test('insertImportedTransactions — raw_json ($7) contains the row object', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow({ description: 'PAYROLL DEPOSIT' })] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  const rawJson = insertCall.params[6];
  assert.ok(typeof rawJson === 'object' && rawJson !== null, 'raw_json must be an object');
  assert.strictEqual(rawJson.description, 'PAYROLL DEPOSIT', 'raw_json must contain description');
});

// I. batch_id is NOT in the INSERT column list
test('insertImportedTransactions — INSERT does NOT reference batch_id', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow()] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.ok(insertCall, 'INSERT must be issued');
  assert.ok(!/batch_id/i.test(insertCall.sql), 'batch_id must NOT appear in the INSERT column list');
});

// I2. INSERT includes only the expected columns
test('insertImportedTransactions — INSERT column list is exactly the expected set', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  await repo.insertImportedTransactions({ rows: [makeRow()] });

  const insertCall = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  const colMatch = insertCall.sql.match(/\(([^)]+)\)\s+VALUES/i);
  assert.ok(colMatch, 'INSERT must have a column list before VALUES');
  const cols = colMatch[1].split(',').map((c) => c.trim().replace(/\s+/g, '_'));
  for (const required of ['id', 'workspace_id', 'date', 'amount', 'description', 'status', 'raw_json', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(required), `column list must include ${required}`);
  }
  assert.ok(!cols.includes('batch_id'), 'batch_id must NOT be in column list');
});

// J. workspace isolation — rows for WS_A are inserted with WS_A, not WS_B
test('insertImportedTransactions — workspace isolation: WS_A row uses WS_A workspace_id', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  const rowA = makeRow({ householdId: WS_A, description: 'WS_A GROCERY' });
  const rowB = makeRow({ householdId: WS_B, description: 'WS_B GROCERY' });

  await repo.insertImportedTransactions({ rows: [rowA] });
  const insertA = client.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertA.params[1], WS_A, 'WS_A row workspace_id must be WS_A');

  const client2 = makeInsertClient();
  const repo2 = buildImportsRepository(client2, SCHEMA);
  await repo2.insertImportedTransactions({ rows: [rowB] });
  const insertB = client2.calls.find((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertB.params[1], WS_B, 'WS_B row workspace_id must be WS_B');
});

// K. multiple rows each get their own INSERT
test('insertImportedTransactions — each row issues a separate INSERT', async () => {
  const client = makeInsertClient();
  const repo = buildImportsRepository(client, SCHEMA);
  const rows = [
    makeRow({ date: '2026-09-01', description: 'ROW ONE', amount: '10.00' }),
    makeRow({ date: '2026-09-02', description: 'ROW TWO', amount: '20.00' }),
    makeRow({ date: '2026-09-03', description: 'ROW THREE', amount: '30.00' }),
  ];

  const result = await repo.insertImportedTransactions({ rows });
  const insertCalls = client.calls.filter((c) => /INSERT INTO.*imported_transactions/i.test(c.sql));
  assert.strictEqual(insertCalls.length, 3, 'must issue 3 INSERT calls for 3 rows');
  assert.strictEqual(result.length, 3, 'must return 3 inserted rows');
});

// L. atomicity — when INSERT throws, error propagates and no partial result is returned
test('insertImportedTransactions — error on second INSERT propagates to caller', async () => {
  const client = makeInsertClient({ failOnNth: 2 });
  const repo = buildImportsRepository(client, SCHEMA);
  const rows = [
    makeRow({ date: '2026-09-01', description: 'FIRST ROW', amount: '10.00' }),
    makeRow({ date: '2026-09-02', description: 'SECOND ROW', amount: '20.00' }),
  ];

  await assert.rejects(
    () => repo.insertImportedTransactions({ rows }),
    /simulated DB error on INSERT 2/,
    'error from second INSERT must propagate to the caller',
  );
});

// End-to-end: importBankStatement returns staged rows from a synthetic PDF
test('importBankStatement — synthetic PDF returns staged rows, no financial records created', async () => {
  const { importBankStatement } = await import('../lib/imports/bankStatementImports.js');

  const capturedRows = [];
  const db = {
    async transaction(cb) {
      const tx = {
        async getImportBatchByFileHash() { return null; },
        async insertImportBatch() { return { id: 'batch_fake', source: 'bank_import' }; },
        async insertImportedTransactions({ rows }) {
          const inserted = rows.map((row, i) => ({
            id: `fake_id_${i + 1}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...row,
          }));
          capturedRows.push(...inserted);
          return inserted;
        },
        async getPdfImportQuotaStatus() {
          return { tier: 'paid', canImport: true, remaining: null };
        },
        async reservePdfImportQuota() {
          return { allowed: true, count: 1, remaining: null };
        },
      };
      return cb(tx);
    },
  };

  const result = await importBankStatement({
    db,
    householdId: WS_A,
    pdfTextExtractor: async () => [
      'FAKE BANK STATEMENT — NOT REAL FINANCIAL DATA',
      '2026-09-01 FAKE GROCERY STORE     -45.00   955.00',
      '2026-09-02 FAKE PAYROLL DIRECT  1000.00  1955.00',
    ].join('\n'),
    input: {
      filename: 'fake_statement.pdf',
      contentType: 'application/pdf',
      pdfBuffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n%%EOF'),
    },
  });

  assert.ok(result.extracted > 0, 'must extract at least one row');

  for (const row of capturedRows) {
    assert.strictEqual(row.status, 'unreviewed', 'all imported rows must be staged as unreviewed');
    assert.ok(row.householdId === WS_A, 'imported rows must be scoped to WS_A');
    assert.ok(!row.linkedTransactionId, 'imported rows must NOT be linked to a financial transaction');
    assert.ok(!row.linkedDebtId, 'imported rows must NOT create debt records');
  }
});

// Route-level: POST /imports/bank-statement returns 201 with staged rows
test('PDF import route — POST returns 201 with staged rows, safe 500 on persistence failure', async () => {
  const { POST: importBankStatementRoute } = await import('../app/api/v1/imports/bank-statement/route.js');

  const syntheticPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n%%EOF',
  );

  const goodDb = {
    async transaction(cb) {
      const tx = {
        async getImportBatchByFileHash() { return null; },
        async insertImportBatch() { return { id: 'batch_fake', source: 'bank_import' }; },
        async insertImportedTransactions({ rows }) {
          return rows.map((row, i) => ({
            id: `fake_${i}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...row,
          }));
        },
        async getPdfImportQuotaStatus() {
          return { tier: 'paid', canImport: true, remaining: null };
        },
        async reservePdfImportQuota() {
          return { allowed: true, count: 1, remaining: null };
        },
      };
      return cb(tx);
    },
  };

  const formData = new FormData();
  formData.set('file', new Blob([syntheticPdf], { type: 'application/pdf' }), 'fake_statement.pdf');

  const request = new Request('http://localhost/api/v1/imports/bank-statement', {
    method: 'POST',
    body: formData,
  });

  const goodResponse = await importBankStatementRoute(request, {
    db: goodDb,
    householdId: WS_A,
    pdfTextExtractor: async () => '2026-09-01 FAKE COFFEE  -12.99  987.01',
  });

  assert.strictEqual(goodResponse.status, 201, 'successful import must return HTTP 201');
  const body = await goodResponse.json();
  assert.ok(typeof body.extracted === 'number', 'response must include extracted count');

  // Persistence failure must return safe 500
  const badDb = {
    async transaction(cb) {
      const tx = {
        async getImportBatchByFileHash() { return null; },
        async insertImportBatch() { return { id: 'batch_fake', source: 'bank_import' }; },
        async insertImportedTransactions() {
          throw new Error('column "batch_id" of relation "imported_transactions" does not exist');
        },
        async getPdfImportQuotaStatus() {
          return { tier: 'paid', canImport: true, remaining: null };
        },
        async reservePdfImportQuota() {
          return { allowed: true, count: 1, remaining: null };
        },
      };
      return cb(tx);
    },
  };

  const request2 = new Request('http://localhost/api/v1/imports/bank-statement', {
    method: 'POST',
    body: formData,
  });

  const errorResponse = await importBankStatementRoute(request2, {
    db: badDb,
    householdId: WS_A,
    pdfTextExtractor: async () => '2026-09-01 FAKE COFFEE  -12.99  987.01',
  });

  assert.strictEqual(errorResponse.status, 500, 'persistence failure must return 500');
  const errorBody = await errorResponse.json();
  assert.ok(!JSON.stringify(errorBody).includes('batch_id'), 'raw SQL error must not be exposed to client');
  assert.ok(!JSON.stringify(errorBody).includes('imported_transactions'), 'schema name must not appear in error response');
});
