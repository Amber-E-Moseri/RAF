import { logAuditEvent } from '../audit/auditLog.js';
import {
  IMPORT_BATCH_STATUS,
  ImportHttpError,
  assertImportBatchStatus,
  assertImportBatchTransition,
  normalizeRowStatus,
  parseMoneyToCents,
} from './shared.js';

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Import DB adapter must implement transaction().');
  }
}

function validateApprovedRow(row) {
  if (!row.parsedDate || !row.parsedDescription || !row.parsedAmount || !row.parsedDirection) {
    throw new ImportHttpError(422, `import row ${row.id} is missing parsed values`);
  }

  if (!row.suggestedCategoryId && !row.suggestedDebtId) {
    throw new ImportHttpError(422, `import row ${row.id} requires a category or debt before approval`);
  }

  const amountCents = parseMoneyToCents(row.parsedAmount, 'parsedAmount');
  if (amountCents < 0 && row.parsedDirection !== 'credit') {
    throw new ImportHttpError(422, `import row ${row.id} has a negative amount without credit direction`);
  }

  if (row.suggestedDebtId) {
    if (row.parsedDirection !== 'debit') {
      throw new ImportHttpError(422, `import row ${row.id} debt payments must be debit transactions`);
    }

    if (amountCents <= 0) {
      throw new ImportHttpError(422, `import row ${row.id} debt payments must be positive`);
    }
  }
}

function summarizeApprovedBatchRows(rows) {
  let inserted = 0;
  let skipped = 0;
  let duplicates = 0;

  for (const row of rows) {
    const status = normalizeRowStatus(row.status ?? 'pending');
    if (status === 'duplicate') {
      duplicates += 1;
      continue;
    }

    if (status === 'approved') {
      inserted += 1;
      continue;
    }

    skipped += 1;
  }

  return {
    inserted,
    skipped,
    duplicates,
  };
}

function buildImportRowFingerprint(row) {
  return [
    row.parsedDate ?? '',
    row.parsedDescription ?? '',
    row.parsedMerchant ?? '',
    row.parsedAmount ?? '',
    row.parsedDirection ?? '',
    row.suggestedCategoryId ?? '',
    row.suggestedDebtId ?? '',
  ].join('|');
}

function buildDuplicateCandidateKey(row) {
  // Heuristic key for detecting similar transactions across batches.
  // Excludes mutable fields (categoryId, debtId) that can be corrected during review.
  // Uses only stable, observable transaction attributes that define what actually happened.
  return [
    row.parsedDate ?? '',
    row.parsedDescription ?? '',
    row.parsedMerchant ?? '',
    row.parsedAmount ?? '',
    row.parsedDirection ?? '',
  ].join('|');
}

function buildAuthorativeTransactionKey(txn) {
  // Build the same heuristic key from an authoritative transaction.
  return [
    txn.transactionDate ?? '',
    txn.description ?? '',
    txn.merchant ?? '',
    txn.amount ?? '',
    txn.direction ?? '',
  ].join('|');
}

