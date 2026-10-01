import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { POST as bankStatementRoute } from '../app/api/v1/imports/bank-statement/route.js';
import { parseWithAI } from '../lib/imports/aiPdfParser.js';
import { approveImportBatch } from '../lib/imports/approveImportBatch.js';
import { importBankStatement } from '../lib/imports/bankStatementImports.js';
import { parseImportBatch } from '../lib/imports/parseImportBatch.js';
import { classifyImportedTransaction, unprocessImportedTransaction } from '../lib/imports/reviewImportedTransactions.js';
import { MAX_FUTURE_DAYS, validateStatementRows } from '../lib/imports/statementRowValidation.js';
import { assignEventOrdinals, buildEventKey, normalizeIdentityText } from '../lib/imports/transactionIdentity.js';
import { updateImportedRow } from '../lib/imports/updateImportedRow.js';
import { uploadImportBatch } from '../lib/imports/uploadImportBatch.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { createSqliteDb } from '../lib/server/sqliteDb.js';
import { createTransaction, deleteTransaction } from '../lib/transactions/createTransaction.js';

const WS = 'household_1';
const OTHER_WS = 'household_other';

const BOOK = '2026-01-20 BOOKSTORE -30.00 965.00';
const COFFEE = '2026-01-15 COFFEE SHOP -5.00 995.00';
const COFFEE_2 = '2026-01-15 COFFEE SHOP -5.00 990.00';
const RENT = '2026-02-01 RENT -900.00 65.00';

const COLUMN_MAP = { columnMap: { date: 'Date', description: 'Description', amount: 'Amount', direction: 'Direction' } };

function pdf(lines, salt = 'x') {
  return {
    filename: `stmt-${salt}.pdf`,
    contentType: 'application/pdf',
    pdfBuffer: Buffer.from(`%PDF-1.4\n${salt}\n${lines.join('\n')}\n%%EOF`),
  };
}

const extractor = (lines) => async () => lines.join('\n');

function importPdf(db, lines, salt, { accountId = null, householdId = WS, aiParser } = {}) {
  return importBankStatement({
    db,
    householdId,
    pdfTextExtractor: extractor(lines),
    aiParser,
    input: { ...pdf(lines, salt), accountId },
  });
}

async function categoryId(db, householdId = WS) {
  return db.transaction(async (tx) => (await tx.listAllocationCategories({ householdId }))[0].id);
}

async function addAccount(db, householdId, name) {
  return db.transaction(async (tx) => (await tx.insertFinancialAccount({
    householdId, name, accountType: 'checking', currentBalance: '0.00', isActive: true,
  })).id);
}

async function allTransactions(db, householdId = WS) {
  return db.transaction(async (tx) => {
    const result = await tx.listTransactions({ householdId, from: '0001-01-01', to: '9999-12-31', limit: 1000 });
    return result.items ?? result;
  });
}

function classify(db, rowId, input = {}, householdId = WS) {
  return categoryId(db, householdId).then((category) => classifyImportedTransaction({
    db,
    householdId,
    importedTransactionId: rowId,
    input: { classification_type: 'transaction', category_id: category, ...input },
  }));
}

const errorCode = (error) => error?.details?.errorCode;

function withQuota(db, counters, tier = 'free') {
  return {
    ...db,
    transaction: (callback) => db.transaction((tx) => callback({
      ...tx,
      getPdfImportQuotaStatus: async () => ({ tier, canImport: true, remaining: 3 }),
      reservePdfImportQuota: async () => { counters.reserved += 1; return { allowed: true }; },
      incrementPdfImportQuota: async () => { counters.recorded += 1; },
    })),
  };
}

async function runCsv(db, text, { accountId = null, approve = true } = {}) {
  const batch = await uploadImportBatch({ db, householdId: WS, input: { filename: 'x.csv', text, accountId } });
  const parsed = await parseImportBatch({ db, householdId: WS, batchId: batch.batchId, input: COLUMN_MAP });
  if (!approve) return { batch, parsed };
  const category = await categoryId(db);
  for (const row of parsed.rows) {
    if (row.status === 'pending') {
      await updateImportedRow({ db, householdId: WS, rowId: row.id, input: { status: 'approved', categoryId: category } });
    }
  }
  return { batch, parsed, approved: await approveImportBatch({ db, householdId: WS, batchId: batch.batchId }) };
}

// ── identity primitives ────────────────────────────────────────────────────────

test('identity: key ignores case/punctuation, separates date/amount/description, ordinals count occurrences', () => {
  const base = { date: '2026-01-20', signedCents: -3000, description: 'BOOKSTORE #12' };
  assert.equal(normalizeIdentityText('  Book-Store #12 '), 'book store 12');
  assert.equal(buildEventKey(base), buildEventKey({ ...base, description: 'bookstore 12' }));
  assert.notEqual(buildEventKey(base), buildEventKey({ ...base, date: '2026-01-21' }));
  assert.notEqual(buildEventKey(base), buildEventKey({ ...base, signedCents: -3001 }));
  assert.notEqual(buildEventKey(base), buildEventKey({ ...base, signedCents: 3000 }), 'debit and credit are different events');
  assert.deepEqual(assignEventOrdinals(['a', 'b', 'a', 'a', 'b']), [1, 1, 2, 3, 2]);
});

