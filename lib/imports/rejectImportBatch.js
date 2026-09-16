import { logAuditEvent } from '../audit/auditLog.js';
import {
  IMPORT_BATCH_STATUS,
  ImportHttpError,
  assertImportBatchStatus,
  assertImportBatchTransition,
  normalizeRowStatus,
} from './shared.js';

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Import DB adapter must implement transaction().');
  }
}

export async function rejectImportBatch({ db, householdId, userId, batchId }) {
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
      new Set([IMPORT_BATCH_STATUS.REVIEW, IMPORT_BATCH_STATUS.FAILED]),
      'import batch must be in review status before rejection',
    );

    if (batchStatus === IMPORT_BATCH_STATUS.FAILED) {
      return {
        batchId,
        rejected: rows.reduce((count, row) => count + (normalizeRowStatus(row.status ?? 'pending') === 'rejected' ? 1 : 0), 0),
        alreadyRejected: true,
      };
    }

    assertImportBatchTransition({
      currentStatus: batchStatus,
      nextStatus: IMPORT_BATCH_STATUS.FAILED,
      action: 'reject',
    });

    let rejected = 0;

    for (const row of rows) {
      if (normalizeRowStatus(row.status ?? 'pending') === 'rejected') {
        continue;
      }

      await tx.updateImportedRow({
        householdId,
        rowId: row.id,
        patch: { status: 'rejected' },
      });
      rejected += 1;
    }

    await tx.updateImportBatch({
      householdId,
      batchId,
      status: IMPORT_BATCH_STATUS.FAILED,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'import.rejected',
      entityId: batchId,
    });

    return {
      batchId,
      rejected,
    };
  });
}
