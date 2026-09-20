import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { uploadImportBatch } from '../lib/imports/uploadImportBatch.js';
import { parseImportBatch } from '../lib/imports/parseImportBatch.js';
import { approveImportBatch } from '../lib/imports/approveImportBatch.js';
import { reviewImportBatch } from '../lib/imports/reviewImportBatch.js';
import { updateImportedRow } from '../lib/imports/updateImportedRow.js';
import { classifyImportedTransaction } from '../lib/imports/reviewImportedTransactions.js';

const HOUSEHOLD_ID = 'household_p5_import';
const HOUSEHOLD_B = 'household_p5_import_b';

const COLUMN_MAP = {
  columnMap: {
    date: 'Date',
    description: 'Description',
    amount: 'Amount',
    direction: 'Direction',
  },
};

function makeCsv(rows) {
  return [
    'Date,Description,Amount,Direction',
    ...rows.map((r) => `${r.date},${r.description},${r.amount},${r.dir ?? 'debit'}`),
  ].join('\n');
}

async function uploadAndParse(db, householdId, csvRows, accountId = null) {
  const csv = makeCsv(csvRows);
  const batch = await uploadImportBatch({
    db,
    householdId,
    input: { filename: 'test.csv', text: csv, accountId },
  });
  await parseImportBatch({ db, householdId, batchId: batch.batchId, input: COLUMN_MAP });
  return batch.batchId;
}

async function approveAllPendingRows(db, householdId, batchId, categoryId = 'cat_spending') {
  const review = await reviewImportBatch({ db, householdId, batchId });
  for (const row of review.rows) {
    if (row.status === 'pending') {
      await updateImportedRow({ db, householdId, rowId: row.id, input: { status: 'approved', categoryId } });
    }
  }
  return approveImportBatch({ db, householdId, batchId });
}

async function insertPdfTx(db, householdId, fields = {}) {
  return db.transaction(async (tx) => {
    const rows = await tx.insertImportedTransactions({
      householdId,
      rows: [{
        householdId,
        date: fields.date ?? '2026-01-15',
        description: fields.description ?? 'Coffee Shop',
        amount: fields.amount ?? '5.00',
        currency: 'CAD',
        source: 'bank_import',
        rawDescription: fields.description ?? 'Coffee Shop',
        referenceNumber: null,
        balanceAfterTransaction: null,
        status: 'unreviewed',
        classificationType: null,
        linkedTransactionId: null,
        linkedDebtId: null,
        linkedFixedBillId: null,
        reviewedAt: null,
        reviewNote: null,
        normalizedDescription: (fields.description ?? 'Coffee Shop').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
        linkedIncomeEntryId: null,
        linkedGoalId: null,
      }],
    });
    return rows[0];
  });
}

// ─── Section 1: CSV End-to-End ───────────────────────────────────────────────

test('1.1 — CSV upload creates batch with uploaded status', async () => {
  const db = createInMemoryDb();
  const csv = makeCsv([{ date: '2026-01-15', description: 'Grocery Store', amount: '50.00' }]);
  const batch = await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'test.csv', text: csv } });

  assert.ok(batch.batchId, 'batch has batchId');
  assert.ok(batch.filename, 'batch has filename');
});

test('1.2 — parseImportBatch transitions batch to review with parsed rows', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-01-15', description: 'Grocery Store', amount: '50.00' },
  ]);

  const review = await reviewImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  assert.strictEqual(review.status, 'review');
  assert.strictEqual(review.rows.length, 1);
  assert.strictEqual(review.rows[0].parsedDate, '2026-01-15');
  assert.strictEqual(review.rows[0].parsedAmount, '50.00');
  assert.strictEqual(review.rows[0].status, 'pending');
});

test('1.3 — approveImportBatch creates one transaction per approved row', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-01-15', description: 'Grocery Store', amount: '50.00' },
    { date: '2026-01-16', description: 'Coffee Shop', amount: '5.00' },
  ]);

  const result = await approveAllPendingRows(db, HOUSEHOLD_ID, batchId);
  assert.strictEqual(result.inserted, 2);
  assert.strictEqual(result.duplicates, 0);
  assert.strictEqual(result.skipped, 0);
});