// ── statement row validation ───────────────────────────────────────────────────

test('validation: rejects impossible dates, bad amounts, empty descriptions, out-of-range values, and keeps good rows', () => {
  const today = new Date('2026-10-01T00:00:00Z');
  const future = new Date(today.getTime() + (MAX_FUTURE_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
  const { valid, rejected } = validateStatementRows([
    { date: '2026-01-15', description: 'Coffee', amount: '-5.00' },
    { date: '2026-02-30', description: 'Impossible date', amount: '-5.00' },
    { date: '2026-01-15', description: 'Bad amount', amount: 'abc' },
    { date: '2026-01-15', description: 'Zero', amount: '0.00' },
    { date: '2026-01-15', description: '   ', amount: '-5.00' },
    { date: '1980-01-01', description: 'Too old', amount: '-5.00' },
    { date: future, description: 'Far future', amount: '-5.00' },
    { date: '2026-01-15', description: 'Huge', amount: '99999999999.00' },
    { date: '2026-01-15', description: 'Three decimals', amount: '-5.001' },
    { date: '2026-01-15', description: 'Dollar sign and commas', amount: '$1,234.56' },
    { date: '2026-01-15', description: 'Parenthesised debit', amount: '(5.00)' },
    null,
    'a string',
  ], { today });

  assert.deepEqual(valid.map((item) => item.row.description), ['Coffee', 'Dollar sign and commas', 'Parenthesised debit']);
  assert.equal(valid[1].row.amount, '1234.56');
  assert.equal(valid[2].row.amount, '-5.00');
  const reasons = Object.fromEntries(rejected.map((item) => [item.index, item.reasons]));
  assert.deepEqual(reasons[1], ['invalid_date']);
  assert.deepEqual(reasons[2], ['invalid_amount']);
  assert.deepEqual(reasons[3], ['invalid_amount']);
  assert.deepEqual(reasons[4], ['missing_description']);
  assert.deepEqual(reasons[5], ['date_out_of_range']);
  assert.deepEqual(reasons[6], ['date_out_of_range']);
  assert.deepEqual(reasons[7], ['amount_out_of_range']);
  assert.deepEqual(reasons[8], ['invalid_amount']);
  assert.deepEqual(reasons[11], ['row_not_an_object']);
  assert.deepEqual(reasons[12], ['row_not_an_object']);
});

// ── AI parser response handling ─────────────────────────────────────────────────

function fakeClient(response) {
  return { messages: { create: async () => response } };
}

test('AI parser: tolerates fenced JSON, never lets one bad item abort the response, surfaces truncation and bad shapes', async () => {
  const items = [
    { date: '2026-01-15', description: 'Coffee', amount: '-5.00', raw_description: 'COFFEE SHOP 123' },
    null,
    { date: 20260115, description: 'Numeric date', amount: -3 },
  ];

  const fenced = await parseWithAI('text', {
    client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(items)}\n\`\`\`` }] }),
  });
  assert.equal(fenced.error, null);
  assert.equal(fenced.rows.length, 3);
  assert.equal(fenced.rows[0].rawDescription, 'COFFEE SHOP 123');
  assert.equal(fenced.rows[1], null);
  assert.equal(fenced.model.length > 0, true);

  const truncated = await parseWithAI('text', { client: fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '[{"date"' }] }) });
  assert.equal(truncated.rows, null);
  assert.match(truncated.error, /truncated/);

  const notArray = await parseWithAI('text', { client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rows":[]}' }] }) });
  assert.equal(notArray.rows, null);
  assert.match(notArray.error, /not a JSON array/);

  const notJson = await parseWithAI('text', { client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, I cannot do that.' }] }) });
  assert.equal(notJson.rows, null);
  assert.match(notJson.error, /not valid JSON/);

  const noContent = await parseWithAI('text', { client: fakeClient({ stop_reason: 'end_turn', content: [] }) });
  assert.equal(noContent.rows, null);

  const noKey = await parseWithAI('text', {});
  assert.match(noKey.error, /ANTHROPIC_API_KEY/);
});

// ── 1. exact same PDF twice ────────────────────────────────────────────────────

test('matrix 1: the same PDF twice is rejected and adds nothing', async () => {
  const db = createInMemoryDb();
  await importPdf(db, [COFFEE, BOOK], 'same');
  await assert.rejects(importPdf(db, [COFFEE, BOOK], 'same'), (error) => error.status === 409);
  const staged = await db.transaction((tx) => tx.listImportedTransactions({ householdId: WS }));
  assert.equal(staged.length, 2);
});

// ── 2. different PDFs, overlapping transactions ────────────────────────────────

test('matrix 2a: overlapping statements with no account — the overlap needs explicit resolution, never silently duplicates', async () => {
  const db = createInMemoryDb();
  const a = await importPdf(db, [COFFEE, BOOK], 'A');
  const b = await importPdf(db, [BOOK, RENT], 'B');
  for (const item of a.items) await classify(db, item.id);

  const overlap = b.items.find((item) => /BOOKSTORE/.test(item.description));
  await assert.rejects(classify(db, overlap.id), (error) => error.status === 409 && errorCode(error) === 'IMPORT_POSSIBLE_DUPLICATE');
  assert.equal((await allTransactions(db)).length, 2, 'nothing was created while unresolved');

  const unrelated = b.items.find((item) => /RENT/.test(item.description));
  await classify(db, unrelated.id);
  assert.equal((await allTransactions(db)).length, 3, 'non-overlapping rows import normally');

  await classifyImportedTransaction({
    db, householdId: WS, importedTransactionId: overlap.id, input: { classification_type: 'duplicate' },
  });
  assert.equal((await allTransactions(db)).length, 3, 'classifying the overlap as a duplicate adds no transaction');
});

test('matrix 2b: overlapping statements on a known account — deterministic exact duplicate that cannot be overridden', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const a = await importPdf(db, [COFFEE, BOOK], 'A', { accountId });
  for (const item of a.items) await classify(db, item.id);

  const b = await importPdf(db, [BOOK, RENT], 'B', { accountId });
  const overlap = b.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal(overlap.duplicate_state, 'exact');
  assert.equal(b.duplicates.exact, 1);

  await assert.rejects(classify(db, overlap.id), (error) => errorCode(error) === 'IMPORT_EXACT_DUPLICATE');
  await assert.rejects(classify(db, overlap.id, { confirm_distinct: true }), (error) => errorCode(error) === 'IMPORT_EXACT_DUPLICATE');
  assert.equal((await allTransactions(db)).filter((t) => /BOOKSTORE/.test(t.description)).length, 1);
});

test('matrix 2c: the user can explicitly confirm a likely duplicate is a separate event', async () => {
  const db = createInMemoryDb();
  const a = await importPdf(db, [BOOK], 'A');
  await classify(db, a.items[0].id);
  const b = await importPdf(db, [BOOK, RENT], 'B');
  const overlap = b.items.find((item) => /BOOKSTORE/.test(item.description));

  await classify(db, overlap.id, { confirm_distinct: true });
  assert.equal((await allTransactions(db)).filter((t) => /BOOKSTORE/.test(t.description)).length, 2, 'explicit confirmation is honoured');
});

// ── 3. CSV / PDF overlap ───────────────────────────────────────────────────────

test('matrix 3a: PDF-created transaction is recognised when the same event arrives by CSV', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const a = await importPdf(db, [BOOK], 'A', { accountId });
  await classify(db, a.items[0].id);

  const csv = await runCsv(db, 'Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit', { accountId });
  assert.equal(csv.parsed.rows[0].status, 'duplicate');
  assert.equal(csv.approved.inserted, 0);
  assert.equal((await allTransactions(db)).length, 1);
});

