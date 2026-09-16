import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import {
  deriveReviewEligibility,
  markTransactionReviewed,
  markTransactionUnreviewed,
  bulkMarkTransactionsReviewed,
} from '../lib/transactions/transactionReview.js';
import {
  createFinancialAccount,
  createAccountReconciliation,
  resolveAccountReconciliation,
  listAccountReconciliations,
} from '../lib/accounts/accounts.js';
import { uploadImportBatch } from '../lib/imports/uploadImportBatch.js';
import { parseImportBatch } from '../lib/imports/parseImportBatch.js';
import { approveImportBatch } from '../lib/imports/approveImportBatch.js';
import { reviewImportBatch } from '../lib/imports/reviewImportBatch.js';
import { updateImportedRow } from '../lib/imports/updateImportedRow.js';
import { getTransactionSuggestion } from '../lib/transactions/transactionSuggestion.js';
import { updateTransaction } from '../lib/transactions/createTransaction.js';

const HOUSEHOLD_ID = 'household_p5_review';
const HOUSEHOLD_B = 'household_p5_review_b';
const REVIEWER_ID = 'user_p5_reviewer';

async function insertTx(db, householdId, fields = {}) {
  return db.transaction(async (tx) => {
    return tx.insertTransaction({
      householdId,
      transactionDate: fields.date ?? '2026-01-15',
      description: fields.description ?? 'Test Transaction',
      merchant: fields.merchant ?? null,
      amount: fields.amount ?? '50.00',
      direction: fields.direction ?? 'debit',
      categoryId: fields.categoryId ?? null,
      linkedDebtId: fields.linkedDebtId ?? null,
      linkedGoalId: fields.linkedGoalId ?? null,
      source: 'manual',
    });
  });
}

async function createAccount(db, householdId, fields = {}) {
  return createFinancialAccount({
    db,
    householdId,
    input: {
      name: fields.name ?? 'Chequing',
      accountType: 'checking',
      institution: null,
      currentBalance: fields.currentBalance ?? '1000.00',
      isManual: true,
    },
  });
}

// ─── Section 1: deriveReviewEligibility ──────────────────────────────────────

test('1.1 — credit transaction is always eligible for review', () => {
  const { eligible, reasons } = deriveReviewEligibility({
    direction: 'credit',
    categoryId: null,
    linkedDebtId: null,
    linkedGoalId: null,
  });
  assert.strictEqual(eligible, true);
  assert.deepStrictEqual(reasons, []);
});

test('1.2 — debit with categoryId and no splits is eligible', () => {
  const { eligible, reasons } = deriveReviewEligibility({
    direction: 'debit',
    categoryId: 'cat_spending',
    linkedDebtId: null,
    linkedGoalId: null,
  });
  assert.strictEqual(eligible, true);
  assert.deepStrictEqual(reasons, []);
});

test('1.3 — debt-linked debit transaction is eligible', () => {
  const { eligible } = deriveReviewEligibility({
    direction: 'debit',
    categoryId: null,
    linkedDebtId: 'debt_visa',
    linkedGoalId: null,
  });
  assert.strictEqual(eligible, true);
});

test('1.4 — goal-linked transaction is eligible', () => {
  const { eligible } = deriveReviewEligibility({
    direction: 'debit',
    categoryId: 'cat_savings',
    linkedDebtId: null,
    linkedGoalId: 'goal_emergency',
  });
  assert.strictEqual(eligible, true);
});

test('1.5 — debit with no categoryId, no debt, no goal is ineligible', () => {
  const { eligible, reasons } = deriveReviewEligibility({
    direction: 'debit',
    categoryId: null,
    linkedDebtId: null,
    linkedGoalId: null,
  });
  assert.strictEqual(eligible, false);
  assert.ok(reasons.includes('unresolved_category'), 'Reason: unresolved_category');
});

test('1.6 — split with missing categoryId is ineligible', () => {
  const { eligible, reasons } = deriveReviewEligibility(
    { direction: 'debit', amount: '100.00', categoryId: null },
    [
      { categoryId: 'cat_food', amount: '60.00' },
      { categoryId: null, amount: '40.00' }, // missing category
    ],
  );
  assert.strictEqual(eligible, false);
  assert.ok(reasons.includes('unresolved_split'));
});

