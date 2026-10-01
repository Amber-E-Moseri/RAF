/**
 * Remi entitlement derivation.
 *
 * Authority: raf.workspaces.remi_tier (workspace-scoped, request-time)
 * NOT authoritative: app_users.remi_tier (legacy, no longer used for authorization)
 * NOT authoritative: session.remiTier (display only, can be stale)
 *
 * Every request that requires Remi authorization must call this function
 * to derive current entitlement from persistent workspace state.
 * This ensures:
 *   - Stale session cannot grant capability after downgrade
 *   - Workspace switching immediately reflects new tier
 *   - No login required after entitlement change
 */

/**
 * Derive current Remi entitlement for a user in a workspace.
 *
 * @param {Object} db - Database transaction object
 * @param {string} userId - User ID
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<Object>} Entitlement { authorized, remiTier, reason }
 *
 * Returns:
 *   { authorized: true, remiTier: 'paid' }
 *   { authorized: false, remiTier: 'free', reason: 'subscription_free' }
 *   { authorized: false, remiTier: 'free', reason: 'not_member' }
 */
export async function getRemiEntitlementForRequest(db, userId, workspaceId) {
  if (!userId || !workspaceId) {
    return { authorized: false, remiTier: 'free', reason: 'invalid_context' };
  }

  // 1. Verify user is active member of this workspace
  const membership = await db.transaction(async (tx) => {
    // Use raw workspace_members table, or repository method if available
    if (typeof tx.getWorkspaceMembership === 'function') {
      return tx.getWorkspaceMembership({ userId, workspaceId });
    }
    // Fallback: query raw (for testing)
    return null;
  });

  if (!membership) {
    // Explicitly not a member → reject
    return { authorized: false, remiTier: 'free', reason: 'not_member' };
  }

  // 2. Get workspace Remi tier (source of truth)
  const workspace = await db.transaction(async (tx) => {
    if (typeof tx.getWorkspace === 'function') {
      return tx.getWorkspace({ workspaceId });
    }
    // Fallback: return null to trigger free tier
    return null;
  });

  const remiTier = workspace?.remiTier ?? 'free';

  // 3. Determine authorization
  const authorized = (remiTier === 'paid');

  return {
    authorized,
    remiTier,
    reason: authorized ? null : 'subscription_free',
  };
}

/**
 * Get Remi entitlement status for a workspace (informational, non-authoritative).
 * Used for UI display, diagnostics, upgrade prompts.
 *
 * @param {Object} db - Database transaction object
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<Object>} Status { tier, message }
 */
export async function getRemiEntitlementStatus(db, workspaceId) {
  if (!workspaceId) {
    return { tier: 'free', message: 'Invalid workspace' };
  }

  const workspace = await db.transaction(async (tx) => {
    if (typeof tx.getWorkspace === 'function') {
      return tx.getWorkspace({ workspaceId });
    }
    return null;
  });

  const tier = workspace?.remiTier ?? 'free';
  const message = (tier === 'paid')
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
  return {
    tier: remiTier,
    hasAIChat: (remiTier === 'paid'),
    hasConversationHistory: (remiTier === 'paid'),
    hasAISummary: (remiTier === 'paid'),
    hasAdvancedGuidance: (remiTier === 'paid'),
    message: (remiTier === 'paid')
      ? 'Full Remi capabilities enabled'
      : 'Knowledge-base mode only',
  };
}
