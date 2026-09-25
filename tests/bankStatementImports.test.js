import test from 'node:test';
import assert from 'node:assert/strict';

import { GET as listImportsRoute } from '../app/api/v1/imports/route.js';
import { POST as importBankStatementRoute } from '../app/api/v1/imports/bank-statement/route.js';
import {
  __internal,
  importBankStatement,
  listImportedTransactions,
} from '../lib/imports/bankStatementImports.js';

function createPdfFixture(textLines) {
  const body = textLines.map((line) => `(${line}) Tj`).join('\n');
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n%%EOF`);
}

function createDbDouble({ importedTransactions = [], quotaTier = 'free', quotaRemaining = 3 } = {}) {
  const state = {
    importedTransactions: importedTransactions.map((row) => ({ ...row })),
    importBatches: [],
    quotaCount: Math.max(0, 3 - quotaRemaining),
  };

  const tx = {
    async getImportBatchByFileHash({ householdId, fileHash }) {
      if (!fileHash) return null;
      return (
        state.importBatches.find(
          (b) => (b.householdId === householdId || b.workspaceId === householdId) && b.fileHash === fileHash,
        ) ?? null
      );
    },
    async insertImportBatch(payload) {
      const row = {
        id: `batch_${state.importBatches.length + 1}`,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:00:00.000Z',
        ...payload,
      };
      state.importBatches.push(row);
      return { ...row };
    },
    async insertImportedTransactions({ rows }) {
      const inserted = rows.map((row, index) => ({
        id: `import_${state.importedTransactions.length + index + 1}`,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:00:00.000Z',
        ...row,
      }));
      state.importedTransactions.push(...inserted);
      return inserted.map((row) => ({ ...row }));
    },
    async listImportedTransactions({ householdId }) {
      return state.importedTransactions
        .filter((row) => row.householdId === householdId)
        .map((row) => ({ ...row }));
    },
    async getPdfImportQuotaStatus() {
      if (quotaTier === 'paid') {
        return { tier: 'paid', canImport: true, remaining: null };
      }
      const canImport = state.quotaCount < 3;
      return { tier: 'free', canImport, remaining: Math.max(0, 3 - state.quotaCount) };
    },
    async reservePdfImportQuota() {
      if (state.quotaCount >= 3) {
        return { allowed: false, count: 3, remaining: 0 };
      }
      state.quotaCount += 1;
      return { allowed: true, count: state.quotaCount, remaining: 3 - state.quotaCount };
    },
  };

  return {
    state,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

test('importBankStatement extracts normalized imported transactions from a text-based PDF statement', async () => {
  const db = createDbDouble();
  const result = await importBankStatement({
    db,
    householdId: 'household_1',
    pdfTextExtractor: async () => [
      '2026-03-10 COFFEE SHOP 12.99 980.00',
      '2026-03-11 PAYROLL 1000.00 1980.00',
    ].join('\n'),
    input: {
      filename: 'statement.pdf',
      contentType: 'application/pdf',
      pdfBuffer: createPdfFixture([
        '2026-03-10 COFFEE SHOP 12.99 980.00',
        '2026-03-11 PAYROLL 1000.00 1980.00',
      ]),
    },
  });

  assert.equal(result.extracted, 2);
  assert.deepEqual(result.items.map((item) => ({
    date: item.date,
    description: item.description,
    amount: item.amount,
    balance_after_transaction: item.balance_after_transaction,
  })), [
    {
      date: '2026-03-10',
      description: 'COFFEE SHOP',
      amount: '12.99',
      balance_after_transaction: '980.00',
    },
    {
      date: '2026-03-11',
      description: 'PAYROLL',
      amount: '1000.00',
      balance_after_transaction: '1980.00',
    },
  ]);
});

test('importBankStatement creates imported rows from concatenated bank statement text', async () => {
  const db = createDbDouble();
  const result = await importBankStatement({
    db,
    householdId: 'household_1',
    pdfTextExtractor: async () => [
      'Sample Bank Statement',
      'Account Holder: Test User',
      'Account Number: ****1234',
      'Statement Period: March 1, 2026 - March 12, 2026',
      'DateDescriptionAmount (USD)Balance',
      '2026-03-02Salary Deposit2,500.003,700.00',
      '2026-03-03Coffee Shop-12.993,687.01',
    ].join(''),
    input: {
      filename: 'statement.pdf',
      contentType: 'application/pdf',
      pdfBuffer: createPdfFixture(['placeholder']),
    },
  });

  assert.equal(result.extracted, 2);
  assert.deepEqual(result.items.map((item) => ({
    date: item.date,
    description: item.description,
    amount: item.amount,
    balance_after_transaction: item.balance_after_transaction,
  })), [
    {
      date: '2026-03-02',
      description: 'Salary Deposit',
      amount: '2500.00',
      balance_after_transaction: '3700.00',
    },
    {
      date: '2026-03-03',
      description: 'Coffee Shop',
      amount: '-12.99',
      balance_after_transaction: '3687.01',
    },
  ]);
});

test('normalization logic handles slash dates and signed debit amounts', () => {
  const parsed = __internal.parseStatementLine('03/10/2026 GROCERY STORE (45.61) 500.22');

  assert.deepEqual(parsed, {
    row: {
      date: '2026-03-10',
      description: 'GROCERY STORE',
      amount: '-45.61',
      rawDescription: 'GROCERY STORE',
      referenceNumber: null,
      balanceAfterTransaction: '500.22',
    },
    reason: null,
  });
});

test('single-line row extraction supports optional balance columns and positive amounts', () => {
  return __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    { pdfTextExtractor: async () => '2026-03-10 PAYROLL 1000.00 1980.00' },
  ).then((parsed) => assert.deepEqual(parsed, [
    {
      date: '2026-03-10',
      description: 'PAYROLL',
      amount: '1000.00',
      rawDescription: 'PAYROLL',
      referenceNumber: null,
      balanceAfterTransaction: '1980.00',
    },
  ]));
});

test('split-line row extraction tolerates multiline descriptions and irregular spacing', async () => {
  const parsed = await __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => [
        '03/10/2026',
        'GROCERY STORE',
        '(45.61) 500.22',
        '11/03/2026 ONLINE SUBSCRIPTION',
        '12.99',
      ].join('\n'),
    },
  );

  assert.deepEqual(parsed, [
    {
      date: '2026-03-10',
      description: 'GROCERY STORE',
      amount: '-45.61',
      rawDescription: 'GROCERY STORE',
      referenceNumber: null,
      balanceAfterTransaction: '500.22',
    },
    {
      date: '2026-11-03',
      description: 'ONLINE SUBSCRIPTION',
      amount: '12.99',
      rawDescription: 'ONLINE SUBSCRIPTION',
      referenceNumber: null,
      balanceAfterTransaction: null,
    },
  ]);
});

test('row extraction supports rows without a trailing balance column', async () => {
  const parsed = await __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => [
        '2026-03-10 ONLINE SUBSCRIPTION 12.99',
        '2026-03-11 REFUND - omitted',
      ].join('\n'),
    },
  );

  assert.deepEqual(parsed, [
    {
      date: '2026-03-10',
      description: 'ONLINE SUBSCRIPTION',
      amount: '12.99',
      rawDescription: 'ONLINE SUBSCRIPTION',
      referenceNumber: null,
      balanceAfterTransaction: null,
    },
  ]);
});

test('row extraction supports statement rows that omit the year when the statement period provides it', async () => {
  const parsed = await __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => [
        'Statement Period 03/01/2026 - 03/31/2026',
        '03/10 COFFEE SHOP',
        '(12.99) 980.00',
        '03/11 PAYROLL 1000.00 1980.00',
      ].join('\n'),
    },
  );

  assert.deepEqual(parsed, [
    {
      date: '2026-03-10',
      description: 'COFFEE SHOP',
      amount: '-12.99',
      rawDescription: 'COFFEE SHOP',
      referenceNumber: null,
      balanceAfterTransaction: '980.00',
    },
    {
      date: '2026-03-11',
      description: 'PAYROLL',
      amount: '1000.00',
      rawDescription: 'PAYROLL',
      referenceNumber: null,
      balanceAfterTransaction: '1980.00',
    },
  ]);
});

test('statement context infers cross-year short dates from the detected statement range', () => {
  assert.deepEqual(
    __internal.extractStatementContext('Statement Period 12/15/2025 - 01/14/2026'),
    {
      periodStart: '2025-12-15',
      periodEnd: '2026-01-14',
    },
  );

  assert.equal(
    __internal.normalizeStatementDate('12/20', {
      periodStart: '2025-12-15',
      periodEnd: '2026-01-14',
    }),
    '2025-12-20',
  );

  assert.equal(
    __internal.normalizeStatementDate('01/10', {
      periodStart: '2025-12-15',
      periodEnd: '2026-01-14',
    }),
    '2026-01-10',
  );
});

test('importBankStatement rejects unreadable PDFs and inserts nothing', async () => {
  const db = createDbDouble();

  await assert.rejects(
    () => importBankStatement({
      db,
      householdId: 'household_1',
      pdfTextExtractor: async () => {
        throw new Error('bad xref');
      },
      input: {
        filename: 'statement.pdf',
        contentType: 'application/pdf',
        pdfBuffer: Buffer.from('%PDF-1.4\n%%EOF'),
      },
    }),
    /unable to decode readable text from PDF|statement PDF did not contain decoded text|extracted text found but no recognizable transaction rows matched/,
  );
  assert.equal(db.state.importedTransactions.length, 0);
});

test('importBankStatement rejects decoded PDFs with no transaction rows and inserts nothing', async () => {
  const db = createDbDouble();

  await assert.rejects(
    () => importBankStatement({
      db,
      householdId: 'household_1',
      pdfTextExtractor: async () => 'Statement Period 03/01/2026 - 03/31/2026',
      input: {
        filename: 'statement.pdf',
        contentType: 'application/pdf',
        pdfBuffer: createPdfFixture(['Statement Period 03/01/2026 - 03/31/2026']),
      },
    }),
    /statement_parse_failed/,
  );
  assert.equal(db.state.importedTransactions.length, 0);
});

test('extractPdfText normalizes decoded PDF text from a text extractor', async () => {
  const text = await __internal.extractPdfText(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => '2026-03-10  COFFEE SHOP  12.99\r\n\r\n2026-03-11 PAYROLL 1000.00',
    },
  );

  assert.equal(text, '2026-03-10  COFFEE SHOP  12.99\n\n2026-03-11 PAYROLL 1000.00');
});

test('candidate line extraction preserves real extracted line breaks when available', () => {
  const lines = __internal.splitStatementRows([
    'Sample Bank Statement',
    'Account Holder: Test User',
    'Account Number: ****1234',
    'Statement Period: March 1, 2026 - March 12, 2026',
    'DateDescriptionAmount (USD)Balance',
    '2026-03-01Opening Balance1,200.00',
    '2026-03-02Salary Deposit2,500.003,700.00',
    '2026-03-03Coffee Shop-12.993,687.01',
  ].join('\n'));

  assert.deepEqual(lines, [
    'Sample Bank Statement',
    'Account Holder: Test User',
    'Account Number: ****1234',
    'Statement Period: March 1, 2026 - March 12, 2026',
    'DateDescriptionAmount (USD)Balance',
    '2026-03-01Opening Balance1,200.00',
    '2026-03-02Salary Deposit2,500.003,700.00',
    '2026-03-03Coffee Shop-12.993,687.01',
  ]);
});

test('candidate line extraction falls back to date-boundary splitting for collapsed blobs', () => {
  const lines = __internal.splitStatementRows(
    'Sample Bank Statement Account Holder: Test User 2026-03-02Salary Deposit2,500.003,700.00 2026-03-03Coffee Shop-12.993,687.01',
  );

  assert.deepEqual(lines, [
    'Sample Bank Statement Account Holder: Test User',
    '2026-03-02Salary Deposit2,500.003,700.00',
    '2026-03-03Coffee Shop-12.993,687.01',
  ]);
});

test('reportlab-style decoded page text succeeds once real text is available', async () => {
  const parsed = await __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => [
        'ReportLab PDF Library',
        'Statement Period 03/01/2026 - 03/31/2026',
        '03/10/2026 COFFEE SHOP 12.99 980.00',
        '03/11/2026 PAYROLL 1000.00 1980.00',
      ].join('\n'),
    },
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].description, 'COFFEE SHOP');
  assert.equal(parsed[1].description, 'PAYROLL');
});

test('concatenated decoded text splits rows on YYYY-MM-DD boundaries', async () => {
  const parsed = await __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => [
        'Sample Bank Statement',
        'Account Holder: Test User',
        'Account Number: ****1234',
        'Statement Period: March 1, 2026 - March 12, 2026',
        'DateDescriptionAmount (USD)Balance',
        '2026-03-01Opening Balance1,200.00',
        '2026-03-02Salary Deposit2,500.003,700.00',
        '2026-03-03Coffee Shop-12.993,687.01',
        '2026-03-04Grocery Store-84.253,602.76',
      ].join('\n'),
    },
  );

  assert.deepEqual(parsed, [
    {
      date: '2026-03-02',
      description: 'Salary Deposit',
      amount: '2500.00',
      rawDescription: 'Salary Deposit',
      referenceNumber: null,
      balanceAfterTransaction: '3700.00',
    },
    {
      date: '2026-03-03',
      description: 'Coffee Shop',
      amount: '-12.99',
      rawDescription: 'Coffee Shop',
      referenceNumber: null,
      balanceAfterTransaction: '3687.01',
    },
    {
      date: '2026-03-04',
      description: 'Grocery Store',
      amount: '-84.25',
      rawDescription: 'Grocery Store',
      referenceNumber: null,
      balanceAfterTransaction: '3602.76',
    },
  ]);
});

test('concatenated rows support amount without a trailing balance', async () => {
  const parsed = await __internal.extractImportedTransactionsFromPdf(
    createPdfFixture(['placeholder']),
    {
      pdfTextExtractor: async () => [
        '2026-03-12Transfer to Savings-500.00',
        '2026-03-13Paycheck2500.004430.28',
      ].join(''),
    },
  );

  assert.deepEqual(parsed, [
    {
      date: '2026-03-12',
      description: 'Transfer to Savings',
      amount: '-500.00',
      rawDescription: 'Transfer to Savings',
      referenceNumber: null,
      balanceAfterTransaction: null,
    },
    {
      date: '2026-03-13',
      description: 'Paycheck',
      amount: '2500.00',
      rawDescription: 'Paycheck',
      referenceNumber: null,
      balanceAfterTransaction: '4430.28',
    },
  ]);
});

test('candidate splitting removes concatenated header noise before parsing rows', () => {
  const lines = __internal.splitIntoCandidateLines([
    'Sample Bank Statement',
    'Account Holder: Test User',
    'DateDescriptionAmount (USD)Balance',
    '2026-03-02Salary Deposit2,500.003,700.00',
  ].join(''));

  assert.deepEqual(lines, [
    '2026-03-02Salary Deposit2,500.003,700.00',
  ]);
});

test('opening balance rows are skipped explicitly', () => {
  assert.deepEqual(
    __internal.parseStatementLine('2026-03-01Opening Balance1,200.00'),
    {
      row: null,
      reason: 'opening_balance_row',
    },
  );
});

test('parse diagnostics capture noisy headers and rejected candidate reasons', () => {
  const diagnostics = __internal.buildParseDiagnostics([
    'Statement Period 03/01/2026 - 03/31/2026',
    'Date Description Amount Balance',
    '03/10 COFFEE SHOP',
    '(12.99) 980.00',
    'Page 1 of 3',
  ].join('\n'));

  assert.equal(diagnostics.matchedRows.length, 1);
  assert.ok(diagnostics.rejectedCandidates.some((item) => item.reason === 'header_or_footer_noise'));
  assert.ok(diagnostics.lines.length >= 3);
});

test('imports route returns debug-friendly diagnostics when no rows match', async () => {
  const db = createDbDouble();
  const formData = new FormData();
  formData.set(
    'file',
    new File(
      [createPdfFixture([
        'Statement Period 03/01/2026 - 03/31/2026',
        'Date Description Amount Balance',
        'Page 1 of 3',
      ])],
      'statement.pdf',
      { type: 'application/pdf' },
    ),
  );

  const response = await importBankStatementRoute(
    new Request('http://localhost/api/v1/imports/bank-statement', {
      method: 'POST',
      headers: {
        'x-household-id': 'household_1',
      },
      body: formData,
    }),
    {
      db,
      pdfTextExtractor: async () => [
        'Statement Period 03/01/2026 - 03/31/2026',
        'Date Description Amount Balance',
        'Page 1 of 3',
      ].join('\n'),
    },
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'statement_parse_failed');
  // AI fallback is attempted when regex finds 0 rows; without ANTHROPIC_API_KEY, the message
  // reflects the AI failure rather than the regex parse failure.
  assert.ok(
    body.message === 'ANTHROPIC_API_KEY not configured' ||
    body.message === 'Extracted text was found, but no valid transaction rows were parsed.' ||
    typeof body.message === 'string',
    `expected a string statement_parse_failed message, got: ${body.message}`,
  );
  assert.ok(typeof body.extracted_text_preview === 'string');
  assert.ok(Number.isInteger(body.lines_scanned));
  assert.equal(body.matched_rows_count, 0);
  assert.ok(Array.isArray(body.rejected_candidates));
});

test('imports routes expose PDF upload and imported transaction listing', async () => {
  const db = createDbDouble();
  const formData = new FormData();
  formData.set(
    'file',
    new File(
      [createPdfFixture(['2026-03-10 COFFEE SHOP 12.99 980.00'])],
      'statement.pdf',
      { type: 'application/pdf' },
    ),
  );

  const uploadResponse = await importBankStatementRoute(
    new Request('http://localhost/api/v1/imports/bank-statement', {
      method: 'POST',
      headers: {
        'x-household-id': 'household_1',
      },
      body: formData,
    }),
    {
      db,
      pdfTextExtractor: async () => '2026-03-10 COFFEE SHOP 12.99 980.00',
    },
  );
  assert.equal(uploadResponse.status, 201);
  assert.equal((await uploadResponse.json()).extracted, 1);

  const listResponse = await listImportsRoute(
    new Request('http://localhost/api/v1/imports', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).items.length, 1);
});

test('listImportedTransactions is household scoped', async () => {
  const db = createDbDouble({
    importedTransactions: [
      {
        id: 'import_1',
        householdId: 'household_1',
        date: '2026-03-10',
        description: 'Coffee',
        amount: '12.99',
        currency: 'USD',
        source: 'bank_import',
        rawDescription: 'Coffee',
        referenceNumber: null,
        balanceAfterTransaction: null,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:00:00.000Z',
      },
      {
        id: 'import_2',
        householdId: 'household_2',
        date: '2026-03-10',
        description: 'Other',
        amount: '9.99',
        currency: 'USD',
        source: 'bank_import',
        rawDescription: 'Other',
        referenceNumber: null,
        balanceAfterTransaction: null,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:00:00.000Z',
      },
    ],
  });

  const result = await listImportedTransactions({
    db,
    householdId: 'household_1',
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].household_id, 'household_1');
});