test('1.7 — split with invalid total is ineligible', () => {
  const { eligible, reasons } = deriveReviewEligibility(
    { direction: 'debit', amount: '100.00', categoryId: null },
    [
      { categoryId: 'cat_food', amount: '60.00' },
      { categoryId: 'cat_other', amount: '30.00' }, // only 90, not 100
    ],
  );
  assert.strictEqual(eligible, false);
  assert.ok(reasons.includes('invalid_split_total'));
});

// ─── Section 2: markTransactionReviewed ──────────────────────────────────────

test('2.1 — markTransactionReviewed sets reviewedAt and reviewedBy', async () => {
  const db = createInMemoryDb();
  const tx = await insertTx(db, HOUSEHOLD_ID, { direction: 'credit' });

  const result = await markTransactionReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: tx.id,
    userId: REVIEWER_ID,
  });

  assert.ok(result.reviewedAt, 'reviewedAt is set');
  assert.strictEqual(result.reviewedBy, REVIEWER_ID, 'reviewedBy set to userId');
});

test('2.2 — markTransactionReviewed does not change financial fields', async () => {
  const db = createInMemoryDb();
  const tx = await insertTx(db, HOUSEHOLD_ID, {
    direction: 'debit',
    amount: '250.00',
    categoryId: 'cat_spending',
  });

  const result = await markTransactionReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: tx.id,
    userId: REVIEWER_ID,
  });

  assert.strictEqual(result.amount, '250.00', 'amount unchanged after review');
  assert.strictEqual(result.direction, 'debit', 'direction unchanged after review');
  assert.strictEqual(result.categoryId, 'cat_spending', 'categoryId unchanged after review');
});

test('2.3 — markTransactionReviewed on ineligible transaction throws 409', async () => {
  const db = createInMemoryDb();
  const tx = await insertTx(db, HOUSEHOLD_ID, {
    direction: 'debit',
    categoryId: null,
    linkedDebtId: null,
    linkedGoalId: null,
  });

  const err = await markTransactionReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: tx.id,
    userId: REVIEWER_ID,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Ineligible transaction must throw');
  assert.ok(
    err.status === 409 || /cannot be marked reviewed/i.test(err.message),
    '409 for ineligible transaction',
  );
});

test('2.4 — markTransactionReviewed throws for non-existent transaction', async () => {
  const db = createInMemoryDb();
  const err = await markTransactionReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: 'tx_nonexistent',
    userId: REVIEWER_ID,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Non-existent transaction must throw');
});

// ─── Section 3: markTransactionUnreviewed ────────────────────────────────────

test('3.1 — markTransactionUnreviewed clears reviewedAt and reviewedBy', async () => {
  const db = createInMemoryDb();
  const tx = await insertTx(db, HOUSEHOLD_ID, { direction: 'credit' });

  await markTransactionReviewed({ db, householdId: HOUSEHOLD_ID, transactionId: tx.id, userId: REVIEWER_ID });
  const result = await markTransactionUnreviewed({ db, householdId: HOUSEHOLD_ID, transactionId: tx.id });

  assert.strictEqual(result.reviewedAt, null, 'reviewedAt cleared');
  assert.strictEqual(result.reviewedBy, null, 'reviewedBy cleared');
});

test('3.2 — markTransactionUnreviewed does not change financial fields', async () => {
  const db = createInMemoryDb();
  const tx = await insertTx(db, HOUSEHOLD_ID, {
    direction: 'debit',
    amount: '75.00',
    categoryId: 'cat_food',
  });

  await markTransactionReviewed({ db, householdId: HOUSEHOLD_ID, transactionId: tx.id, userId: REVIEWER_ID });
  const result = await markTransactionUnreviewed({ db, householdId: HOUSEHOLD_ID, transactionId: tx.id });

  assert.strictEqual(result.amount, '75.00', 'amount unchanged after unreviewing');
  assert.strictEqual(result.direction, 'debit', 'direction unchanged after unreviewing');
  assert.strictEqual(result.categoryId, 'cat_food', 'categoryId unchanged after unreviewing');
});

// ─── Section 4: bulkMarkTransactionsReviewed ─────────────────────────────────

