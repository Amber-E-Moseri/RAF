/**
 * Remi entitlement derivation.
 *
 * Authority: raf.workspaces.remi_tier (workspace-scoped, request-time)
 * NOT authoritative: app_users.remi_tier (legacy, no longer used for authorization)
 * NOT authoritative: session.remiTier (display only, can be stale)
 *
 * Every request that requires Remi authorization must call this function
 * to derive current entitlement from persistent workspace state.
 *
 * Fail-closed contract: every path that is not an explicit, verified
 * "active member of a workspace whose remi_tier is exactly 'paid'" resolves to
 * free. This includes missing identifiers, no membership, non-active membership,
 * a missing workspace, any other tier value, adapters that lack the required
 * methods, and thrown errors.
 */

const PAID_TIER = 'paid';
const FREE_TIER = 'free';

function freeResult(reason) {
  return { authorized: false, remiTier: FREE_TIER, reason };
}

/**
 * Derive current Remi entitlement for a user in a workspace.
 *
 * Membership is resolved only through getWorkspaceMember, and only an
 * `active` member counts (invited and suspended members are rejected).
 *
 * @param {Object} db - Database with transaction(callback) (trusted context attached by router)
 * @param {string} userId - User ID (from verified session only; never from body/headers)
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<Object>} { authorized, remiTier, reason }
 */
export async function getRemiEntitlementForRequest(db, userId, workspaceId) {
  if (!userId || !workspaceId) {
    return freeResult('invalid_context');
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      if (typeof tx?.getWorkspaceMember !== 'function') {
        return { member: false };
      }
      const member = await tx.getWorkspaceMember({ workspaceId, userId });
      if (member?.status !== 'active') {
        return { member: false };
      }

      const workspace = typeof tx.getWorkspace === 'function'
        ? await tx.getWorkspace({ workspaceId })
        : null;
      return { member: true, remiTier: workspace?.remiTier };
    });

    if (!outcome?.member) {
      return freeResult('not_member');
    }

    const authorized = outcome.remiTier === PAID_TIER;
    return {
      authorized,
      remiTier: authorized ? PAID_TIER : FREE_TIER,
      reason: authorized ? null : 'subscription_free',
    };
  } catch {
    return freeResult('entitlement_error');
  }
}

/**
 * Get Remi entitlement status for a workspace (informational, non-authoritative).
 * Used for UI display, diagnostics, upgrade prompts. Never grants capability by itself.
 *
 * @param {Object} db - Database with transaction(callback)
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<Object>} { tier, message }
 */
export async function getRemiEntitlementStatus(db, workspaceId) {
  if (!workspaceId) {
    return { tier: FREE_TIER, message: 'Invalid workspace' };
  }

  let remiTier;
  try {
    remiTier = await db.transaction(async (tx) => {
      if (typeof tx?.getWorkspace !== 'function') return null;
      const workspace = await tx.getWorkspace({ workspaceId });
      return workspace?.remiTier;
    });
  } catch {
    remiTier = null;
  }

  const tier = remiTier === PAID_TIER ? PAID_TIER : FREE_TIER;
  const message = (tier === PAID_TIER)
    ? 'Remi is enabled for this workspace'
    : 'Upgrade to enable full Remi capabilities';

  return { tier, message };
}

/**
 * Determine Remi capability level based on entitlement.
 *
 * FREE:
 *   - Knowledge-base chat (no Anthropic call)
 *   - Metrics display
 *   - Basic calculated summary
 *   - No conversation persistence
 *   - No AI-generated guidance
 *
 * PAID:
 *   - Full AI chat (Claude API)
 *   - Conversation history storage
 *   - AI-generated personalized summaries
 *   - Context-aware financial guidance
 */
export function getRemiCapabilityLevel(remiTier) {
  const paid = remiTier === PAID_TIER;
  return {
    tier: paid ? PAID_TIER : FREE_TIER,
    hasAIChat: paid,
    hasConversationHistory: paid,
    hasAISummary: paid,
    hasAdvancedGuidance: paid,
    message: paid
      ? 'Full Remi capabilities enabled'
      : 'Knowledge-base mode only',
  };
}
