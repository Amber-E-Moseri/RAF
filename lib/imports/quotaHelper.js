export class QuotaExceededError extends Error {
  constructor(message = 'PDF import quota exceeded', remaining = 0) {
    super(message);
    this.name = 'QuotaExceededError';
    this.status = 429;
    this.remaining = remaining;
  }
}

export async function checkPdfImportQuota(db, householdId) {
  return db.transaction(async (tx) => {
    const status = await tx.getPdfImportQuotaStatus({ householdId });
    return status;
  });
}

export async function recordPdfImportUsage(db, householdId) {
  return db.transaction(async (tx) => {
    await tx.incrementPdfImportQuota({ householdId });
  });
}

export async function admitPdfImportForFreeTier(db, householdId) {
  return db.transaction(async (tx) => {
    return tx.reservePdfImportQuota({ householdId });
  });
}