test('4.1 — bulkMarkTransactionsReviewed succeeds for all eligible transactions', async () => {
  const db = createInMemoryDb();
  const t1 = await insertTx(db, HOUSEHOLD_ID, { direction: 'credit' });
  const t2 = await insertTx(db, HOUSEHOLD_ID, { direction: 'debit', categoryId: 'cat_spending' });

  const result = await bulkMarkTransactionsReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionIds: [t1.id, t2.id],
    userId: REVIEWER_ID,
  });

  assert.deepStrictEqual(result.reviewedIds.sort(), [t1.id, t2.id].sort(), 'Both reviewed');
  assert.ok(result.reviewedAt, 'reviewedAt set');
});

test('4.2 — bulkMarkTransactionsReviewed is all-or-nothing: one ineligible → none reviewed', async () => {
  const db = createInMemoryDb();
  const eligible = await insertTx(db, HOUSEHOLD_ID, { direction: 'credit' });
  const ineligible = await insertTx(db, HOUSEHOLD_ID, { direction: 'debit', categoryId: null });

  const err = await bulkMarkTransactionsReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionIds: [eligible.id, ineligible.id],
    userId: REVIEWER_ID,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Must throw when any transaction is ineligible');

  // Verify the eligible transaction was also NOT reviewed (all-or-nothing)
  const txState = await db.transaction(async (tx) =>
    tx.getTransactionById({ householdId: HOUSEHOLD_ID, transactionId: eligible.id }),
  );
  assert.strictEqual(txState.reviewedAt ?? null, null, 'Eligible tx NOT marked reviewed (all-or-nothing rollback)');
});

test('4.3 — bulkMarkTransactionsReviewed enforces 50-transaction limit', async () => {
  const db = createInMemoryDb();
  const ids = Array.from({ length: 51 }, (_, i) => `tx_fake_${i}`);

  const err = await bulkMarkTransactionsReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionIds: ids,
    userId: REVIEWER_ID,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Must throw for >50 transactions');
  assert.match(String(err.message), /50/i, 'Error references limit of 50');
});

test('4.4 — bulkMarkTransactionsReviewed rejects cross-tenant transaction IDs', async () => {
  const db = createInMemoryDb();
  const txA = await insertTx(db, HOUSEHOLD_ID, { direction: 'credit' });

  // Household B tries to bulk-review household A's transaction
  const err = await bulkMarkTransactionsReviewed({
    db,
    householdId: HOUSEHOLD_B,
    transactionIds: [txA.id],
    userId: REVIEWER_ID,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Cross-tenant bulk review must throw — SECURITY_DEFECT if it succeeds');
});

// ─── Section 5: Reconciliation ───────────────────────────────────────────────

test('5.1 — createAccountReconciliation computes discrepancy = reportedBalance - recordedBalance', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '1000.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '1050.00', source: 'bank_statement' },
  });

  assert.strictEqual(rec.recorded_balance, '1000.00', 'recorded_balance = account.currentBalance');
  assert.strictEqual(rec.reported_balance, '1050.00', 'reported_balance as provided');
  assert.strictEqual(rec.discrepancy, '50.00', 'discrepancy = 1050 - 1000 = 50');
  assert.strictEqual(rec.status, 'open', 'Starts as open');
});

test('5.2 — discrepancy is negative when reportedBalance < recordedBalance', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '2000.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '1950.00', source: 'manual' },
  });

  assert.strictEqual(rec.discrepancy, '-50.00', 'Negative discrepancy when reported < recorded');
});

test('5.3 — discrepancy is 0.00 when balances match exactly', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '500.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '500.00', source: 'manual' },
  });

  assert.strictEqual(rec.discrepancy, '0.00', 'Zero discrepancy when balances match');
});

test('5.4 — accept_reported_balance updates account currentBalance to reported value', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '1000.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '1100.00', source: 'bank_statement' },
  });

  const resolved = await resolveAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    reconciliationId: rec.id,
    input: { action: 'accept_reported_balance', note: null },
  });

  assert.strictEqual(resolved.status, 'resolved');
  assert.strictEqual(resolved.resolved_action, 'accept_reported_balance');

  // Verify account balance was updated
  const updatedAccount = await db.transaction(async (tx) =>
    tx.getFinancialAccountById({ householdId: HOUSEHOLD_ID, accountId: account.id }),
  );
  assert.strictEqual(updatedAccount.currentBalance, '1100.00', 'Account balance updated to reported balance');
});

