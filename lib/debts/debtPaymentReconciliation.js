import { logAuditEvent } from '../audit/auditLog.js';

export class ReconciliationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ReconciliationError';
  }
}

function requireDbContract(db) {
  if (!db || typeof db.transaction !== 'function') {
    throw new ReconciliationError(500, 'database adapter is required');
  }
}

export async function confirmDebtPaymentReconciliation({ db, householdId, debtId, primaryPaymentId, duplicatePaymentId, matchType, userId = null }) {
  requireDbContract(db);

  if (!householdId) throw new ReconciliationError(400, 'workspace is required');
  if (!debtId) throw new ReconciliationError(400, 'debtId is required');
  if (!primaryPaymentId) throw new ReconciliationError(400, 'primaryPaymentId is required');
  if (!duplicatePaymentId) throw new ReconciliationError(400, 'duplicatePaymentId is required');
  if (primaryPaymentId === duplicatePaymentId) throw new ReconciliationError(400, 'cannot reconcile a payment with itself');
  if (!matchType || !['EXACT_MATCH', 'POSSIBLE_MATCH'].includes(matchType)) {
    throw new ReconciliationError(400, 'matchType must be EXACT_MATCH or POSSIBLE_MATCH');
  }

  return db.transaction(async (tx) => {
    const allPayments = await tx.listDebtPayments({ householdId });

    const primary = findPaymentInList(allPayments, primaryPaymentId);
    if (!primary) throw new ReconciliationError(404, 'primary payment not found');

    const duplicate = findPaymentInList(allPayments, duplicatePaymentId);
    if (!duplicate) throw new ReconciliationError(404, 'duplicate payment not found');

    if (primary.debtId !== debtId || duplicate.debtId !== debtId) {
      throw new ReconciliationError(400, 'both payments must belong to the specified debt');
    }

    if (typeof tx.getDebtPaymentReconciliation === 'function') {
      const existing = await tx.getDebtPaymentReconciliation({ householdId, primaryPaymentId, duplicatePaymentId });
      if (existing) {
        throw new ReconciliationError(409, 'reconciliation already exists for this pair');
      }
    }

    const reconciliation = await tx.insertDebtPaymentReconciliation({
      householdId,
      primaryPaymentId,
      duplicatePaymentId,
      status: 'confirmed',
      matchType,
      confirmedBy: userId ? 'user' : 'system',
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId: userId ?? 'system',
      event: 'debt.payment_reconciliation.confirmed',
      entityId: reconciliation.id,
      metadata: { entityType: 'debt_payment_reconciliation', debtId },
    });

    return reconciliation;
  });
}

export async function rejectDebtPaymentReconciliation({ db, householdId, debtId, primaryPaymentId, duplicatePaymentId, matchType, userId = null }) {
  requireDbContract(db);

  if (!householdId) throw new ReconciliationError(400, 'workspace is required');
  if (!debtId) throw new ReconciliationError(400, 'debtId is required');
  if (!primaryPaymentId) throw new ReconciliationError(400, 'primaryPaymentId is required');
  if (!duplicatePaymentId) throw new ReconciliationError(400, 'duplicatePaymentId is required');
  if (primaryPaymentId === duplicatePaymentId) throw new ReconciliationError(400, 'cannot reconcile a payment with itself');
  if (!matchType || !['EXACT_MATCH', 'POSSIBLE_MATCH'].includes(matchType)) {
    throw new ReconciliationError(400, 'matchType must be EXACT_MATCH or POSSIBLE_MATCH');
  }

  return db.transaction(async (tx) => {
    const allPayments = await tx.listDebtPayments({ householdId });

    const primary = findPaymentInList(allPayments, primaryPaymentId);
    if (!primary) throw new ReconciliationError(404, 'primary payment not found');

    const duplicate = findPaymentInList(allPayments, duplicatePaymentId);
    if (!duplicate) throw new ReconciliationError(404, 'duplicate payment not found');

    if (primary.debtId !== debtId || duplicate.debtId !== debtId) {
      throw new ReconciliationError(400, 'both payments must belong to the specified debt');
    }

    if (typeof tx.getDebtPaymentReconciliation === 'function') {
      const existing = await tx.getDebtPaymentReconciliation({ householdId, primaryPaymentId, duplicatePaymentId });
      if (existing) {
        throw new ReconciliationError(409, 'reconciliation already exists for this pair');
      }
    }

    const reconciliation = await tx.insertDebtPaymentReconciliation({
      householdId,
      primaryPaymentId,
      duplicatePaymentId,
      status: 'rejected',
      matchType,
      confirmedBy: userId ? 'user' : null,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId: userId ?? 'system',
      event: 'debt.payment_reconciliation.rejected',
      entityId: reconciliation.id,
      metadata: { entityType: 'debt_payment_reconciliation', debtId },
    });

    return reconciliation;
  });
}

export async function listDebtPaymentReconciliations({ db, householdId, debtId }) {
  requireDbContract(db);
  if (!householdId) throw new ReconciliationError(400, 'workspace is required');

  return db.transaction(async (tx) => {
    if (typeof tx.listDebtPaymentReconciliations !== 'function') return [];
    return tx.listDebtPaymentReconciliations({ householdId, debtId });
  });
}

function findPaymentInList(payments, paymentId) {
  return payments?.find((p) => p.id === paymentId) ?? null;
}