export async function approveImportBatch({ db, householdId, userId, batchId }) {
  if (!householdId) {
    throw new ImportHttpError(400, 'householdId is required');
  }

  if (!batchId) {
    throw new ImportHttpError(400, 'batchId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const batch = await tx.getImportBatch({ householdId, batchId });
    if (!batch) {
      throw new ImportHttpError(404, 'import batch not found');
    }

    const rows = await tx.listImportedRows({ householdId, batchId });
    const batchStatus = assertImportBatchStatus(
      batch,
      new Set([IMPORT_BATCH_STATUS.REVIEW, IMPORT_BATCH_STATUS.APPROVED]),
      'import batch must be in review status before approval',
    );

    if (batchStatus === IMPORT_BATCH_STATUS.APPROVED) {
      return {
        ...summarizeApprovedBatchRows(rows),
        alreadyApproved: true,
      };
    }

    assertImportBatchTransition({
      currentStatus: batchStatus,
      nextStatus: IMPORT_BATCH_STATUS.APPROVED,
      action: 'approve',
    });

    // Track existing transactions for duplicate detection.
    // sameBatchFingerprints: used for strict same-batch dedup (includes category/debt).
    // candidateKeySet: used for cross-batch heuristic detection (excludes mutable fields).
    const sameBatchFingerprints = new Set();
    const candidateKeySet = new Set();

    if (typeof tx.listTransactions === 'function') {
      const existingTransactions = await tx.listTransactions({
        householdId,
        from: '0001-01-01',
        to: '9999-12-31',
      });
      const transactionRows = Array.isArray(existingTransactions)
        ? existingTransactions
        : existingTransactions?.items ?? [];

      for (const transaction of transactionRows) {
        // Same-batch: use full fingerprint (with category/debt) for strict matching.
        if (transaction.importBatchId === batchId) {
          const fingerprint = [
            transaction.transactionDate ?? '',
            transaction.description ?? '',
            transaction.merchant ?? '',
            transaction.amount ?? '',
            transaction.direction ?? '',
            transaction.categoryId ?? '',
            transaction.linkedDebtId ?? '',
          ].join('|');
          sameBatchFingerprints.add(fingerprint);
        }

        // Cross-batch: use heuristic key (no category/debt) for candidate detection.
        const candidateKey = buildAuthorativeTransactionKey(transaction);
        candidateKeySet.add(candidateKey);
      }
    }

    let inserted = 0;
    let skipped = 0;
    let duplicates = 0;

    for (const row of rows) {
      const rowStatus = normalizeRowStatus(row.status ?? 'pending');
      if (rowStatus === 'duplicate') {
        duplicates += 1;
        continue;
      }

      if (rowStatus !== 'approved') {
        skipped += 1;
        continue;
      }

      validateApprovedRow(row);

      // Check same-batch strict deduplication (includes category/debt).
      const fingerprint = buildImportRowFingerprint(row);
      if (sameBatchFingerprints.has(fingerprint)) {
        skipped += 1;
        continue;
      }

      // Check for cross-batch duplicate candidates (heuristic key only).
      const candidateKey = buildDuplicateCandidateKey(row);
      if (candidateKeySet.has(candidateKey)) {
        // This is a candidate for duplicate review.
        // TODO: Phase 5 will mark this as needs_review instead of skipping.
        // For now, we prevent silent approval of cross-batch candidates.
        skipped += 1;
        continue;
      }

      if (row.suggestedDebtId) {
        const debt = await tx.findDebtById({
          householdId,
          debtId: row.suggestedDebtId,
        });

        if (!debt) {
          throw new ImportHttpError(404, `linked debt not found for import row ${row.id}`);
        }
      }

      const transaction = await tx.insertTransaction({
        householdId,
        transactionDate: row.parsedDate,
        description: row.parsedDescription,
        merchant: row.parsedMerchant,
        amount: row.parsedAmount,
        direction: row.parsedDirection,
        categoryId: row.suggestedCategoryId,
        linkedDebtId: row.suggestedDebtId,
        accountId: row.accountId ?? null,
        source: 'import',
        importBatchId: batchId,
      });

      if (row.suggestedDebtId) {
        await tx.insertDebtPayment({
          householdId,
          debtId: row.suggestedDebtId,
          transactionId: transaction.id,
          paymentDate: row.parsedDate,
          amount: row.parsedAmount,
        });
      }

      inserted += 1;
      sameBatchFingerprints.add(fingerprint);
      candidateKeySet.add(candidateKey);
    }

    await tx.updateImportBatch({
      householdId,
      batchId,
      status: IMPORT_BATCH_STATUS.APPROVED,
      expectedStatus: IMPORT_BATCH_STATUS.REVIEW,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'import.approved',
      entityId: batchId,
    });

    return {
      inserted,
      skipped,
      duplicates,
    };
  });
}