test('matrix 3b: CSV-created transaction is recognised when the same event arrives by PDF', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  await runCsv(db, 'Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit', { accountId });

  const b = await importPdf(db, [BOOK], 'B', { accountId });
  assert.equal(b.items[0].duplicate_state, 'exact');
  await assert.rejects(classify(db, b.items[0].id), (error) => errorCode(error) === 'IMPORT_EXACT_DUPLICATE');
  assert.equal((await allTransactions(db)).length, 1);
});

test('matrix 3c: same event across PDF and CSV with different wording is flagged for explicit review', async () => {
  const db = createInMemoryDb();
  const a = await importPdf(db, ['2026-01-20 BOOKSTORE TORONTO ON -30.00 965.00'], 'A');
  await classify(db, a.items[0].id);

  const csv = await runCsv(db, 'Date,Description,Amount,Direction\n2026-01-20,Bookstore,30.00,debit', { approve: false });
  assert.equal(csv.parsed.rows[0].status, 'duplicate', 'flagged although the text differs');
});

// ── 4. legitimate identical purchases ──────────────────────────────────────────

test('matrix 4a: two identical purchases in one PDF both import', async () => {
  const db = createInMemoryDb();
  const a = await importPdf(db, [COFFEE, COFFEE_2], 'A');
  assert.deepEqual(a.items.map((item) => item.duplicate_state), ['none', 'none']);
  for (const item of a.items) await classify(db, item.id);
  assert.equal((await allTransactions(db)).length, 2);
});

test('matrix 4b: two identical purchases in one CSV both import, even with the same category', async () => {
  const db = createInMemoryDb();
  const result = await runCsv(db, 'Date,Description,Amount,Direction\n2026-01-15,COFFEE SHOP,5.00,debit\n2026-01-15,COFFEE SHOP,5.00,debit');
  assert.equal(result.approved.inserted, 2);
  assert.equal(result.approved.skipped, 0);
  assert.equal((await allTransactions(db)).length, 2);
});