test('5.5 — keep_recorded_balance does NOT change account currentBalance', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '1000.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '1100.00', source: 'bank_statement' },
  });

  await resolveAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    reconciliationId: rec.id,
    input: { action: 'keep_recorded_balance', note: null },
  });

  const account2 = await db.transaction(async (tx) =>
    tx.getFinancialAccountById({ householdId: HOUSEHOLD_ID, accountId: account.id }),
  );
  assert.strictEqual(account2.currentBalance, '1000.00', 'Account balance NOT changed when keeping recorded balance');
});

test('5.6 — mark_reviewed does NOT change account currentBalance', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '750.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '800.00', source: 'manual' },
  });

  await resolveAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    reconciliationId: rec.id,
    input: { action: 'mark_reviewed', note: null },
  });

  const account2 = await db.transaction(async (tx) =>
    tx.getFinancialAccountById({ householdId: HOUSEHOLD_ID, accountId: account.id }),
  );
  assert.strictEqual(account2.currentBalance, '750.00', 'Account balance NOT changed by mark_reviewed');
});

test('5.7 — resolveAccountReconciliation throws 409 when already resolved', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '1000.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '1050.00', source: 'manual' },
  });

  await resolveAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    reconciliationId: rec.id,
    input: { action: 'mark_reviewed', note: null },
  });

  const err = await resolveAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    reconciliationId: rec.id,
    input: { action: 'keep_recorded_balance', note: null },
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Second resolve must throw');
  assert.ok(err.status === 409 || /already resolved/i.test(err.message), '409 for already-resolved reconciliation');
});

test('5.8 — listAccountReconciliations returns all reconciliations for an account', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '500.00' });

  await createAccountReconciliation({
    db, householdId: HOUSEHOLD_ID, accountId: account.id,
    input: { reportedBalance: '510.00', source: 'bank' },
  });
  await createAccountReconciliation({
    db, householdId: HOUSEHOLD_ID, accountId: account.id,
    input: { reportedBalance: '520.00', source: 'bank' },
  });

  const result = await listAccountReconciliations({ db, householdId: HOUSEHOLD_ID, accountId: account.id });
  assert.strictEqual(result.items.length, 2, 'Both reconciliations listed');
});

// ─── Section 6: Reconciliation Cross-Tenant Isolation ─────────────────────────

test('6.1 — createAccountReconciliation rejects non-existent account', async () => {
  const db = createInMemoryDb();

  const err = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: 'account_nonexistent',
    input: { reportedBalance: '1000.00', source: 'manual' },
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Non-existent account must throw');
});

test('6.2 — resolveAccountReconciliation cannot access another tenant account — SECURITY_DEFECT', async () => {
  const db = createInMemoryDb();
  const accountA = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '1000.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: accountA.id,
    input: { reportedBalance: '1100.00', source: 'manual' },
  });

  // Household B tries to resolve household A's reconciliation
  const err = await resolveAccountReconciliation({
    db,
    householdId: HOUSEHOLD_B,
    accountId: accountA.id,
    reconciliationId: rec.id,
    input: { action: 'accept_reported_balance', note: null },
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Cross-tenant reconciliation resolve must throw — SECURITY_DEFECT if it succeeds');

  // Verify account balance in household A was NOT changed
  const account2 = await db.transaction(async (tx) =>
    tx.getFinancialAccountById({ householdId: HOUSEHOLD_ID, accountId: accountA.id }),
  );
  assert.strictEqual(account2.currentBalance, '1000.00', 'Account balance protected from cross-tenant modification');
});

test('6.3 — listAccountReconciliations for household B cannot see household A reconciliations', async () => {
  const db = createInMemoryDb();
  const accountA = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '1000.00' });

  await createAccountReconciliation({
    db, householdId: HOUSEHOLD_ID, accountId: accountA.id,
    input: { reportedBalance: '1050.00', source: 'bank' },
  });

  // Household B tries to list (with household A's accountId) — should get 404 (account not found)
  const err = await listAccountReconciliations({
    db,
    householdId: HOUSEHOLD_B,
    accountId: accountA.id,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'Cross-tenant list must fail — SECURITY_DEFECT if it returns data');
});

