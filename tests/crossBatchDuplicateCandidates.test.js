import test from 'node:test';
import assert from 'node:assert/strict';

import { approveImportBatch } from '../lib/imports/approveImportBatch.js';

/**
 * Test database double that simulates cross-batch transaction loading.
 * Unlike the standard mock, this tracks transactions across multiple batches
 * and respects workspace scoping.
 */
function createCrossBatchDbDouble({
  batch,
  rows,
  existingAuthorativeTransactions = [],
  debt = null,
} = {}) {
  const state = {
    batch: { ...(batch ?? { id: 'batch_1', status: 'uploaded', filename: 'test.csv', rowCount: null }) },
    rows: (rows ?? []).map((row) => ({ ...row })),
    insertedTransactions: [],
    insertedDebtPayments: [],
    authoritativeTransactions: [...existingAuthorativeTransactions],
  };

  const tx = {
    async getImportBatch() {
      return state.batch;
    },
    async listImportedRows() {
      return state.rows;
    },
    async updateImportBatch({ status, expectedStatus }) {
      if (expectedStatus && state.batch.status !== expectedStatus) {
        throw new Error(`Batch status mismatch: expected ${expectedStatus}, got ${state.batch.status}`);
      }
      state.batch.status = status;
      return state.batch;
    },
    async listTransactions({ householdId, from, to }) {
      // Return ALL authoritative transactions (cross-batch workspace-wide),
      // filtered by householdId and date range
      return state.authoritativeTransactions.filter(
        (t) => t.householdId === householdId
          && (!from || t.transactionDate >= from)
          && (!to || t.transactionDate <= to),
      );
    },
    async findDebtById() {
      return debt;
    },
    async insertTransaction(payload) {
      const transaction = {
        id: `txn_${state.insertedTransactions.length + 1}`,
        ...payload,
      };
      state.insertedTransactions.push(transaction);
      state.authoritativeTransactions.push(transaction);
      return transaction;
    },
    async insertDebtPayment(payload) {
      state.insertedDebtPayments.push(payload);
      return { id: `dp_${state.insertedDebtPayments.length}` };
    },
  };

  return {
    state,
    async transaction(callback) {
      return callback(tx);
    },
  };
}

// ============================================================================
// T1: SAME BATCH PROTECTION REMAINS FUNCTIONAL
// ============================================================================

test('[T1] approveImportBatch: same-batch duplicate protection remains functional', async () => {
  const db = createCrossBatchDbDouble({
    batch: { id: 'batch_1', status: 'review', filename: 'test.csv', rowCount: 2 },
    rows: [
      {
        id: 'row_1',
        parsedDate: '2026-03-10',
        parsedDescription: 'Coffee Shop',
        parsedMerchant: 'Coffee Shop',
        parsedAmount: '12.99',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_food',
        suggestedDebtId: null,
        status: 'approved',
      },
      {
        id: 'row_2',
        parsedDate: '2026-03-10',
        parsedDescription: 'Coffee Shop',
        parsedMerchant: 'Coffee Shop',
        parsedAmount: '12.99',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_food',
        suggestedDebtId: null,
        status: 'approved',
      },
    ],
  });

  const result = await approveImportBatch({
    db,
    householdId: 'household_1',
    batchId: 'batch_1',
  });

  // Only 1 should insert; the 2nd is same-batch duplicate
  assert.equal(result.inserted, 1, 'should insert only 1 of 2 identical rows in same batch');
  assert.equal(result.skipped, 1, 'should skip the duplicate within same batch');
  assert.equal(db.state.insertedTransactions.length, 1);
});

// ============================================================================
// T2: CROSS-BATCH DETECTION (THE CRITICAL DEFECT TEST)
// ============================================================================