test('matrix 4c: re-exporting both identical purchases maps one-to-one onto what exists', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const a = await importPdf(db, [COFFEE, COFFEE_2], 'A', { accountId });
  for (const item of a.items) await classify(db, item.id);

  const b = await importPdf(db, [COFFEE, COFFEE_2, RENT], 'B', { accountId });
  const coffees = b.items.filter((item) => /COFFEE/.test(item.description));
  assert.deepEqual(coffees.map((item) => item.duplicate_state), ['exact', 'exact']);
  assert.equal((await allTransactions(db)).length, 2);
});

test('matrix 4d: a later export that adds a second identical purchase keeps the genuinely new one', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const a = await importPdf(db, [COFFEE], 'A', { accountId });
  await classify(db, a.items[0].id);

  const b = await importPdf(db, [COFFEE, COFFEE_2], 'B', { accountId });
  const [first, second] = b.items;
  assert.equal(first.duplicate_state, 'exact', 'occurrence 1 already exists');
  await assert.rejects(classify(db, first.id), (error) => errorCode(error) === 'IMPORT_EXACT_DUPLICATE');
  assert.notEqual(second.duplicate_state, 'exact', 'occurrence 2 is a new event');
  await classify(db, second.id, { confirm_distinct: true });
  assert.equal((await allTransactions(db)).length, 2);
});

// ── 5. manual transaction + imported equivalent ────────────────────────────────

test('matrix 5: an imported row matching a manual transaction requires explicit resolution; manual data is never modified', async () => {
  const db = createInMemoryDb();
  const category = await categoryId(db);
  const manual = await createTransaction({
    db, householdId: WS, userId: 'u1',
    input: { transactionDate: '2026-01-20', description: 'Bookstore', amount: '30.00', direction: 'debit', categoryId: category },
  });
  const before = JSON.stringify((await allTransactions(db))[0]);

  const imported = await importPdf(db, [BOOK], 'A');
  assert.equal(imported.items[0].duplicate_state, 'likely');
  assert.equal(imported.items[0].duplicate_matches[0].id, manual.id);
  await assert.rejects(classify(db, imported.items[0].id), (error) => errorCode(error) === 'IMPORT_POSSIBLE_DUPLICATE');

  await classifyImportedTransaction({
    db, householdId: WS, importedTransactionId: imported.items[0].id,
    input: { classification_type: 'duplicate', duplicate_of_transaction_id: manual.id },
  });
  const after = await allTransactions(db);
  assert.equal(after.length, 1);
  assert.equal(JSON.stringify(after[0]), before, 'the manual transaction is byte-for-byte unchanged');
});

// ── 6. retry after partial failure (driver with real rollback) ──────────────────

