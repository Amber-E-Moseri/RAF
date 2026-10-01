import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { Pool } from 'pg';

import { ensureUserOnboarded } from '../lib/auth/onboarding.js';
import { approveImportBatch } from '../lib/imports/approveImportBatch.js';
import { importBankStatement } from '../lib/imports/bankStatementImports.js';
import { parseImportBatch } from '../lib/imports/parseImportBatch.js';
import { classifyImportedTransaction, unprocessImportedTransaction } from '../lib/imports/reviewImportedTransactions.js';
import { updateImportedRow } from '../lib/imports/updateImportedRow.js';
import { uploadImportBatch } from '../lib/imports/uploadImportBatch.js';
import { createPostgresDb } from '../lib/server/postgresDb.js';
import { deleteTransaction } from '../lib/transactions/createTransaction.js';

// Real-database proof for transaction identity. Needs:
//   RAF_IDENTITY_TEST_ADMIN_URL  owner connection (BYPASSRLS) — fixtures and assertions only
//   RAF_IDENTITY_TEST_APP_URL    raf_app connection (NOBYPASSRLS) — everything the app does
// against a database with the full migration chain applied. Both must be localhost unless
// RAF_CONFIRM_NON_PRODUCTION_DB=true.
const adminUrl = process.env.RAF_IDENTITY_TEST_ADMIN_URL;
const appUrl = process.env.RAF_IDENTITY_TEST_APP_URL;
const isLocal = (url) => /@(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url ?? '');
const shouldRun = Boolean(adminUrl && appUrl)
  && ((isLocal(adminUrl) && isLocal(appUrl)) || process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true');
const maybeTest = shouldRun ? test : test.skip;

const adminDb = shouldRun ? createPostgresDb({ connectionString: adminUrl, ssl: false }) : null;
const appDb = shouldRun ? createPostgresDb({ connectionString: appUrl, ssl: false }) : null;
const adminPool = shouldRun ? new Pool({ connectionString: adminUrl, max: 2 }) : null;
const createdWorkspaceIds = [];

after(async () => {
  if (!shouldRun) return;
  if (createdWorkspaceIds.length > 0) {
    await adminPool.query('DELETE FROM raf.workspaces WHERE id = ANY($1::uuid[])', [createdWorkspaceIds]);
  }
  await adminPool.end();
});

async function makeWorkspace(label) {
  const user = { id: crypto.randomUUID(), email: `${label}-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db: adminDb, user, workspaceName: label });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  createdWorkspaceIds.push(workspaceId);

  const ctx = (extra = {}) => ({
    transaction: (callback) => appDb.transaction(callback, { userId: user.id, workspaceId, ...extra }),
  });
  const db = ctx();
  const categoryId = await db.transaction(async (tx) => {
    const categories = await tx.listAllocationCategories({ householdId: workspaceId });
    return categories.find((category) => category.slug === 'buffer')?.id ?? categories[0].id;
  });
  const makeAccount = (name) => adminDb.transaction(async (tx) => {
    const account = await tx.insertFinancialAccount({
      householdId: workspaceId, name, accountType: 'checking', currentBalance: '0.00', isActive: true,
    });
    return account.id;
  });

  return { user, workspaceId, db, categoryId, makeAccount };
}

const pdf = (lines, salt) => ({
  filename: `stmt-${salt}.pdf`,
  contentType: 'application/pdf',
  pdfBuffer: Buffer.from(`%PDF-1.4\n${salt}\n${lines.join('\n')}\n%%EOF`),
});
const extractor = (lines) => async () => lines.join('\n');

async function importPdf(ws, lines, salt, accountId = null) {
  return importBankStatement({
    db: ws.db,
    householdId: ws.workspaceId,
    pdfTextExtractor: extractor(lines),
    input: { ...pdf(lines, salt), accountId },
  });
}

function classifyAsTransaction(ws, rowId, extra = {}) {
  return classifyImportedTransaction({
    db: ws.db,
    householdId: ws.workspaceId,
    importedTransactionId: rowId,
    input: { classification_type: 'transaction', category_id: ws.categoryId, ...extra },
  });
}

async function countTransactions(workspaceId, description = null) {
  const result = await adminPool.query(
    `SELECT count(*)::int AS n FROM raf.transactions WHERE workspace_id = $1 ${description ? 'AND description ILIKE $2' : ''}`,
    description ? [workspaceId, `%${description}%`] : [workspaceId],
  );
  return result.rows[0].n;
}

async function countClaims(workspaceId) {
  const result = await adminPool.query('SELECT count(*)::int AS n FROM raf.import_event_claims WHERE workspace_id = $1', [workspaceId]);
  return result.rows[0].n;
}

const BOOK = '2026-01-20 BOOKSTORE -30.00 965.00';
const COFFEE = '2026-01-15 COFFEE SHOP -5.00 995.00';
const RENT = '2026-02-01 RENT -900.00 65.00';

maybeTest('PG: concurrent import of the same file yields exactly one batch and one set of staged rows', async () => {
  const ws = await makeWorkspace('conc-import');
  const lines = [COFFEE, BOOK];
  const results = await Promise.allSettled([1, 2, 3].map(() => importPdf(ws, lines, 'same')));

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one import wins');
  for (const loser of results.filter((r) => r.status === 'rejected')) {
    assert.equal(loser.reason.status, 409);
  }

  const batches = await adminPool.query('SELECT count(*)::int AS n FROM raf.import_batches WHERE workspace_id = $1', [ws.workspaceId]);
  const staged = await adminPool.query('SELECT count(*)::int AS n FROM raf.imported_transactions WHERE workspace_id = $1', [ws.workspaceId]);
  assert.equal(batches.rows[0].n, 1);
  assert.equal(staged.rows[0].n, 2);
});

maybeTest('PG: failure while staging rows rolls back the batch, so a retry of the same file succeeds', async () => {
  const ws = await makeWorkspace('atomic-import');
  const lines = [COFFEE, BOOK];
  const flaky = {
    transaction: (callback) => ws.db.transaction((tx) => callback({
      ...tx,
      insertImportedTransactions: async () => { throw new Error('simulated failure mid-import'); },
    })),
  };

  await assert.rejects(
    importBankStatement({ db: flaky, householdId: ws.workspaceId, pdfTextExtractor: extractor(lines), input: pdf(lines, 'retry') }),
    /simulated failure/,
  );
  const orphan = await adminPool.query('SELECT count(*)::int AS n FROM raf.import_batches WHERE workspace_id = $1', [ws.workspaceId]);
  assert.equal(orphan.rows[0].n, 0, 'no orphan batch after rollback');

  const retried = await importPdf(ws, lines, 'retry');
  assert.equal(retried.extracted, 2, 'retry is not blocked by a phantom 409');
});

maybeTest('PG: overlapping statements on a known account — the overlapping row is an exact duplicate and cannot become a transaction', async () => {
  const ws = await makeWorkspace('overlap-account');
  const accountId = await ws.makeAccount('Checking');
  const a = await importPdf(ws, [COFFEE, BOOK], 'A', accountId);
  const bBeforeResolution = await importPdf(ws, [BOOK, '2026-03-05 GYM -40.00 25.00'], 'B0', accountId);

  for (const item of a.items) await classifyAsTransaction(ws, item.id);
  assert.equal(await countTransactions(ws.workspaceId), 2);

  // Staged before A was resolved, so it carries no flag — the classify gate must still hold.
  const early = bBeforeResolution.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal(early.duplicate_state, 'none');
  await assert.rejects(
    classifyAsTransaction(ws, early.id),
    (error) => error.status === 409 && error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE',
  );

  // Staged after A was resolved, so it is flagged exact up front.
  const b = await importPdf(ws, [BOOK, RENT], 'B', accountId);
  const overlapping = b.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal(overlapping.duplicate_state, 'exact', 'flagged at staging time');
  await assert.rejects(
    classifyAsTransaction(ws, overlapping.id),
    (error) => error.status === 409 && error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE',
  );
  await assert.rejects(
    classifyAsTransaction(ws, overlapping.id, { confirm_distinct: true }),
    (error) => error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE',
    'exact duplicates cannot be overridden by confirm_distinct',
  );

  const fresh = b.items.find((item) => /RENT/.test(item.description));
  await classifyAsTransaction(ws, fresh.id);
  assert.equal(await countTransactions(ws.workspaceId), 3, 'only the genuinely new event was added');
  assert.equal(await countTransactions(ws.workspaceId, 'BOOKSTORE'), 1);
});

maybeTest('PG: the unique index is the backstop even if application checks are bypassed', async () => {
  const ws = await makeWorkspace('index-backstop');
  const accountId = await ws.makeAccount('Checking');
  const txIds = [];
  for (let i = 0; i < 2; i += 1) {
    txIds.push(await ws.db.transaction(async (tx) => (await tx.insertTransaction({
      householdId: ws.workspaceId, transactionDate: '2026-03-01', description: `manual ${i}`,
      amount: '10.00', direction: 'debit', source: 'manual', accountId,
    })).id));
  }
  const claim = (transactionId) => ws.db.transaction((tx) => tx.insertImportEventClaim({
    householdId: ws.workspaceId, accountId, eventKey: 'k'.repeat(64), eventOrdinal: 1,
    transactionId, claimType: 'created', source: 'pdf_import',
  }));

  await claim(txIds[0]);
  await assert.rejects(claim(txIds[1]), (error) => error.code === '23505' && error.constraint === 'idx_import_event_claims_account_event');
  await assert.rejects(
    ws.db.transaction((tx) => tx.insertImportEventClaim({
      householdId: ws.workspaceId, accountId, eventKey: 'z'.repeat(64), eventOrdinal: 1,
      transactionId: txIds[0], claimType: 'created', source: 'pdf_import',
    })),
    (error) => error.code === '23505' && error.constraint === 'idx_import_event_claims_transaction',
    'one canonical record cannot stand for two events',
  );
});

maybeTest('PG: concurrent classification of the same staged row creates exactly one transaction', async () => {
  const ws = await makeWorkspace('conc-classify');
  const imported = await importPdf(ws, [BOOK], 'one');
  const rowId = imported.items[0].id;

  const results = await Promise.allSettled([1, 2, 3, 4].map(() => classifyAsTransaction(ws, rowId)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await countTransactions(ws.workspaceId), 1);
  assert.equal(await countClaims(ws.workspaceId), 1);
});

maybeTest('PG: concurrent classification of the same event from two different statements (account unknown) creates one transaction', async () => {
  const ws = await makeWorkspace('conc-cross-batch');
  const a = await importPdf(ws, [BOOK, COFFEE], 'A');
  const b = await importPdf(ws, [BOOK, RENT], 'B');
  const rowA = a.items.find((item) => /BOOKSTORE/.test(item.description));
  const rowB = b.items.find((item) => /BOOKSTORE/.test(item.description));

  const results = await Promise.allSettled([classifyAsTransaction(ws, rowA.id), classifyAsTransaction(ws, rowB.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'the second resolver sees the first one\'s record');
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.details?.errorCode, 'IMPORT_POSSIBLE_DUPLICATE');
  assert.equal(await countTransactions(ws.workspaceId, 'BOOKSTORE'), 1);
});

maybeTest('PG: failure after the transaction is created rolls everything back and a retry yields exactly one', async () => {
  const ws = await makeWorkspace('classify-rollback');
  const imported = await importPdf(ws, [BOOK], 'rb');
  const rowId = imported.items[0].id;

  const flaky = {
    transaction: (callback) => ws.db.transaction((tx) => callback({
      ...tx,
      updateImportedTransaction: async () => { throw new Error('simulated failure after create'); },
    })),
  };
  await assert.rejects(
    classifyImportedTransaction({
      db: flaky, householdId: ws.workspaceId, importedTransactionId: rowId,
      input: { classification_type: 'transaction', category_id: ws.categoryId },
    }),
    /simulated failure/,
  );
  assert.equal(await countTransactions(ws.workspaceId), 0);
  assert.equal(await countClaims(ws.workspaceId), 0);

  await classifyAsTransaction(ws, rowId);
  assert.equal(await countTransactions(ws.workspaceId), 1);
});

maybeTest('PG: manual transaction + imported equivalent needs explicit resolution; reconciling then re-importing stays resolved', async () => {
  const ws = await makeWorkspace('manual-reconcile');
  const accountId = await ws.makeAccount('Checking');
  const manualId = await ws.db.transaction(async (tx) => (await tx.insertTransaction({
    householdId: ws.workspaceId, transactionDate: '2026-01-20', description: 'Bookstore',
    amount: '30.00', direction: 'debit', source: 'manual', accountId,
  })).id);

  const first = await importPdf(ws, [BOOK], 'M1', accountId);
  const row = first.items[0];
  assert.equal(row.duplicate_state, 'likely');
  await assert.rejects(classifyAsTransaction(ws, row.id), (error) => error.details?.errorCode === 'IMPORT_POSSIBLE_DUPLICATE');
  assert.equal(await countTransactions(ws.workspaceId), 1, 'nothing created while unresolved');

  await classifyImportedTransaction({
    db: ws.db, householdId: ws.workspaceId, importedTransactionId: row.id,
    input: { classification_type: 'duplicate', duplicate_of_transaction_id: manualId },
  });
  assert.equal(await countTransactions(ws.workspaceId), 1, 'reconciled to the manual transaction; no new one');

  const second = await importPdf(ws, [BOOK, RENT], 'M2', accountId);
  const again = second.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal(again.duplicate_state, 'exact', 'the reconciled event is recognised on re-import');
  await assert.rejects(classifyAsTransaction(ws, again.id), (error) => error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE');
  assert.equal(await countTransactions(ws.workspaceId), 1);
});

maybeTest('PG: deleting the canonical transaction frees the event for a clean re-import', async () => {
  const ws = await makeWorkspace('delete-frees');
  const accountId = await ws.makeAccount('Checking');
  const a = await importPdf(ws, [BOOK], 'D1', accountId);
  const created = await classifyAsTransaction(ws, a.items[0].id);
  assert.equal(await countClaims(ws.workspaceId), 1);

  await deleteTransaction({ db: ws.db, householdId: ws.workspaceId, transactionId: created.linked_transaction_id, userId: ws.user.id });
  assert.equal(await countClaims(ws.workspaceId), 0, 'claim cascades with the transaction');

  const b = await importPdf(ws, [BOOK, RENT], 'D2', accountId);
  const row = b.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal(row.duplicate_state, 'none');
  await classifyAsTransaction(ws, row.id);
  assert.equal(await countTransactions(ws.workspaceId, 'BOOKSTORE'), 1);
});

maybeTest('PG: legitimate identical purchases survive within a statement and across a partially overlapping one', async () => {
  const ws = await makeWorkspace('legit-identical');
  const accountId = await ws.makeAccount('Checking');
  const two = [COFFEE, '2026-01-15 COFFEE SHOP -5.00 990.00'];
  const a = await importPdf(ws, two, 'L1', accountId);
  for (const item of a.items) await classifyAsTransaction(ws, item.id);
  assert.equal(await countTransactions(ws.workspaceId, 'COFFEE'), 2, 'both real purchases exist');

  // A later export repeats both. Occurrence 1 and 2 map one-to-one onto what already exists.
  const b = await importPdf(ws, [...two, RENT], 'L2', accountId);
  const coffees = b.items.filter((item) => /COFFEE/.test(item.description));
  assert.deepEqual(coffees.map((item) => item.duplicate_state), ['exact', 'exact']);
  for (const item of coffees) {
    await assert.rejects(classifyAsTransaction(ws, item.id), (error) => error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE');
  }
  assert.equal(await countTransactions(ws.workspaceId, 'COFFEE'), 2);
});

maybeTest('PG: RLS hides and protects claims across workspaces', async () => {
  const wsA = await makeWorkspace('rls-a');
  const wsB = await makeWorkspace('rls-b');
  const accountA = await wsA.makeAccount('A');
  const imported = await importPdf(wsA, [BOOK], 'RLS', accountA);
  await classifyAsTransaction(wsA, imported.items[0].id);
  assert.equal(await countClaims(wsA.workspaceId), 1);

  const seenByB = await wsB.db.transaction(async (tx) => tx.findImportEventClaims({
    householdId: wsA.workspaceId,
    eventKey: (await adminPool.query('SELECT event_key FROM raf.import_event_claims WHERE workspace_id = $1', [wsA.workspaceId])).rows[0].event_key,
    eventOrdinal: 1,
  }));
  assert.equal(seenByB.length, 0, 'workspace B cannot read workspace A claims');

  await assert.rejects(
    wsB.db.transaction((tx) => tx.insertImportEventClaim({
      householdId: wsA.workspaceId, accountId: null, eventKey: 'x'.repeat(64), eventOrdinal: 1,
      transactionId: crypto.randomUUID(), claimType: 'created', source: 'pdf_import',
    })),
    undefined,
    'workspace B cannot write claims into workspace A',
  );

  const foreignTransaction = await wsA.db.transaction((tx) => tx.listTransactions({ householdId: wsA.workspaceId, from: '2000-01-01', to: '2100-01-01' }));
  assert.equal(foreignTransaction.items.length, 1);
  const leaked = await wsB.db.transaction((tx) => tx.listTransactions({ householdId: wsA.workspaceId, from: '2000-01-01', to: '2100-01-01' }));
  assert.equal(leaked.items.length, 0);
});

maybeTest('PG: foreign workspace, account and transaction identifiers are rejected end to end', async () => {
  const wsA = await makeWorkspace('foreign-a');
  const wsB = await makeWorkspace('foreign-b');
  const accountB = await wsB.makeAccount('B account');
  const txB = await wsB.db.transaction(async (tx) => (await tx.insertTransaction({
    householdId: wsB.workspaceId, transactionDate: '2026-01-20', description: 'B private',
    amount: '30.00', direction: 'debit', source: 'manual', accountId: accountB,
  })).id);

  await assert.rejects(importPdf(wsA, [BOOK], 'F1', accountB), (error) => error.status === 404, 'PDF import with foreign account');
  await assert.rejects(
    uploadImportBatch({
      db: wsA.db, householdId: wsA.workspaceId,
      input: { filename: 'x.csv', text: 'Date,Description,Amount\n2026-01-20,Bookstore,30.00', accountId: accountB },
    }),
    (error) => error.status === 404,
    'CSV upload with foreign account',
  );

  const importedA = await importPdf(wsA, [BOOK], 'F2');
  await assert.rejects(
    classifyImportedTransaction({
      db: wsA.db, householdId: wsA.workspaceId, importedTransactionId: importedA.items[0].id,
      input: { classification_type: 'duplicate', duplicate_of_transaction_id: txB },
    }),
    (error) => error.status === 404,
    'duplicate_of a foreign transaction',
  );

  const importedB = await importPdf(wsB, [RENT], 'F3');
  await assert.rejects(
    classifyImportedTransaction({
      db: wsA.db, householdId: wsA.workspaceId, importedTransactionId: importedB.items[0].id,
      input: { classification_type: 'transaction', category_id: wsA.categoryId },
    }),
    (error) => error.status === 404,
    'classify a row that belongs to another workspace',
  );
  assert.equal(await countTransactions(wsA.workspaceId), 0);
});

maybeTest('PG: CSV approve imports identical rows, and an overlapping CSV on the same account is not duplicated', async () => {
  const ws = await makeWorkspace('csv-identity');
  const accountId = await ws.makeAccount('Checking');
  const columnMap = { columnMap: { date: 'Date', description: 'Description', amount: 'Amount', direction: 'Direction' } };

  async function runCsv(text) {
    const batch = await uploadImportBatch({ db: ws.db, householdId: ws.workspaceId, input: { filename: 'x.csv', text, accountId } });
    const parsed = await parseImportBatch({ db: ws.db, householdId: ws.workspaceId, batchId: batch.batchId, input: columnMap });
    for (const row of parsed.rows) {
      if (row.status === 'pending') {
        await updateImportedRow({ db: ws.db, householdId: ws.workspaceId, rowId: row.id, input: { status: 'approved', categoryId: ws.categoryId } });
      }
    }
    return { batch, parsed, approved: await approveImportBatch({ db: ws.db, householdId: ws.workspaceId, batchId: batch.batchId }) };
  }

  const first = await runCsv('Date,Description,Amount,Direction\n2026-01-15,COFFEE SHOP,5.00,debit\n2026-01-15,COFFEE SHOP,5.00,debit');
  assert.equal(first.approved.inserted, 2);
  assert.equal(await countTransactions(ws.workspaceId, 'COFFEE'), 2);

  const second = await runCsv('Date,Description,Amount,Direction\n2026-01-15,COFFEE SHOP,5.00,debit\n2026-01-15,COFFEE SHOP,5.00,debit\n2026-01-16,BOOKSTORE,30.00,debit');
  const statuses = second.parsed.rows.map((row) => row.status).sort();
  assert.deepEqual(statuses, ['duplicate', 'duplicate', 'pending']);
  assert.equal(second.approved.inserted, 1);
  assert.equal(second.approved.duplicates, 2);
  assert.equal(await countTransactions(ws.workspaceId), 3);
});

maybeTest('PG: a PDF row that overlaps an already-approved CSV row on the same account is an exact duplicate', async () => {
  const ws = await makeWorkspace('csv-pdf');
  const accountId = await ws.makeAccount('Checking');
  const batch = await uploadImportBatch({
    db: ws.db, householdId: ws.workspaceId,
    input: { filename: 'c.csv', text: 'Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit', accountId },
  });
  const parsed = await parseImportBatch({
    db: ws.db, householdId: ws.workspaceId, batchId: batch.batchId,
    input: { columnMap: { date: 'Date', description: 'Description', amount: 'Amount', direction: 'Direction' } },
  });
  await updateImportedRow({ db: ws.db, householdId: ws.workspaceId, rowId: parsed.rows[0].id, input: { status: 'approved', categoryId: ws.categoryId } });
  await approveImportBatch({ db: ws.db, householdId: ws.workspaceId, batchId: batch.batchId });

  const pdfImport = await importPdf(ws, [BOOK], 'CP', accountId);
  assert.equal(pdfImport.items[0].duplicate_state, 'exact');
  await assert.rejects(classifyAsTransaction(ws, pdfImport.items[0].id), (error) => error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE');
  assert.equal(await countTransactions(ws.workspaceId), 1);
});

maybeTest('PG: unprocess releases the event so the row can be classified again, exactly once', async () => {
  const ws = await makeWorkspace('unprocess');
  const accountId = await ws.makeAccount('Checking');
  const imported = await importPdf(ws, [BOOK], 'U1', accountId);
  const rowId = imported.items[0].id;

  await classifyAsTransaction(ws, rowId);
  assert.equal(await countTransactions(ws.workspaceId), 1);
  await unprocessImportedTransaction({ db: ws.db, householdId: ws.workspaceId, importedTransactionId: rowId });
  assert.equal(await countTransactions(ws.workspaceId), 0);
  assert.equal(await countClaims(ws.workspaceId), 0);

  await classifyAsTransaction(ws, rowId);
  assert.equal(await countTransactions(ws.workspaceId), 1);
  assert.equal(await countClaims(ws.workspaceId), 1);
});

maybeTest('PG: unprocessing a row reconciled to a manual transaction never deletes the manual transaction', async () => {
  const ws = await makeWorkspace('unprocess-manual');
  const accountId = await ws.makeAccount('Checking');
  const manualId = await ws.db.transaction(async (tx) => (await tx.insertTransaction({
    householdId: ws.workspaceId, transactionDate: '2026-01-20', description: 'Bookstore',
    amount: '30.00', direction: 'debit', source: 'manual', accountId,
  })).id);
  const imported = await importPdf(ws, [BOOK], 'UM', accountId);
  const rowId = imported.items[0].id;

  await classifyImportedTransaction({
    db: ws.db, householdId: ws.workspaceId, importedTransactionId: rowId,
    input: { classification_type: 'duplicate', duplicate_of_transaction_id: manualId },
  });
  await unprocessImportedTransaction({ db: ws.db, householdId: ws.workspaceId, importedTransactionId: rowId });

  assert.equal(await countTransactions(ws.workspaceId), 1, 'the manual transaction is untouched');
  assert.equal(await countClaims(ws.workspaceId), 0, 'the reconciliation claim is released');
});

maybeTest('PG: income imports are protected by the same event claims, including the claim foreign key to income entries', async () => {
  const ws = await makeWorkspace('income-identity');
  const accountId = await ws.makeAccount('Checking');
  const payroll = '2026-01-25 PAYROLL 2000.00 3000.00';
  const income = (rowId) => classifyImportedTransaction({
    db: ws.db, householdId: ws.workspaceId, importedTransactionId: rowId, input: { classification_type: 'income' },
  });
  const countIncome = async () => (await adminPool.query('SELECT count(*)::int AS n FROM raf.income_entries WHERE workspace_id = $1', [ws.workspaceId])).rows[0].n;

  const a = await importPdf(ws, [payroll], 'I1', accountId);
  await income(a.items[0].id);
  assert.equal(await countIncome(), 1);
  assert.equal(await countClaims(ws.workspaceId), 1);

  const b = await importPdf(ws, [payroll, RENT], 'I2', accountId);
  const dup = b.items.find((item) => /PAYROLL/.test(item.description));
  assert.equal(dup.duplicate_state, 'exact');
  await assert.rejects(income(dup.id), (error) => error.details?.errorCode === 'IMPORT_EXACT_DUPLICATE');
  assert.equal(await countIncome(), 1);

  const entry = await adminPool.query('SELECT id FROM raf.income_entries WHERE workspace_id = $1', [ws.workspaceId]);
  await adminPool.query('DELETE FROM raf.income_entries WHERE id = $1', [entry.rows[0].id]);
  assert.equal(await countClaims(ws.workspaceId), 0, 'claim cascades with the income entry');
});

maybeTest('PG: concurrent approval of two overlapping CSV batches creates the shared event once', async () => {
  const ws = await makeWorkspace('csv-concurrent');
  const accountId = await ws.makeAccount('Checking');
  const columnMap = { columnMap: { date: 'Date', description: 'Description', amount: 'Amount', direction: 'Direction' } };
  const prepare = async (text) => {
    const batch = await uploadImportBatch({ db: ws.db, householdId: ws.workspaceId, input: { filename: 'x.csv', text, accountId } });
    const parsed = await parseImportBatch({ db: ws.db, householdId: ws.workspaceId, batchId: batch.batchId, input: columnMap });
    for (const row of parsed.rows) {
      await updateImportedRow({ db: ws.db, householdId: ws.workspaceId, rowId: row.id, input: { status: 'approved', categoryId: ws.categoryId } });
    }
    return batch.batchId;
  };
  const one = await prepare('Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit\n2026-01-21,PHARMACY,12.00,debit');
  const two = await prepare('Date,Description,Amount,Direction\n2026-01-20,BOOKSTORE,30.00,debit\n2026-01-22,GYM,40.00,debit\n');

  const results = await Promise.allSettled([
    approveImportBatch({ db: ws.db, householdId: ws.workspaceId, batchId: one }),
    approveImportBatch({ db: ws.db, householdId: ws.workspaceId, batchId: two }),
  ]);
  assert.ok(results.every((result) => result.status === 'fulfilled'), JSON.stringify(results.map((r) => r.reason?.message)));
  assert.equal(await countTransactions(ws.workspaceId, 'BOOKSTORE'), 1);
  assert.equal(await countTransactions(ws.workspaceId), 3);
});
