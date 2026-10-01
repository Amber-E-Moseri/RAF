import { logAuditEvent } from '../audit/auditLog.js';
import { evaluateDuplicateEvidence } from './duplicateEvidence.js';
import {
  IMPORT_BATCH_STATUS,
  ImportHttpError,
  assertImportBatchStatus,
  assertImportBatchTransition,
  normalizeRowStatus,
  parseMoneyToCents,
} from './shared.js';
import {
  DUPLICATE_STATE,
  assignEventOrdinals,
  buildEventKey,
  signedCentsFromAmountAndDirection,
} from './transactionIdentity.js';

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

    // Identity is computed over every parsed row, in stable order, so the Nth identical row
    // keeps the same ordinal regardless of which rows the user approved or rejected.
    const identityByRowId = new Map();
    const parsedRows = rows.filter((row) => row.parsedDate && row.parsedAmount && row.parsedDirection);
    const signedCentsList = parsedRows.map((row) =>
      signedCentsFromAmountAndDirection(row.parsedAmount, row.parsedDirection));
    const eventKeys = parsedRows.map((row, index) => buildEventKey({
      date: row.parsedDate,
      signedCents: signedCentsList[index],
      description: row.parsedDescription,
    }));
    const eventOrdinals = assignEventOrdinals(eventKeys);
    parsedRows.forEach((row, index) => {
      identityByRowId.set(row.id, {
        signedCents: signedCentsList[index],
        eventKey: eventKeys[index],
        eventOrdinal: eventOrdinals[index],
      });
    });

    let inserted = 0;
    let skipped = 0;
    let duplicates = 0;

    const approvedRows = [];
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
      approvedRows.push(row);
    }

    // Pass 1 (no writes): evaluate evidence for every approved row.
    const accountIdForRow = (row) => row.accountId ?? batch.accountId ?? null;
    const evidenceByRowId = new Map();
    const needsReview = [];
    for (const row of approvedRows) {
      const identity = identityByRowId.get(row.id);
      const evidence = await evaluateDuplicateEvidence({
        tx,
        householdId,
        accountId: accountIdForRow(row),
        date: row.parsedDate,
        signedCents: identity.signedCents,
        eventKey: identity.eventKey,
        eventOrdinal: identity.eventOrdinal,
        importBatchId: batchId,
        kind: 'transaction',
      });
      evidenceByRowId.set(row.id, evidence);

      // A row flagged at parse time that the user still approved was explicitly confirmed.
      const acknowledged = row.duplicateState === DUPLICATE_STATE.LIKELY
        || row.duplicateState === DUPLICATE_STATE.EXACT;
      if (evidence.state === DUPLICATE_STATE.LIKELY && !acknowledged) {
        needsReview.push({ rowId: row.id, matches: evidence.matches });
      }
    }

    if (needsReview.length > 0) {
      throw new ImportHttpError(
        409,
        'Some rows may duplicate existing transactions. Re-run parse to review them before approving.',
        { errorCode: 'IMPORT_POSSIBLE_DUPLICATE', rows: needsReview },
      );
    }

    // Pass 2: apply.
    for (const row of approvedRows) {
      const evidence = evidenceByRowId.get(row.id);
      if (evidence.state === DUPLICATE_STATE.EXACT) {
        await tx.updateImportedRow({
          householdId,
          rowId: row.id,
          patch: {
            status: 'duplicate',
            duplicateState: DUPLICATE_STATE.EXACT,
            duplicateMatches: evidence.matches,
            duplicateOfId: evidence.matches[0]?.id ?? null,
            duplicateReason: `exact_match:${evidence.matches[0]?.kind}:${evidence.matches[0]?.id}`,
          },
        });
        duplicates += 1;
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
        accountId: accountIdForRow(row),
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

      if (typeof tx.insertImportEventClaim === 'function') {
        const identity = identityByRowId.get(row.id);
        try {
          await tx.insertImportEventClaim({
            householdId,
            accountId: accountIdForRow(row),
            eventKey: identity.eventKey,
            eventOrdinal: identity.eventOrdinal,
            transactionId: transaction.id,
            claimType: 'created',
            source: 'csv_import',
            importBatchId: batchId,
            importedTransactionId: null,
          });
        } catch (error) {
          if (error?.code === '23505') {
            throw new ImportHttpError(
              409,
              'A row in this batch is the same event as a transaction that was just imported. Retry the approval.',
              { errorCode: 'IMPORT_EXACT_DUPLICATE', rowId: row.id },
            );
          }
          throw error;
        }
      }

      inserted += 1;
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