test('matrix 6: a failure mid-import leaves nothing behind and the retry succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-identity-'));
  const db = createSqliteDb({ dbPath: path.join(dir, 'raf.sqlite') });
  try {
    const lines = [COFFEE, BOOK];
    let fail = true;
    const flaky = {
      ...db,
      transaction: (callback) => db.transaction((tx) => callback({
        ...tx,
        insertImportedTransactions: async (args) => {
          if (fail) throw new Error('simulated failure');
          return tx.insertImportedTransactions(args);
        },
      })),
    };

    await assert.rejects(importPdf(flaky, lines, 'retry'), /simulated failure/);
    assert.equal(db.state.importBatches.length, 0, 'no orphan batch');
    assert.equal(db.state.importedTransactions.length, 0);

    fail = false;
    const retried = await importPdf(flaky, lines, 'retry');
    assert.equal(retried.extracted, 2);
    assert.equal(db.state.importBatches.length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matrix 6b: a failure after the transaction is created rolls back the transaction and its claim; the retry yields one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-identity-'));
  const db = createSqliteDb({ dbPath: path.join(dir, 'raf.sqlite') });
  try {
    const accountId = await addAccount(db, WS, 'Checking');
    const imported = await importPdf(db, [BOOK], 'A', { accountId });
    let fail = true;
    const flaky = {
      ...db,
      transaction: (callback) => db.transaction((tx) => callback({
        ...tx,
        updateImportedTransaction: async (args) => {
          if (fail) throw new Error('simulated failure after create');
          return tx.updateImportedTransaction(args);
        },
      })),
    };
    const category = await categoryId(db);
    const input = { classification_type: 'transaction', category_id: category };

    await assert.rejects(
      classifyImportedTransaction({ db: flaky, householdId: WS, importedTransactionId: imported.items[0].id, input }),
      /simulated failure/,
    );
    assert.equal(db.state.transactions.length, 0);
    assert.equal(db.state.importEventClaims.length, 0);

    fail = false;
    await classifyImportedTransaction({ db: flaky, householdId: WS, importedTransactionId: imported.items[0].id, input });
    assert.equal(db.state.transactions.length, 1);
    assert.equal(db.state.importEventClaims.length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7. concurrency ────────────────────────────────────────────────────────────

test('matrix 7a: concurrent imports of the same file produce one batch', async () => {
  const db = createInMemoryDb();
  const results = await Promise.allSettled([1, 2, 3].map(() => importPdf(db, [COFFEE, BOOK], 'conc')));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
  assert.equal(db.state.importBatches.length, 1);
  assert.equal(db.state.importedTransactions.length, 2);
});

test('matrix 7b: concurrent classification of one staged row creates one transaction', async () => {
  const db = createInMemoryDb();
  const imported = await importPdf(db, [BOOK], 'A');
  const results = await Promise.allSettled([1, 2, 3].map(() => classify(db, imported.items[0].id)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await allTransactions(db)).length, 1);
});

test('matrix 7c: concurrent resolution of one event from two statements creates one transaction', async () => {
  const db = createInMemoryDb();
  const a = await importPdf(db, [BOOK, COFFEE], 'A');
  const b = await importPdf(db, [BOOK, RENT], 'B');
  const rowA = a.items.find((item) => /BOOKSTORE/.test(item.description));
  const rowB = b.items.find((item) => /BOOKSTORE/.test(item.description));
  const results = await Promise.allSettled([classify(db, rowA.id), classify(db, rowB.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await allTransactions(db)).filter((t) => /BOOKSTORE/.test(t.description)).length, 1);
});

test('matrix 7d: concurrent approval of two overlapping CSV batches does not duplicate the shared event', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const category = await categoryId(db);
  const prepare = async (text) => {
    const batch = await uploadImportBatch({ db, householdId: WS, input: { filename: 'x.csv', text, accountId } });
    const parsed = await parseImportBatch({ db, householdId: WS, batchId: batch.batchId, input: COLUMN_MAP });
    for (const row of parsed.rows) {
      await updateImportedRow({ db, householdId: WS, rowId: row.id, input: { status: 'approved', categoryId: category } });
    }
    return batch.batchId;
  };
  const one = await prepare('Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit\n2026-01-21,PHARMACY,12.00,debit');
  const two = await prepare('Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit\n2026-01-22,GYM,40.00,debit\n');

  await Promise.allSettled([
    approveImportBatch({ db, householdId: WS, batchId: one }),
    approveImportBatch({ db, householdId: WS, batchId: two }),
  ]);
  assert.equal((await allTransactions(db)).filter((t) => /BOOKSTORE/.test(t.description)).length, 1);
  assert.equal((await allTransactions(db)).length, 3);
});

// ── 8/9. malformed and partially malformed AI output ───────────────────────────

const UNREADABLE = ['SCANNED STATEMENT', 'no recognisable transaction lines here'];

test('matrix 8: entirely malformed AI output imports nothing and explains why', async () => {
  const counters = { reserved: 0, recorded: 0 };
  const db = withQuota(createInMemoryDb(), counters, 'paid');
  const aiParser = async () => ({
    rows: [
      { date: '2026-02-30', description: 'x', amount: '-5.00' },
      { date: '2026-01-15', description: 'y', amount: 'abc' },
      { date: '2026-01-15', description: '', amount: '-5.00' },
    ],
    error: null,
  });

  await assert.rejects(importPdf(db, UNREADABLE, 'ai', { aiParser }), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.details.rows_found, 3);
    assert.equal(error.details.rows_valid, 0);
    assert.equal(error.details.rows_rejected, 3);
    assert.equal(error.details.rejected_rows.length, 3);
    return true;
  });
  assert.equal(db.state.importedTransactions.length, 0);
  assert.equal(db.state.importBatches.length, 0, 'no batch is recorded for an import that produced nothing');
  assert.equal(counters.recorded, 0, 'quota usage is not recorded for a failed import');
});

test('matrix 9: partially malformed AI output imports the valid rows, reports the rejected ones, and records provenance', async () => {
  const counters = { reserved: 0, recorded: 0 };
  const db = withQuota(createInMemoryDb(), counters, 'paid');
  const aiParser = async () => ({
    model: 'test-model',
    error: null,
    rows: [
      { date: '2026-01-15', description: 'Coffee', rawDescription: 'COFFEE SHOP 1', amount: '-5.00' },
      { date: '2026-13-45', description: 'Broken date', amount: '-9.00' },
      null,
      { date: '2026-01-16', description: 'Payroll', amount: '2000.00' },
    ],
  });

  const result = await importPdf(db, UNREADABLE, 'ai2', { aiParser });
  assert.equal(result.extracted, 2);
  assert.equal(result.parser, 'ai');
  assert.equal(result.rows_found, 4);
  assert.equal(result.rows_valid, 2);
  assert.equal(result.rows_rejected, 2);
  assert.deepEqual(result.rejected_rows.map((row) => row.index), [1, 2]);
  assert.ok(result.items.every((item) => item.parser === 'ai'));
  assert.equal(db.state.importBatches[0].parser, 'ai');
  assert.equal(db.state.importBatches[0].aiModel, 'test-model');
  assert.equal(db.state.importBatches[0].rowsRejected, 2);
  assert.equal(counters.recorded, 1);
});

test('matrix 9b: the AI fallback still deduplicates against existing events', async () => {
  const counters = { reserved: 0, recorded: 0 };
  const db = withQuota(createInMemoryDb(), counters, 'paid');
  const accountId = await addAccount(db, WS, 'Checking');
  const first = await importPdf(db, [BOOK], 'regex', { accountId });
  await classify(db, first.items[0].id);

  const aiParser = async () => ({ rows: [{ date: '2026-01-20', description: 'Bookstore', rawDescription: 'BOOKSTORE', amount: '-30.00' }], error: null });
  const viaAi = await importPdf(db, UNREADABLE, 'ai3', { accountId, aiParser });
  assert.equal(viaAi.items[0].duplicate_state, 'exact');
});

// ── 10. protected PDFs ────────────────────────────────────────────────────────

test('matrix 10a: a password-protected PDF returns an actionable error before any quota or AI work', async () => {
  const counters = { reserved: 0, recorded: 0 };
  const db = withQuota(createInMemoryDb(), counters);
  let aiCalled = false;
  const passwordError = Object.assign(new Error('No password given'), { name: 'PasswordException' });

  await assert.rejects(
    importBankStatement({
      db,
      householdId: WS,
      pdfTextExtractor: async () => { throw passwordError; },
      aiParser: async () => { aiCalled = true; return { rows: [], error: null }; },
      input: pdf(['anything'], 'locked'),
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(errorCode(error), 'PDF_PASSWORD_PROTECTED');
      assert.match(error.message, /password-protected/);
      return true;
    },
  );
  assert.equal(aiCalled, false, 'unusable extraction is never sent to the AI fallback');
  assert.equal(counters.reserved, 0, 'free-tier quota is not consumed');
  assert.equal(db.state.importBatches.length, 0);
});

test('matrix 10b: an encrypted PDF that decodes to nothing is reported as protected, not as an empty statement', async () => {
  const db = createInMemoryDb();
  const encrypted = Buffer.from('%PDF-1.6\n1 0 obj\n<< /Filter /Standard /V 4 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF');
  await assert.rejects(
    importBankStatement({
      db, householdId: WS, pdfTextExtractor: async () => '',
      input: { filename: 'enc.pdf', contentType: 'application/pdf', pdfBuffer: encrypted },
    }),
    (error) => errorCode(error) === 'PDF_PASSWORD_PROTECTED',
  );

  const plain = Buffer.from('%PDF-1.4\nblank\n%%EOF');
  await assert.rejects(
    importBankStatement({
      db, householdId: WS, pdfTextExtractor: async () => '',
      input: { filename: 'blank.pdf', contentType: 'application/pdf', pdfBuffer: plain },
    }),
    (error) => error.status === 422 && errorCode(error) !== 'PDF_PASSWORD_PROTECTED',
    'a blank, unencrypted PDF keeps its own error',
  );
});

test('matrix 10c: the HTTP route exposes the protected-PDF error code to the client', async () => {
  const db = createInMemoryDb();
  const passwordError = Object.assign(new Error('Incorrect Password'), { name: 'PasswordException' });
  const response = await bankStatementRoute(
    new Request('http://localhost/api/v1/imports/bank-statement', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'locked.pdf' },
      body: pdf(['x'], 'route').pdfBuffer,
    }),
    { db, householdId: WS, pdfTextExtractor: async () => { throw passwordError; } },
  );
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.errorCode, 'PDF_PASSWORD_PROTECTED');
  assert.match(body.error, /password-protected/);
});