// ─── Section 2: Duplicate Detection ─────────────────────────────────────────

test('2.1 — Within-batch fingerprint: identical approved rows → second is skipped', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-01-15', description: 'Gym Membership', amount: '75.00' },
    { date: '2026-01-15', description: 'Gym Membership', amount: '75.00' },
  ]);

  // Both rows are pending; mark both approved with same categoryId → same fingerprint
  const review = await reviewImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  for (const row of review.rows) {
    await updateImportedRow({ db, householdId: HOUSEHOLD_ID, rowId: row.id, input: { status: 'approved', categoryId: 'cat_spending' } });
  }

  const result = await approveImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  assert.strictEqual(result.inserted, 1, 'First occurrence inserted');
  assert.strictEqual(result.skipped, 1, 'Second occurrence skipped (fingerprint duplicate)');
  assert.strictEqual(result.duplicates, 0, 'Not a status=duplicate row, just skipped');
});

test('2.2 — Same-batch near-duplicate with different amounts: both inserted', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-01-15', description: 'Coffee Shop', amount: '4.50' },
    { date: '2026-01-15', description: 'Coffee Shop', amount: '5.25' },
  ]);

  const result = await approveAllPendingRows(db, HOUSEHOLD_ID, batchId);
  assert.strictEqual(result.inserted, 2, 'Different amounts → different fingerprints → both inserted');
  assert.strictEqual(result.skipped, 0);
});

test('2.3 — Legitimate identical transactions (different dates): both inserted', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-01-01', description: 'Netflix', amount: '17.99' },
    { date: '2026-02-01', description: 'Netflix', amount: '17.99' },
  ]);

  const result = await approveAllPendingRows(db, HOUSEHOLD_ID, batchId);
  assert.strictEqual(result.inserted, 2, 'Different dates → different fingerprints → both inserted');
});

test('2.4 — Cross-import duplicate: existing transaction triggers status=duplicate during parse', async () => {
  const db = createInMemoryDb();

  // First: insert an existing transaction with matching date+amount+no-merchant
  // (findDuplicateTransaction fingerprints on householdId+date+amount+merchant;
  //  CSV rows without a merchant column parse to normalizedMerchant='', so the
  //  pre-inserted transaction must also have merchant=null to produce a match)
  await db.transaction(async (tx) => {
    await tx.insertTransaction({
      householdId: HOUSEHOLD_ID,
      transactionDate: '2026-01-20',
      description: 'Pharmacy',
      merchant: null,
      amount: '25.00',
      direction: 'debit',
      categoryId: null,
      source: 'manual',
    });
  });

  // Now import a CSV row that matches the existing transaction
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-01-20', description: 'Pharmacy', amount: '25.00' },
  ]);

  const review = await reviewImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  // The row should have been marked 'duplicate' during parse (findDuplicateTransaction matched)
  assert.strictEqual(review.rows[0].status, 'duplicate', 'Row marked duplicate: matches existing transaction');

  const result = await approveImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  assert.strictEqual(result.inserted, 0, 'No new transaction inserted for duplicate row');
  assert.strictEqual(result.duplicates, 1, 'Duplicate counted');
});

// ─── Section 3: Idempotent Re-Approval ──────────────────────────────────────

test('3.1 — Re-approving an already-approved batch returns alreadyApproved=true without re-inserting', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-02-10', description: 'Utility Bill', amount: '120.00' },
  ]);

  await approveAllPendingRows(db, HOUSEHOLD_ID, batchId);

  // Second approval attempt
  const second = await approveImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  assert.strictEqual(second.alreadyApproved, true, 'Idempotent: returns alreadyApproved flag');

  // Verify no duplicate transactions were created
  const txns = await db.transaction(async (tx) => tx.listTransactions({
    householdId: HOUSEHOLD_ID,
    from: '0001-01-01',
    to: '9999-12-31',
  }));
  const allTxns = Array.isArray(txns) ? txns : txns?.items ?? [];
  assert.strictEqual(allTxns.length, 1, 'Exactly one transaction; no duplicate created on re-approval');
});

