import { json, getDb } from '../../_shared/http.js';
import { getRemiEntitlementStatus } from '../../../../../lib/entitlement/remiEntitlement.js';

// Billing is managed exclusively via the Stripe webhook at /api/v1/billing/webhook.
// This endpoint is intentionally disabled to prevent self-promotion to paid tier.
export async function PATCH(_request, _context) {
  return json({ error: 'Billing management is not available through this endpoint. Subscription changes are processed via Stripe.' }, 501);
}

export async function GET(request, context) {
  const db = getDb(context);
  const userId = context?.userId ?? 'local-user';
  const workspaceId = context?.workspaceId;

  if (!workspaceId) {
    return json({ error: 'Workspace context required' }, 400);
  }

  // Return workspace Remi tier (not user tier)
  const status = await getRemiEntitlementStatus(db, workspaceId);

  return json({
    userId,
    workspaceId,
    tier: status.tier,
    message: status.message,
  });
}
