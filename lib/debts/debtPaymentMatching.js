import { parseMoneyToCents } from '../raf/reporting.js';

const DATE_TOLERANCE_DAYS = 2;

function daysBetween(dateA, dateB) {
  const a = new Date(dateA + 'T00:00:00Z');
  const b = new Date(dateB + 'T00:00:00Z');
  return Math.round(Math.abs(a - b) / (86400000));
}

function hasDeterministicLink(manualActivity, importActivity, importedTransactions) {
  if (!manualActivity.transactionId) return false;
  if (manualActivity.transactionId === importActivity.transactionId) return true;

  for (const imp of importedTransactions) {
    if (imp.linkedTransactionId === manualActivity.transactionId
      || imp.linked_transaction_id === manualActivity.transactionId) {
      return true;
    }
  }
  return false;
}

function buildReasons({ amountMatch, dateDifferenceDays, deterministicLink }) {
  const reasons = [];
  if (deterministicLink) reasons.push('deterministic_provenance_link');
  if (amountMatch) reasons.push('exact_amount');
  if (dateDifferenceDays === 0) reasons.push('exact_date');
  else reasons.push(`date_within_${dateDifferenceDays}_days`);
  return reasons;
}

export function findDebtPaymentMatches({
  activities,
  importedTransactions = [],
  reconciliations = [],
  dateTolerance = DATE_TOLERANCE_DAYS,
}) {
  const rejectedPairs = new Set();
  for (const rec of reconciliations) {
    if (rec.status === 'rejected') {
      const pId = rec.primaryPaymentId ?? rec.primary_payment_id;
      const dId = rec.duplicatePaymentId ?? rec.duplicate_payment_id;
      rejectedPairs.add(`${pId}:${dId}`);
      rejectedPairs.add(`${dId}:${pId}`);
    }
  }

  const manualPayments = activities.filter(
    (a) => a.type === 'payment' && (a.source === 'manual' || a.source === 'monthly_review'),
  );
  const importPayments = activities.filter(
    (a) => a.type === 'payment' && a.source === 'import',
  );

  const matches = [];
  const matchedManualIds = new Set();
  const matchedImportIds = new Set();

  for (const manual of manualPayments) {
    const candidates = [];
    const manualRecordId = manual.provenance?.recordId;

    for (const imported of importPayments) {
      if (manual.debtId !== imported.debtId) continue;
      if (manual.workspaceId !== imported.workspaceId) continue;

      const importRecordId = imported.provenance?.recordId;
      if (manualRecordId && importRecordId) {
        if (rejectedPairs.has(`${manualRecordId}:${importRecordId}`)) continue;
      }

      const amountMatch = manual.amountCents === imported.amountCents;
      if (!amountMatch) continue;

      const dateDifferenceDays = daysBetween(manual.effectiveDate, imported.effectiveDate);
      if (dateDifferenceDays > dateTolerance) continue;

      const deterministicLink = hasDeterministicLink(manual, imported, importedTransactions);
      const classification = deterministicLink ? 'EXACT_MATCH' : 'POSSIBLE_MATCH';

      candidates.push({
        importActivity: imported,
        classification,
        dateDifferenceDays,
        reasons: buildReasons({ amountMatch, dateDifferenceDays, deterministicLink }),
      });
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (a.classification !== b.classification) {
        return a.classification === 'EXACT_MATCH' ? -1 : 1;
      }
      return a.dateDifferenceDays - b.dateDifferenceDays;
    });

    const ambiguous = candidates.length > 1
      && candidates.every((c) => c.classification !== 'EXACT_MATCH');

    matches.push({
      manualActivity: manual,
      candidates,
      ambiguous,
    });

    matchedManualIds.add(manual.id);
    for (const c of candidates) {
      matchedImportIds.add(c.importActivity.id);
    }
  }

  const unmatchedManual = manualPayments.filter((a) => !matchedManualIds.has(a.id));
  const unmatchedImport = importPayments.filter((a) => !matchedImportIds.has(a.id));

  return {
    matches,
    unmatched: {
      manual: unmatchedManual,
      imported: unmatchedImport,
    },
  };
}

export { DATE_TOLERANCE_DAYS };