// ─── Section 4: Row Status Filtering ─────────────────────────────────────────

test('4.1 — Only approved rows become transactions; pending and duplicate rows are skipped', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-03-01', description: 'Row A', amount: '10.00' },
    { date: '2026-03-02', description: 'Row B', amount: '20.00' },
    { date: '2026-03-03', description: 'Row C', amount: '30.00' },
  ]);

  const review = await reviewImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  const [rowA, rowB, rowC] = review.rows;

  // Approve row A, mark row B as duplicate, leave row C as pending
  await updateImportedRow({ db, householdId: HOUSEHOLD_ID, rowId: rowA.id, input: { status: 'approved', categoryId: 'cat_spending' } });
  await updateImportedRow({ db, householdId: HOUSEHOLD_ID, rowId: rowB.id, input: { status: 'duplicate' } });
  // rowC stays pending

  const result = await approveImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  assert.strictEqual(result.inserted, 1, 'Only row A inserted');
  assert.strictEqual(result.duplicates, 1, 'Row B counted as duplicate');
  assert.strictEqual(result.skipped, 1, 'Row C (pending) skipped');
});

// ─── Section 5: Field Fidelity ────────────────────────────────────────────────

test('5.1 — Approved row fields map correctly to authoritative transaction', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-04-05', description: 'Insurance Premium', amount: '200.00', dir: 'debit' },
  ]);

  await approveAllPendingRows(db, HOUSEHOLD_ID, batchId, 'cat_fixed_bills');

  const txns = await db.transaction(async (tx) => tx.listTransactions({
    householdId: HOUSEHOLD_ID,
    from: '0001-01-01',
    to: '9999-12-31',
  }));
  const allTxns = Array.isArray(txns) ? txns : txns?.items ?? [];
  assert.strictEqual(allTxns.length, 1);
  const tx = allTxns[0];

  assert.strictEqual(tx.transactionDate, '2026-04-05', 'transactionDate from parsed date');
  assert.strictEqual(tx.amount, '200.00', 'amount from parsed amount');
  assert.strictEqual(tx.direction, 'debit', 'direction from parsed direction');
  assert.strictEqual(tx.description, 'Insurance Premium', 'description from parsed description');
  assert.strictEqual(tx.categoryId, 'cat_fixed_bills', 'categoryId from suggestedCategoryId');
  assert.strictEqual(tx.source, 'import', 'source marked as import');
});

// ─── Section 6: Financial Conservation ───────────────────────────────────────

test('6.1 — Import financial conservation: transaction amounts equal approved row amounts', async () => {
  const db = createInMemoryDb();
  const csvRows = [
    { date: '2026-05-01', description: 'Rent', amount: '1500.00' },
    { date: '2026-05-02', description: 'Groceries', amount: '85.50' },
    { date: '2026-05-03', description: 'Transit', amount: '3.25' },
  ];
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, csvRows);
  await approveAllPendingRows(db, HOUSEHOLD_ID, batchId);

  const txns = await db.transaction(async (tx) => tx.listTransactions({
    householdId: HOUSEHOLD_ID,
    from: '0001-01-01',
    to: '9999-12-31',
  }));
  const allTxns = Array.isArray(txns) ? txns : txns?.items ?? [];
  assert.strictEqual(allTxns.length, 3, '3 transactions created');

  const amounts = allTxns.map((t) => t.amount).sort();
  assert.deepStrictEqual(amounts, ['1500.00', '3.25', '85.50'].sort(), 'All row amounts preserved exactly');
});

// ─── Section 7: Cross-Tenant Import Isolation ─────────────────────────────────

test('7.1 — Import batch in household A not accessible from household B', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-06-01', description: 'Private Purchase', amount: '999.00' },
  ]);

  // Household B tries to read household A's batch
  const reviewB = await reviewImportBatch({ db, householdId: HOUSEHOLD_B, batchId }).catch((e) => e);
  assert.ok(
    reviewB instanceof Error || (reviewB && reviewB.status === 404),
    'Household B cannot access household A batch — SECURITY_DEFECT if this passes without error',
  );
});