// ─── Section 7: Cross-Feature — Review + Reconciliation ──────────────────────

test('7.1 — Reviewing a transaction does not affect account balance (no reconciliation side-effect)', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '3000.00' });

  const tx = await insertTx(db, HOUSEHOLD_ID, {
    direction: 'debit',
    amount: '150.00',
    categoryId: 'cat_spending',
  });

  await markTransactionReviewed({
    db, householdId: HOUSEHOLD_ID, transactionId: tx.id, userId: REVIEWER_ID,
  });

  const account2 = await db.transaction(async (dbTx) =>
    dbTx.getFinancialAccountById({ householdId: HOUSEHOLD_ID, accountId: account.id }),
  );
  assert.strictEqual(account2.currentBalance, '3000.00', 'Transaction review must not alter account balance');
});

test('7.2 — Reconciliation accept_reported_balance does not create or modify transactions', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '500.00' });

  const txBefore = await insertTx(db, HOUSEHOLD_ID, {
    direction: 'debit', amount: '25.00', categoryId: 'cat_food',
  });

  const rec = await createAccountReconciliation({
    db, householdId: HOUSEHOLD_ID, accountId: account.id,
    input: { reportedBalance: '550.00', source: 'bank' },
  });

  await resolveAccountReconciliation({
    db, householdId: HOUSEHOLD_ID, accountId: account.id,
    reconciliationId: rec.id,
    input: { action: 'accept_reported_balance', note: null },
  });

  // Transaction must still exist unchanged
  const txAfter = await db.transaction(async (tx) =>
    tx.getTransactionById({ householdId: HOUSEHOLD_ID, transactionId: txBefore.id }),
  );
  assert.ok(txAfter, 'Pre-existing transaction still exists');
  assert.strictEqual(txAfter.amount, '25.00', 'Transaction amount unchanged by reconciliation');
});

// ─── Section 8: One-Cent Reconciliation Precision ────────────────────────────

test('8.1 — One-cent positive discrepancy: $100.00 recorded vs $100.01 reported', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '100.00' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '100.01', source: 'bank_statement' },
  });

  assert.strictEqual(rec.recorded_balance, '100.00', 'recorded_balance correct');
  assert.strictEqual(rec.reported_balance, '100.01', 'reported_balance correct');
  assert.strictEqual(rec.discrepancy, '0.01', 'one-cent positive discrepancy preserved exactly');
});

test('8.2 — One-cent negative discrepancy: $100.01 recorded vs $100.00 reported', async () => {
  const db = createInMemoryDb();
  const account = await createAccount(db, HOUSEHOLD_ID, { currentBalance: '100.01' });

  const rec = await createAccountReconciliation({
    db,
    householdId: HOUSEHOLD_ID,
    accountId: account.id,
    input: { reportedBalance: '100.00', source: 'bank_statement' },
  });

  assert.strictEqual(rec.discrepancy, '-0.01', 'one-cent negative discrepancy preserved exactly');
});

// ─── Section 9: Goal/Debt Link Survives Review ───────────────────────────────

test('9.1 — Goal-linked transaction: linkedGoalId and linkedDebtId unchanged after review', async () => {
  const db = createInMemoryDb();
  const tx = await insertTx(db, HOUSEHOLD_ID, {
    direction: 'debit',
    categoryId: 'cat_savings',
    linkedGoalId: 'goal_emergency_fund',
    linkedDebtId: null,
  });

  const reviewed = await markTransactionReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: tx.id,
    userId: REVIEWER_ID,
  });

  assert.strictEqual(reviewed.linkedGoalId, 'goal_emergency_fund', 'linkedGoalId unchanged after review');
  assert.strictEqual(reviewed.linkedDebtId, null, 'linkedDebtId still null after review');
  assert.strictEqual(reviewed.categoryId, 'cat_savings', 'categoryId unchanged after review');
  assert.strictEqual(reviewed.amount, '50.00', 'amount unchanged after review');
});

// ─── Section 10: Cross-Feature Chain — Import → Suggestion → Override → Review

