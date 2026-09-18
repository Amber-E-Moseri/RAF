import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findDebtPaymentMatches, DATE_TOLERANCE_DAYS } from '../lib/debts/debtPaymentMatching.js';
import { normalizeDebtPayment } from '../lib/debts/debtActivity.js';

const WORKSPACE = 'ws-match-01';
const DEBT_ID = 'debt-cc-01';

function makePaymentActivity({ id, debtId = DEBT_ID, workspaceId = WORKSPACE, amountCents, effectiveDate, source, transactionId = null, importBatchId = null }) {
  return {
    id: `payment:${id}`,
    debtId,
    workspaceId,
    type: 'payment',
    amountCents,
    effectiveDate,
    source,
    transactionId,
    importBatchId,
    provenance: { recordType: 'debt_payment', recordId: id },
  };
}
function manualPayment(o) { return makePaymentActivity({ source: 'manual', ...o }); }
function importPayment(o) { return makePaymentActivity({ source: 'import', ...o }); }

describe('findDebtPaymentMatches', () => {
  test('default date tolerance is ±2 days', () => {
    assert.equal(DATE_TOLERANCE_DAYS, 2);
  });

  describe('POSSIBLE_MATCH classification', () => {
    test('matches same amount and exact same date as POSSIBLE_MATCH', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].candidates[0].classification, 'POSSIBLE_MATCH');
      assert.equal(result.matches[0].candidates[0].dateDifferenceDays, 0);
      assert.ok(result.matches[0].candidates[0].reasons.includes('exact_amount'));
      assert.ok(result.matches[0].candidates[0].reasons.includes('exact_date'));
      assert.equal(result.matches[0].ambiguous, false);
      assert.equal(result.unmatched.manual.length, 0);
      assert.equal(result.unmatched.imported.length, 0);
    });

    test('matches same amount ±1 day as POSSIBLE_MATCH', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 30000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 30000, effectiveDate: '2026-03-16', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].candidates[0].classification, 'POSSIBLE_MATCH');
      assert.equal(result.matches[0].candidates[0].dateDifferenceDays, 1);
    });

    test('matches same amount within ±2 days (default tolerance)', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 25000, effectiveDate: '2026-03-10' }),
        importPayment({ id: 'ip1', amountCents: 25000, effectiveDate: '2026-03-12', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].candidates[0].dateDifferenceDays, 2);
    });

    test('amount/date similarity alone never produces EXACT_MATCH', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches[0].candidates[0].classification, 'POSSIBLE_MATCH');
      assert.notEqual(result.matches[0].candidates[0].classification, 'EXACT_MATCH');
    });
  });

  describe('UNMATCHED classification', () => {
    test('does not match when date is outside tolerance (3 days > 2 day tolerance)', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-01' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-04', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
      assert.equal(result.unmatched.manual.length, 1);
      assert.equal(result.unmatched.imported.length, 1);
    });

    test('does not match different amounts even on same date', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 49900, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
    });

    test('does not match across different debts', () => {
      const activities = [
        manualPayment({ id: 'mp1', debtId: 'debt-a', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', debtId: 'debt-b', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
    });

    test('does not match across different workspaces', () => {
      const activities = [
        manualPayment({ id: 'mp1', workspaceId: 'ws-1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', workspaceId: 'ws-2', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
    });

    test('returns only manual in unmatched when no imports exist', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
      assert.equal(result.unmatched.manual.length, 1);
      assert.equal(result.unmatched.imported.length, 0);
    });
  });

  describe('EXACT_MATCH via deterministic link', () => {
    test('classifies as EXACT_MATCH when imported_transaction links to manual transaction', () => {
      const manualTxnId = 'txn-manual-100';
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: manualTxnId }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-200' }),
      ];
      const importedTransactions = [{ id: 'imp-row-1', linkedTransactionId: manualTxnId }];
      const result = findDebtPaymentMatches({ activities, importedTransactions });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].candidates[0].classification, 'EXACT_MATCH');
      assert.ok(result.matches[0].candidates[0].reasons.includes('deterministic_provenance_link'));
    });

    test('does not produce EXACT_MATCH without manual transactionId', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: null }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-200' }),
      ];
      const importedTransactions = [{ id: 'imp-row-1', linkedTransactionId: 'txn-imp-200' }];
      const result = findDebtPaymentMatches({ activities, importedTransactions });
      assert.equal(result.matches[0].candidates[0].classification, 'POSSIBLE_MATCH');
    });
  });

  describe('legitimate repeated payment protection', () => {
    test('does not cross-match monthly recurring payments outside date tolerance', () => {
      const activities = [
        manualPayment({ id: 'mp-jan', amountCents: 30000, effectiveDate: '2026-01-15' }),
        manualPayment({ id: 'mp-feb', amountCents: 30000, effectiveDate: '2026-02-15' }),
        manualPayment({ id: 'mp-mar', amountCents: 30000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip-jan', amountCents: 30000, effectiveDate: '2026-01-15', transactionId: 'txn-jan' }),
        importPayment({ id: 'ip-feb', amountCents: 30000, effectiveDate: '2026-02-15', transactionId: 'txn-feb' }),
        importPayment({ id: 'ip-mar', amountCents: 30000, effectiveDate: '2026-03-15', transactionId: 'txn-mar' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 3);
      for (const match of result.matches) {
        assert.equal(match.candidates.length, 1);
        assert.equal(match.ambiguous, false);
      }
    });

    test('two genuine $300 payments remain two economic events when not reconciled', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 30000, effectiveDate: '2026-03-01' }),
        manualPayment({ id: 'mp2', amountCents: 30000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 30000, effectiveDate: '2026-03-01', transactionId: 'txn-1' }),
        importPayment({ id: 'ip2', amountCents: 30000, effectiveDate: '2026-03-15', transactionId: 'txn-2' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 2);
      assert.equal(result.matches[0].candidates.length, 1);
      assert.equal(result.matches[1].candidates.length, 1);
    });
  });

  describe('ambiguity handling', () => {
    test('marks ambiguous when one manual has multiple possible import matches', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-14', transactionId: 'txn-1' }),
        importPayment({ id: 'ip2', amountCents: 50000, effectiveDate: '2026-03-16', transactionId: 'txn-2' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].ambiguous, true);
      assert.equal(result.matches[0].candidates.length, 2);
    });

    test('is not ambiguous when EXACT_MATCH exists among candidates', () => {
      const manualTxnId = 'txn-manual-1';
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: manualTxnId }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
        importPayment({ id: 'ip2', amountCents: 50000, effectiveDate: '2026-03-16', transactionId: 'txn-imp-2' }),
      ];
      const importedTransactions = [{ id: 'imp-row-1', linkedTransactionId: manualTxnId }];
      const result = findDebtPaymentMatches({ activities, importedTransactions });
      assert.equal(result.matches[0].ambiguous, false);
    });
  });

  describe('rejected candidate suppression', () => {
    test('suppresses rejected pairs from POSSIBLE_MATCH results', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-1' }),
      ];
      const reconciliations = [{ primaryPaymentId: 'mp1', duplicatePaymentId: 'ip1', status: 'rejected' }];
      const result = findDebtPaymentMatches({ activities, reconciliations });
      assert.equal(result.matches.length, 0);
      assert.equal(result.unmatched.manual.length, 1);
      assert.equal(result.unmatched.imported.length, 1);
    });

    test('suppresses reversed rejected pair (B→A when A→B was rejected)', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-1' }),
      ];
      const reconciliations = [{ primaryPaymentId: 'ip1', duplicatePaymentId: 'mp1', status: 'rejected' }];
      const result = findDebtPaymentMatches({ activities, reconciliations });
      assert.equal(result.matches.length, 0);
    });

    test('confirmed reconciliations do not suppress matching', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-1' }),
      ];
      const reconciliations = [{ primaryPaymentId: 'mp1', duplicatePaymentId: 'ip1', status: 'confirmed' }];
      const result = findDebtPaymentMatches({ activities, reconciliations });
      assert.equal(result.matches.length, 1);
    });
  });

  describe('source filtering', () => {
    test('treats monthly_review source as manual for matching purposes', () => {
      const activities = [
        makePaymentActivity({ id: 'mr1', source: 'monthly_review', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-review-1' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 1);
    });

    test('does not match buffer-sourced payments as manual', () => {
      const activities = [
        makePaymentActivity({ id: 'buf1', source: 'buffer', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-buf-1' }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-1' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
    });

    test('does not match two manual payments against each other', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        manualPayment({ id: 'mp2', amountCents: 50000, effectiveDate: '2026-03-15' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 0);
    });
  });

  describe('integration with normalizeDebtPayment', () => {
    test('works with activities produced by normalizeDebtPayment', () => {
      const transactionsByIdMap = new Map([
        ['txn-manual-1', { id: 'txn-manual-1', source: 'manual', description: 'CC payment' }],
        ['txn-import-1', { id: 'txn-import-1', source: 'import', importBatchId: 'batch-1' }],
      ]);
      const manualDP = { id: 'dp-1', debtId: DEBT_ID, householdId: WORKSPACE, amount: '500.00', paymentDate: '2026-03-15', transactionId: 'txn-manual-1' };
      const importDP = { id: 'dp-2', debtId: DEBT_ID, householdId: WORKSPACE, amount: '500.00', paymentDate: '2026-03-15', transactionId: 'txn-import-1' };
      const activities = [normalizeDebtPayment(manualDP, transactionsByIdMap), normalizeDebtPayment(importDP, transactionsByIdMap)];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].candidates[0].classification, 'POSSIBLE_MATCH');
    });
  });

  describe('edge cases', () => {
    test('handles empty activities array', () => {
      const result = findDebtPaymentMatches({ activities: [] });
      assert.equal(result.matches.length, 0);
      assert.equal(result.unmatched.manual.length, 0);
      assert.equal(result.unmatched.imported.length, 0);
    });

    test('handles linked_transaction_id snake_case variant for deterministic check', () => {
      const manualTxnId = 'txn-manual-sc';
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: manualTxnId }),
        importPayment({ id: 'ip1', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-imp-sc' }),
      ];
      const importedTransactions = [{ id: 'imp-sc', linked_transaction_id: manualTxnId }];
      const result = findDebtPaymentMatches({ activities, importedTransactions });
      assert.equal(result.matches[0].candidates[0].classification, 'EXACT_MATCH');
    });

    test('sorts candidates by date proximity', () => {
      const activities = [
        manualPayment({ id: 'mp1', amountCents: 50000, effectiveDate: '2026-03-15' }),
        importPayment({ id: 'ip-far', amountCents: 50000, effectiveDate: '2026-03-13', transactionId: 'txn-1' }),
        importPayment({ id: 'ip-exact', amountCents: 50000, effectiveDate: '2026-03-15', transactionId: 'txn-3' }),
      ];
      const result = findDebtPaymentMatches({ activities });
      assert.equal(result.matches[0].candidates[0].dateDifferenceDays, 0);
      assert.equal(result.matches[0].candidates[1].dateDifferenceDays, 2);
    });
  });
});