test('7.2 — Transactions from household A import not visible in household B', async () => {
  const db = createInMemoryDb();
  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-06-10', description: 'Rent A', amount: '800.00' },
  ]);
  await approveAllPendingRows(db, HOUSEHOLD_ID, batchId);

  const txnsB = await db.transaction(async (tx) => tx.listTransactions({
    householdId: HOUSEHOLD_B,
    from: '0001-01-01',
    to: '9999-12-31',
  }));
  const allTxnsB = Array.isArray(txnsB) ? txnsB : txnsB?.items ?? [];
  assert.strictEqual(allTxnsB.length, 0, 'SECURITY_DEFECT: household A transactions must not appear in household B');
});

// ─── Section 8: PDF Path — Import Classification ──────────────────────────────

test('8.1 — PDF path: classify as ignore → status=ignored, no authoritative transaction', async () => {
  const db = createInMemoryDb();
  const row = await insertPdfTx(db, HOUSEHOLD_ID, { description: 'Balance Forward' });

  await classifyImportedTransaction({
    db,
    householdId: HOUSEHOLD_ID,
    importedTransactionId: row.id,
    input: { classificationType: 'ignore' },
  });

  const updated = await db.transaction(async (tx) => tx.getImportedTransactionById({
    householdId: HOUSEHOLD_ID,
    importedTransactionId: row.id,
  }));
  assert.strictEqual(updated.classificationType, 'ignore', 'classificationType set to ignore');
  assert.strictEqual(updated.linkedTransactionId, null, 'No authoritative transaction created');
});

test('8.2 — PDF path: classify as duplicate → classificationType=duplicate, no authoritative transaction', async () => {
  const db = createInMemoryDb();
  const row = await insertPdfTx(db, HOUSEHOLD_ID, { description: 'Already Recorded' });

  await classifyImportedTransaction({
    db,
    householdId: HOUSEHOLD_ID,
    importedTransactionId: row.id,
    input: { classificationType: 'duplicate' },
  });

  const updated = await db.transaction(async (tx) => tx.getImportedTransactionById({
    householdId: HOUSEHOLD_ID,
    importedTransactionId: row.id,
  }));
  assert.strictEqual(updated.classificationType, 'duplicate');
  assert.strictEqual(updated.linkedTransactionId, null, 'Duplicate classification: no transaction created');
});

test('8.3 — PDF path: classify as transfer → classificationType=transfer, no authoritative transaction', async () => {
  const db = createInMemoryDb();
  const row = await insertPdfTx(db, HOUSEHOLD_ID, { description: 'Transfer to Savings' });

  await classifyImportedTransaction({
    db,
    householdId: HOUSEHOLD_ID,
    importedTransactionId: row.id,
    input: { classificationType: 'transfer' },
  });

  const updated = await db.transaction(async (tx) => tx.getImportedTransactionById({
    householdId: HOUSEHOLD_ID,
    importedTransactionId: row.id,
  }));
  assert.strictEqual(updated.classificationType, 'transfer');
  assert.strictEqual(updated.linkedTransactionId, null, 'Transfer classification: no transaction created');
});

// ─── Section 9: PDF Path — Cross-Tenant Isolation ────────────────────────────

test('9.1 — PDF path: importedTransactions from household A not visible to household B', async () => {
  const db = createInMemoryDb();

  await insertPdfTx(db, HOUSEHOLD_ID, { description: 'Confidential Purchase A' });
  await insertPdfTx(db, HOUSEHOLD_ID, { description: 'Salary Deposit A' });

  const resultB = await db.transaction(async (tx) => tx.listImportedTransactions({ householdId: HOUSEHOLD_B }));
  assert.strictEqual(resultB.length, 0, 'SECURITY_DEFECT: household A PDF imports must not appear in household B');
});