// ── 11/12. foreign workspace and account identifiers ────────────────────────────

test('matrix 11: another workspace cannot classify, see or influence this workspace\'s imports', async () => {
  const db = createInMemoryDb();
  const imported = await importPdf(db, [BOOK], 'A');
  await assert.rejects(
    classifyImportedTransaction({
      db, householdId: OTHER_WS, importedTransactionId: imported.items[0].id,
      input: { classification_type: 'ignore' },
    }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    unprocessImportedTransaction({ db, householdId: OTHER_WS, importedTransactionId: imported.items[0].id }),
    (error) => error.status === 404,
  );
});

test('matrix 11b: duplicate evidence never crosses workspaces', async () => {
  const db = createInMemoryDb();
  const a = await importPdf(db, [BOOK], 'A');
  await classify(db, a.items[0].id);

  const other = await importPdf(db, [BOOK], 'B', { householdId: OTHER_WS });
  assert.equal(other.items[0].duplicate_state, 'none', 'the other workspace sees no evidence from this one');
  assert.equal((await allTransactions(db, WS)).length, 1);
});

test('matrix 12: a foreign account id is rejected for PDF import, CSV upload, and the HTTP route', async () => {
  const db = createInMemoryDb();
  const foreignAccount = await addAccount(db, OTHER_WS, 'Theirs');

  await assert.rejects(importPdf(db, [BOOK], 'A', { accountId: foreignAccount }), (error) => error.status === 404);
  await assert.rejects(
    uploadImportBatch({ db, householdId: WS, input: { filename: 'x.csv', text: 'Date,Description,Amount\n2026-01-20,B,30.00', accountId: foreignAccount } }),
    (error) => error.status === 404,
  );

  const form = new FormData();
  form.set('file', new File([pdf([BOOK], 'route2').pdfBuffer], 'route2.pdf', { type: 'application/pdf' }));
  form.set('account_id', foreignAccount);
  const response = await bankStatementRoute(
    new Request('http://localhost/api/v1/imports/bank-statement', { method: 'POST', body: form }),
    { db, householdId: WS, pdfTextExtractor: extractor([BOOK]) },
  );
  assert.equal(response.status, 404);
  assert.equal(db.state.importedTransactions.length, 0);
  assert.equal(db.state.importBatches.length, 0);
});

test('matrix 12b: a foreign transaction id cannot be used to reconcile a duplicate', async () => {
  const db = createInMemoryDb();
  const theirs = await db.transaction(async (tx) => tx.insertTransaction({
    householdId: OTHER_WS, transactionDate: '2026-01-20', description: 'Theirs', amount: '30.00', direction: 'debit', source: 'manual',
  }));
  const imported = await importPdf(db, [BOOK], 'A');
  await assert.rejects(
    classifyImportedTransaction({
      db, householdId: WS, importedTransactionId: imported.items[0].id,
      input: { classification_type: 'duplicate', duplicate_of_transaction_id: theirs.id },
    }),
    (error) => error.status === 404,
  );
  assert.equal(db.state.importEventClaims.length, 0);
});

// ── 13. reconciliation followed by re-import ───────────────────────────────────

test('matrix 13: after an event is reconciled to a manual transaction, re-importing it stays resolved', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const category = await categoryId(db);
  const manual = await createTransaction({
    db, householdId: WS, userId: 'u1',
    input: { transactionDate: '2026-01-20', description: 'Bookstore', amount: '30.00', direction: 'debit', categoryId: category, accountId },
  });

  const first = await importPdf(db, [BOOK], 'A', { accountId });
  await classifyImportedTransaction({
    db, householdId: WS, importedTransactionId: first.items[0].id,
    input: { classification_type: 'duplicate', duplicate_of_transaction_id: manual.id },
  });

  const second = await importPdf(db, [BOOK, RENT], 'B', { accountId });
  const again = second.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal(again.duplicate_state, 'exact');
  await assert.rejects(classify(db, again.id), (error) => errorCode(error) === 'IMPORT_EXACT_DUPLICATE');

  // An account reconciliation record on the same account changes nothing about identity.
  await db.transaction((tx) => tx.insertAccountReconciliation({
    householdId: WS, accountId, recordedBalance: '100.00', reportedBalance: '95.00', discrepancy: '-5.00', reportedAsOf: '2026-02-01T00:00:00.000Z', status: 'open',
  }));
  const third = await importPdf(db, [BOOK, '2026-03-05 GYM -40.00 25.00'], 'C', { accountId });
  assert.equal(third.items.find((item) => /BOOKSTORE/.test(item.description)).duplicate_state, 'exact');
  assert.equal((await allTransactions(db)).length, 1, 'still only the manual transaction');
});

