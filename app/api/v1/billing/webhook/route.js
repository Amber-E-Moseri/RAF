import { json } from '../../_shared/http.js';

/**
 * Stripe webhook endpoint: NOT IMPLEMENTED.
 *
 * This endpoint processes nothing. No Stripe event is verified, parsed, stored, or
 * applied, and no subscription, Remi tier, or PDF quota tier is changed. Billing is
 * not active and no charges occur. See docs/BILLING_STATUS.md.
 *
 * Required before this endpoint may process any event (not yet done):
 *   TODO(billing): verify the Stripe-Signature header against the raw request body
 *   with the Stripe SDK (stripe.webhooks.constructEvent) and a configured
 *   STRIPE_WEBHOOK_SECRET. Reject unverified requests with 400 before any parsing or
 *   state change. Signature verification MUST exist before any event is processed.
 *   TODO(billing): decide how a verified event maps to a privileged write path. The
 *   only permitted writer of raf.workspaces.remi_tier is a privileged billing service
 *   role (see db/migrations/20261012020000_protect_workspace_remi_tier.sql).
 *
 * Until then, every request returns 501 and is not processed.
 */
export async function POST(_request, _context) {
  console.warn('[RAF billing] Stripe webhook received; billing is not implemented, event not processed');
  return json(
    {
      error: 'Stripe billing webhook is not implemented. No events are processed and no charges occur.',
      code: 'BILLING_WEBHOOK_NOT_IMPLEMENTED',
      processed: false,
    },
    501,
  );
}