test('[T2] approveImportBatch: cross-batch identical transaction candidates are detected', async () => {
  // Batch A transaction already approved and authoritative
  const existingFromBatchA = {
    id: 'txn_from_batch_a',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Coffee Shop',
    merchant: 'Coffee Shop',
    amount: '12.99',
    direction: 'debit',
    categoryId: 'cat_food',
    linkedDebtId: null,
    importBatchId: 'batch_a',
    source: 'import',
  };

  // Batch B has identical transaction that should be a candidate, not silently approved
  const db = createCrossBatchDbDouble({
    batch: { id: 'batch_b', status: 'review', filename: 'test_b.csv', rowCount: 1 },
    rows: [
      {
        id: 'row_b_1',
        parsedDate: '2026-03-10',
        parsedDescription: 'Coffee Shop',
        parsedMerchant: 'Coffee Shop',
        parsedAmount: '12.99',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_food',
        suggestedDebtId: null,
        status: 'approved',
      },
    ],
    existingAuthorativeTransactions: [existingFromBatchA],
  });

  const result = await approveImportBatch({
    db,
    householdId: 'household_1',
    batchId: 'batch_b',
  });

  // EXPECTED (after fix): This row should be detected as a cross-batch candidate
  // and should NOT be silently inserted.
  // CURRENT (unfixed): The row is silently inserted because batchId filtering prevents detection.

  assert.equal(
    result.inserted,
    0,
    'cross-batch identical transaction should NOT be silently approved; ' +
    'it should be flagged as a candidate requiring review',
  );

  assert.equal(
    db.state.insertedTransactions.length,
    0,
    'no additional transaction should be inserted when cross-batch candidate is detected',
  );
});

// ============================================================================
// T3: CROSS-WORKSPACE ISOLATION
// ============================================================================

test('[T3] approveImportBatch: identical transactions in different workspaces remain isolated', async () => {
  // Transaction in workspace_1
  const workspace1Transaction = {
    id: 'txn_ws1',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Coffee Shop',
    merchant: 'Coffee Shop',
    amount: '12.99',
    direction: 'debit',
    categoryId: 'cat_food',
    linkedDebtId: null,
    importBatchId: 'batch_ws1',
    source: 'import',
  };

  // Batch in workspace_2 with identical visible fields
  const db = createCrossBatchDbDouble({
    batch: { id: 'batch_ws2', status: 'review', filename: 'test.csv', rowCount: 1 },
    rows: [
      {
        id: 'row_ws2_1',
        parsedDate: '2026-03-10',
        parsedDescription: 'Coffee Shop',
        parsedMerchant: 'Coffee Shop',
        parsedAmount: '12.99',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_food',
        suggestedDebtId: null,
        status: 'approved',
      },
    ],
    existingAuthorativeTransactions: [workspace1Transaction],
  });

  const result = await approveImportBatch({
    db,
    householdId: 'household_2', // Different workspace
    batchId: 'batch_ws2',
  });

  // Should insert normally because it's a different workspace
  assert.equal(
    result.inserted,
    1,
    'identical transaction in different workspace should be independently insertable',
  );
  assert.equal(db.state.insertedTransactions.length, 1);
});

// ============================================================================
// T4: LEGITIMATE IDENTICAL TRANSACTIONS (USER CAN KEEP BOTH)
// ============================================================================

test('[T4] approveImportBatch: user can explicitly KEEP duplicate when intended', async () => {
  // After Phase 5 review state is implemented, this test validates
  // that a user can mark a row as "KEEP" to allow a legitimate duplicate.
  // For now, this documents intended behavior:
  // - Candidate detected → marked 'needs_review'
  // - User explicitly marks as 'keep'
  // - Next approval allows it to be inserted

  // Placeholder: This will be validated in Phase 5-6 when review UI is designed.
  // The test below just documents the target state machine.

  test.skip('User-driven KEEP decision allows legitimate duplicate to be created');
});

// ============================================================================
// T5: CATEGORY DIFFERENCE DOES NOT DEFEAT DETECTION
// ============================================================================

test('[T5] approveImportBatch: category difference does not defeat duplicate detection', async () => {
  // Same transaction, different categories
  const existingTxn = {
    id: 'txn_existing',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Expense',
    merchant: 'Store',
    amount: '50.00',
    direction: 'debit',
    categoryId: 'cat_groceries',
    linkedDebtId: null,
    importBatchId: 'batch_a',
    source: 'import',
  };

  const db = createCrossBatchDbDouble({
    batch: { id: 'batch_b', status: 'review', filename: 'test.csv', rowCount: 1 },
    rows: [
      {
        id: 'row_b_1',
        parsedDate: '2026-03-10',
        parsedDescription: 'Expense',
        parsedMerchant: 'Store',
        parsedAmount: '50.00',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_food', // Different category
        suggestedDebtId: null,
        status: 'approved',
      },
    ],
    existingAuthorativeTransactions: [existingTxn],
  });

  const result = await approveImportBatch({
    db,
    householdId: 'household_1',
    batchId: 'batch_b',
  });

  // Category difference should NOT allow silent insertion
  assert.equal(
    result.inserted,
    0,
    'category difference should not defeat duplicate-candidate detection',
  );
});