test('matrix 13b: unprocess and delete release the event; the manual transaction is never deleted by unprocess', async () => {
  const db = createInMemoryDb();
  const accountId = await addAccount(db, WS, 'Checking');
  const category = await categoryId(db);
  const manual = await createTransaction({
    db, householdId: WS, userId: 'u1',
    input: { transactionDate: '2026-01-20', description: 'Bookstore', amount: '30.00', direction: 'debit', categoryId: category, accountId },
  });
  const imported = await importPdf(db, [BOOK], 'A', { accountId });
  await classifyImportedTransaction({
    db, householdId: WS, importedTransactionId: imported.items[0].id,
    input: { classification_type: 'duplicate', duplicate_of_transaction_id: manual.id },
  });
  await unprocessImportedTransaction({ db, householdId: WS, importedTransactionId: imported.items[0].id });
  assert.equal((await allTransactions(db)).length, 1, 'the manual transaction survives');
  assert.equal(db.state.importEventClaims.length, 0);

  const second = await importPdf(db, [BOOK, RENT], 'B', { accountId });
  const row = second.items.find((item) => /BOOKSTORE/.test(item.description));
  const created = await classify(db, row.id, { confirm_distinct: true });
  assert.equal(db.state.importEventClaims.length, 1);

  await deleteTransaction({ db, householdId: WS, transactionId: created.linked_transaction_id, userId: 'u1' });
  assert.equal(db.state.importEventClaims.length, 0, 'deleting the canonical transaction frees the event');
});