test('9.2 — PDF path: classifyImportedTransaction rejects cross-tenant access', async () => {
  const db = createInMemoryDb();
  const row = await insertPdfTx(db, HOUSEHOLD_ID, { description: 'Payroll' });

  // Household B tries to classify household A's importedTransaction
  const err = await classifyImportedTransaction({
    db,
    householdId: HOUSEHOLD_B,
    importedTransactionId: row.id,
    input: { classificationType: 'ignore' },
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Cross-tenant classify must throw — SECURITY_DEFECT if it succeeds');
});

// ─── Section 10: CSV Malformed Input ─────────────────────────────────────────

test('10.1 — parseImportBatch throws on row with invalid date format', async () => {
  const db = createInMemoryDb();
  const csv = 'Date,Description,Amount,Direction\nnot-a-date,Grocery Store,50.00,debit';
  const batch = await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'bad.csv', text: csv } });

  const err = await parseImportBatch({
    db,
    householdId: HOUSEHOLD_ID,
    batchId: batch.batchId,
    input: COLUMN_MAP,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Invalid date should cause parseImportBatch to throw');
});

test('10.2 — parseImportBatch throws on row with invalid amount', async () => {
  const db = createInMemoryDb();
  const csv = 'Date,Description,Amount,Direction\n2026-01-01,Test,not-money,debit';
  const batch = await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'bad.csv', text: csv } });

  const err = await parseImportBatch({
    db,
    householdId: HOUSEHOLD_ID,
    batchId: batch.batchId,
    input: COLUMN_MAP,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Invalid amount should cause parseImportBatch to throw');
});

// ─── Section 11: Account-Scoped Duplicate Detection ──────────────────────────

test('11.1 — Same merchant/date/amount on different accounts: duplicate detection scope is household (not account)', async () => {
  // findDuplicateTransaction fingerprints on householdId+date+amount+merchant without accountId.
  // This test documents the current behavior so any future change is explicit.
  //
  // The two CSV files have distinct content (different header rows) so they get different
  // file hashes and both uploads proceed. This isolates the content-similarity dedup from
  // the file-level idempotency check.
  const db = createInMemoryDb();

  // First file: standard header + transaction
  const csv1 = 'Date,Description,Amount,Direction\n2026-08-14,Amazon,84.22,debit';
  const batchAResult = await uploadImportBatch({
    db, householdId: HOUSEHOLD_ID,
    input: { filename: 'account_a.csv', text: csv1 },
  });
  const batchA = batchAResult.batchId;
  await parseImportBatch({ db, householdId: HOUSEHOLD_ID, batchId: batchA, input: COLUMN_MAP });
  await approveAllPendingRows(db, HOUSEHOLD_ID, batchA);

  // Second file: same transaction data but different file bytes (trailing newline → different hash)
  // Simulates same bank transaction appearing in a second account's export.
  const csv2 = 'Date,Description,Amount,Direction\n2026-08-14,Amazon,84.22,debit\n';
  const batchBResult = await uploadImportBatch({
    db, householdId: HOUSEHOLD_ID,
    input: { filename: 'account_b.csv', text: csv2 },
  });
  const batchB = batchBResult.batchId;
  await parseImportBatch({ db, householdId: HOUSEHOLD_ID, batchId: batchB, input: COLUMN_MAP });

  const reviewB = await reviewImportBatch({ db, householdId: HOUSEHOLD_ID, batchId: batchB });
  // Document actual behavior: row is marked duplicate (household-level fingerprint, not account-level)
  assert.strictEqual(
    reviewB.rows[0].status,
    'duplicate',
    'Current behavior: household-level findDuplicateTransaction treats same tx as duplicate across accounts. ' +
    'If account-scoped semantics are intended, this test will flag the regression.',
  );
});

// ─── Section 12: File-Level Import Idempotency ───────────────────────────────

test('12.1 — Same file uploaded twice: second upload rejected with 409', async () => {
  const db = createInMemoryDb();
  const csv = makeCsv([{ date: '2026-09-01', description: 'Groceries', amount: '62.50' }]);

  await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'sep.csv', text: csv } });

  const err = await uploadImportBatch({
    db,
    householdId: HOUSEHOLD_ID,
    input: { filename: 'sep.csv', text: csv },
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'duplicate upload must throw');
  assert.strictEqual(err.status, 409, 'duplicate file upload must return HTTP 409');
});