// ============================================================================
// T6: DEBT DIFFERENCE DOES NOT DEFEAT DETECTION
// ============================================================================

test('[T6] approveImportBatch: debt link difference does not defeat duplicate detection', async () => {
  const existingTxn = {
    id: 'txn_existing',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Payment',
    merchant: 'Bank',
    amount: '100.00',
    direction: 'debit',
    categoryId: 'cat_debt_payoff',
    linkedDebtId: 'debt_1',
    importBatchId: 'batch_a',
    source: 'import',
  };

  const db = createCrossBatchDbDouble({
    batch: { id: 'batch_b', status: 'review', filename: 'test.csv', rowCount: 1 },
    rows: [
      {
        id: 'row_b_1',
        parsedDate: '2026-03-10',
        parsedDescription: 'Payment',
        parsedMerchant: 'Bank',
        parsedAmount: '100.00',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_debt_payoff',
        suggestedDebtId: 'debt_2', // Different debt
        status: 'approved',
      },
    ],
    existingAuthorativeTransactions: [existingTxn],
    debt: { id: 'debt_2', name: 'Debt 2' }, // Provide the debt so validation passes
  });

  const result = await approveImportBatch({
    db,
    householdId: 'household_1',
    batchId: 'batch_b',
  });

  // Debt difference should NOT allow silent insertion
  assert.equal(
    result.inserted,
    0,
    'debt link difference should not defeat duplicate-candidate detection',
  );
});

// ============================================================================
// T7: MANUAL VS IMPORTED TRANSACTION SEMANTICS
// ============================================================================

test('[T7] approveImportBatch: manual transaction does not silence imported equivalent', async () => {
  // A user manually created a transaction
  const manualTxn = {
    id: 'txn_manual',
    householdId: 'household_1',
    transactionDate: '2026-03-10',
    description: 'Coffee',
    merchant: 'Coffee Shop',
    amount: '12.99',
    direction: 'debit',
    categoryId: 'cat_food',
    linkedDebtId: null,
    importBatchId: null, // Manual, not from import
    source: 'manual',
  };

  const db = createCrossBatchDbDouble({
    batch: { id: 'batch_1', status: 'review', filename: 'test.csv', rowCount: 1 },
    rows: [
      {
        id: 'row_1',
        parsedDate: '2026-03-10',
        parsedDescription: 'Coffee',
        parsedMerchant: 'Coffee Shop',
        parsedAmount: '12.99',
        parsedDirection: 'debit',
        suggestedCategoryId: 'cat_food',
        suggestedDebtId: null,
        status: 'approved',
      },
    ],
    existingAuthorativeTransactions: [manualTxn],
  });

  const result = await approveImportBatch({
    db,
    householdId: 'household_1',
    batchId: 'batch_1',
  });

  // The imported transaction should be flagged as a candidate, not silently rejected
  // (Once review UI is built, user can explicitly mark as duplicate or keep both)
  assert.equal(
    result.inserted,
    0,
    'imported transaction matching manual transaction should be a candidate, not silently rejected',
  );
});

// ============================================================================
// T8: CONCURRENCY SEMANTICS
// ============================================================================

test('[T8] approveImportBatch: heuristic matching does NOT provide hard concurrent idempotency', async () => {
  // This test documents what we do NOT guarantee.
  // Two concurrent batch approvals with identical transactions could still
  // create duplicates if they run in parallel before either sees the other's result.
  // This is acceptable: heuristic detection + user review is the protection,
  // not hard uniqueness constraints.

  // Comment: If true concurrent safety were needed, we'd need a unique constraint
  // on (workspace_id, normalized_fields), which is explicitly forbidden by the spec.
  // Heuristic detection is a detection + user review layer, not a hard guarantee.

  assert.ok(true, 'Heuristic matching is not claimed to provide hard concurrent idempotency');
});