// ── adapter parity ────────────────────────────────────────────────────────────

test('parity: the in-memory and Postgres adapters expose the same identity methods', async () => {
  const { buildImportsRepository } = await import('../lib/repositories/postgres/importsRepository.js');
  const postgres = buildImportsRepository({ query: async () => ({ rows: [] }) }, 'raf');
  const memory = createInMemoryDb();
  const memoryTx = await memory.transaction(async (tx) => tx);
  for (const method of [
    'lockImportIdentity', 'findImportEventClaims', 'insertImportEventClaim',
    'deleteImportEventClaimsForImportedTransaction', 'findLikelyDuplicateTransactions', 'findLikelyDuplicateIncomeEntries',
  ]) {
    assert.equal(typeof postgres[method], 'function', `postgres adapter: ${method}`);
    assert.equal(typeof memoryTx[method], 'function', `in-memory adapter: ${method}`);
  }
});

// ── income imports use the same identity rules ─────────────────────────────────

test('matrix 14: the same deposit imported from overlapping statements does not become two income entries', async () => {
  const PAYROLL = '2026-01-25 PAYROLL 2000.00 3000.00';
  const incomeInput = { classification_type: 'income' };
  const countIncome = (db) => db.state.incomeEntries.length;

  const noAccount = createInMemoryDb();
  const a = await importPdf(noAccount, [PAYROLL], 'A');
  await classifyImportedTransaction({ db: noAccount, householdId: WS, importedTransactionId: a.items[0].id, input: incomeInput });
  const b = await importPdf(noAccount, [PAYROLL, RENT], 'B');
  const dup = b.items.find((item) => /PAYROLL/.test(item.description));
  await assert.rejects(
    classifyImportedTransaction({ db: noAccount, householdId: WS, importedTransactionId: dup.id, input: incomeInput }),
    (error) => errorCode(error) === 'IMPORT_POSSIBLE_DUPLICATE',
  );
  assert.equal(countIncome(noAccount), 1);

  const withAccount = createInMemoryDb();
  const accountId = await addAccount(withAccount, WS, 'Checking');
  const c = await importPdf(withAccount, [PAYROLL], 'C', { accountId });
  await classifyImportedTransaction({ db: withAccount, householdId: WS, importedTransactionId: c.items[0].id, input: incomeInput });
  const d = await importPdf(withAccount, [PAYROLL, RENT], 'D', { accountId });
  const exact = d.items.find((item) => /PAYROLL/.test(item.description));
  assert.equal(exact.duplicate_state, 'exact');
  await assert.rejects(
    classifyImportedTransaction({ db: withAccount, householdId: WS, importedTransactionId: exact.id, input: { ...incomeInput, confirm_distinct: true } }),
    (error) => errorCode(error) === 'IMPORT_EXACT_DUPLICATE',
  );
  assert.equal(countIncome(withAccount), 1);

  // Removing the income entry releases the event.
  await withAccount.transaction((tx) => tx.deleteIncomeEntry({ householdId: WS, incomeId: withAccount.state.incomeEntries[0].id }));
  assert.equal(withAccount.state.importEventClaims.length, 0);
});

// ── rows staged before event identity existed ───────────────────────────────────

test('legacy: a staged row without identity fields is still protected by explicit confirmation and creates no claim', async () => {
  const db = createInMemoryDb();
  const category = await categoryId(db);
  const legacyRow = async () => (await db.transaction((tx) => tx.insertImportedTransactions({
    householdId: WS,
    rows: [{
      householdId: WS, date: '2026-01-20', description: 'BOOKSTORE', amount: '-30.00', currency: 'CAD', source: 'bank_import',
      rawDescription: 'BOOKSTORE', referenceNumber: null, balanceAfterTransaction: null, status: 'unreviewed',
      classificationType: null, linkedTransactionId: null, linkedDebtId: null, linkedFixedBillId: null, reviewedAt: null, reviewNote: null,
    }],
  })))[0];

  const first = await legacyRow();
  await classifyImportedTransaction({
    db, householdId: WS, importedTransactionId: first.id, input: { classification_type: 'transaction', category_id: category },
  });
  assert.equal(db.state.importEventClaims.length, 0, 'no ordinal is known, so no claim is invented');

  const second = await legacyRow();
  await assert.rejects(
    classifyImportedTransaction({
      db, householdId: WS, importedTransactionId: second.id, input: { classification_type: 'transaction', category_id: category },
    }),
    (error) => errorCode(error) === 'IMPORT_POSSIBLE_DUPLICATE',
  );
  await classifyImportedTransaction({
    db, householdId: WS, importedTransactionId: second.id, input: { classification_type: 'transaction', category_id: category, confirm_distinct: true },
  });
  assert.equal((await allTransactions(db)).length, 2);
});