test('12.2 — Same content, different filename: second upload still rejected (hash is content-based)', async () => {
  const db = createInMemoryDb();
  const csv = makeCsv([{ date: '2026-09-01', description: 'Groceries', amount: '62.50' }]);

  await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'original.csv', text: csv } });

  const err = await uploadImportBatch({
    db,
    householdId: HOUSEHOLD_ID,
    input: { filename: 'renamed_copy.csv', text: csv },
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'same content with different filename must throw');
  assert.strictEqual(err.status, 409, 'content-identical file must be rejected regardless of name');
});

test('12.3 — Different content, same filename: both uploads proceed', async () => {
  const db = createInMemoryDb();
  const csv1 = makeCsv([{ date: '2026-09-01', description: 'Groceries', amount: '62.50' }]);
  const csv2 = makeCsv([{ date: '2026-09-15', description: 'Rent', amount: '1500.00' }]);

  const b1 = await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'stmt.csv', text: csv1 } });
  const b2 = await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'stmt.csv', text: csv2 } });

  assert.ok(b1.batchId, 'first batch created');
  assert.ok(b2.batchId, 'second batch created');
  assert.notStrictEqual(b1.batchId, b2.batchId, 'different content produces separate batches');
});

test('12.4 — Same file in different workspaces: both proceed independently', async () => {
  const db = createInMemoryDb();
  const csv = makeCsv([{ date: '2026-09-01', description: 'Groceries', amount: '62.50' }]);

  const b1 = await uploadImportBatch({ db, householdId: HOUSEHOLD_ID, input: { filename: 'sep.csv', text: csv } });
  const b2 = await uploadImportBatch({ db, householdId: HOUSEHOLD_B, input: { filename: 'sep.csv', text: csv } });

  assert.ok(b1.batchId, 'workspace A batch created');
  assert.ok(b2.batchId, 'workspace B batch created');
  assert.notStrictEqual(b1.batchId, b2.batchId, 'file-level uniqueness is workspace-scoped; cross-workspace same file is allowed');
});

test('12.5 — Legitimate identical-looking transactions in same file: file-level dedup does not suppress them', async () => {
  // Two coffee purchases, same date, same merchant, same amount — appearing twice in the same CSV.
  // The file-hash idempotency constraint prevents re-uploading the file, but it cannot and
  // should not suppress rows that exist within a single upload.
  //
  // Separate authority: the approval-time in-memory fingerprint (buildImportRowFingerprint)
  // will still suppress the second row when both are approved with the SAME category, because
  // that mechanism deduplicates within a single approval pass. To get two canonical transactions,
  // the user must assign different categories — which is the correct UX prompt for economically
  // identical-looking rows.
  const db = createInMemoryDb();

  const batchId = await uploadAndParse(db, HOUSEHOLD_ID, [
    { date: '2026-09-10', description: 'Coffee Shop', amount: '5.00' },
    { date: '2026-09-10', description: 'Coffee Shop', amount: '5.00' },
  ]);

  // Both rows reach review stage (file-level dedup has no effect here)
  const review = await reviewImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });
  assert.strictEqual(review.rows.length, 2, 'both rows present in review — file-level dedup does not suppress intra-file rows');
  assert.ok(
    review.rows.every((r) => r.status === 'pending'),
    'both rows are pending, not suppressed by file-level idempotency',
  );

  // Approve with different categories so approval-time fingerprints differ → two transactions
  await updateImportedRow({ db, householdId: HOUSEHOLD_ID, rowId: review.rows[0].id, input: { status: 'approved', categoryId: 'cat_dining' } });
  await updateImportedRow({ db, householdId: HOUSEHOLD_ID, rowId: review.rows[1].id, input: { status: 'approved', categoryId: 'cat_groceries' } });
  const result = await approveImportBatch({ db, householdId: HOUSEHOLD_ID, batchId });

  assert.strictEqual(result.inserted, 2, 'two transactions created when categories differ — distinct approval-time fingerprints');
});
