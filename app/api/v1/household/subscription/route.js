import { getDb, getHouseholdId, json, buildErrorBody } from '../../_shared/http.js';

// Billing is not active. Subscription and quota tier changes are NOT self-service:
// there is no payment processing, and the Stripe webhook does not process events.
// This endpoint previously let any workspace member set the PDF import quota tier to
// 'paid' with no payment. That write path has been removed. Do not reintroduce a
// client-driven tier write here; paid state may only come from a verified, privileged
// billing path (see docs/BILLING_STATUS.md).
const BILLING_NOT_ACTIVE_MESSAGE =
  'Billing is not active. Subscription changes are not available through this endpoint and are handled by Stripe billing, which is not yet enabled.';

export async function GET(request, context = {}) {
  try {
    const db = getDb(context);
    const householdId = getHouseholdId(request, context);

    const status = await db.transaction(async (tx) => {
      return await tx.getPdfImportQuotaStatus({ householdId });
    });

    return json({
      tier: status.tier,
      remaining: status.remaining,
      canImport: status.canImport,
      reason: status.reason,
    });
  } catch {
    return json(buildErrorBody({ status: 500, message: 'Internal Server Error' }), 500);
  }
}

export async function PATCH(_request, _context = {}) {
  return json({ error: BILLING_NOT_ACTIVE_MESSAGE, code: 'BILLING_NOT_ACTIVE' }, 501);
}