const CHAIN_COLUMN_MAP = {
  columnMap: { date: 'Date', description: 'Description', amount: 'Amount', direction: 'Direction' },
};

async function chainUploadAndApprove(db, householdId, csvRows, categoryId = 'cat_auto') {
  const csv = [
    'Date,Description,Amount,Direction',
    ...csvRows.map((r) => `${r.date},${r.description},${r.amount},${r.dir ?? 'debit'}`),
  ].join('\n');
  const batch = await uploadImportBatch({ db, householdId, input: { filename: 'chain.csv', text: csv } });
  await parseImportBatch({ db, householdId, batchId: batch.batchId, input: CHAIN_COLUMN_MAP });
  const review = await reviewImportBatch({ db, householdId, batchId: batch.batchId });
  for (const row of review.rows) {
    if (row.status === 'pending') {
      await updateImportedRow({ db, householdId, rowId: row.id, input: { status: 'approved', categoryId } });
    }
  }
  return approveImportBatch({ db, householdId, batchId: batch.batchId });
}

test('10.1 — Chain: Import → Suggestion → Manual Override → Review: one authoritative transaction, final category from override', async () => {
  const db = createInMemoryDb();

  // Create an import review rule suggesting 'cat_auto_suggested'
  await db.transaction(async (tx) => tx.upsertImportReviewRule({
    householdId: HOUSEHOLD_ID,
    classificationType: 'transaction',
    categoryId: 'cat_auto_suggested',
    normalizedDescription: 'chain merchant',
    matchValue: 'chain merchant',
    matchType: 'contains',
    ruleType: 'suggestion',
    autoApply: false,
  }));

  // Step 1: Import and approve (categoryId from approved row = 'cat_from_import')
  const result = await chainUploadAndApprove(db, HOUSEHOLD_ID, [
    { date: '2026-09-01', description: 'Chain Merchant', amount: '99.00' },
  ], 'cat_from_import');

  assert.strictEqual(result.inserted, 1, 'Exactly one transaction inserted');

  // Retrieve the created authoritative transaction
  const txns = await db.transaction(async (tx) => tx.listTransactions({
    householdId: HOUSEHOLD_ID,
    from: '0001-01-01',
    to: '9999-12-31',
  }));
  const all = Array.isArray(txns) ? txns : txns?.items ?? [];
  assert.strictEqual(all.length, 1, 'Exactly one authoritative transaction');
  const authTx = all[0];

  // Step 2: Get suggestion (read-only)
  const suggestionResult = await getTransactionSuggestion({ db, householdId: HOUSEHOLD_ID, transactionId: authTx.id });
  assert.ok(suggestionResult.suggestion, 'Suggestion returned via rule');

  // Verify suggestion did NOT mutate the transaction
  const afterSuggestion = await db.transaction(async (tx) =>
    tx.getTransactionById({ householdId: HOUSEHOLD_ID, transactionId: authTx.id }),
  );
  assert.strictEqual(afterSuggestion.categoryId, 'cat_from_import', 'Suggestion fetch is read-only: categoryId unchanged');

  // Step 3: Manual override — user explicitly picks 'cat_user_override'
  await updateTransaction({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: authTx.id,
    input: { categoryId: 'cat_user_override' },
  });

  // Step 4: Mark reviewed
  const reviewed = await markTransactionReviewed({
    db,
    householdId: HOUSEHOLD_ID,
    transactionId: authTx.id,
    userId: REVIEWER_ID,
  });

  assert.strictEqual(reviewed.categoryId, 'cat_user_override', 'Final category = user override, not suggestion');
  assert.ok(reviewed.reviewedAt, 'Transaction marked reviewed');
  assert.strictEqual(reviewed.amount, '99.00', 'Amount unchanged throughout chain');

  // Verify still exactly one authoritative transaction
  const finalTxns = await db.transaction(async (tx) => tx.listTransactions({
    householdId: HOUSEHOLD_ID,
    from: '0001-01-01',
    to: '9999-12-31',
  }));
  const finalAll = Array.isArray(finalTxns) ? finalTxns : finalTxns?.items ?? [];
  assert.strictEqual(finalAll.length, 1, 'Still exactly one authoritative transaction — no duplication through chain');
});
