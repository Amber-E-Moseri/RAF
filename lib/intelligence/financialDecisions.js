/**
 * Financial Decisions — narrative context around real authoritative changes.
 * Backed by raf.workspace_activity; no separate table is created.
 *
 * Only strategy-level choices qualify:
 *   plan_changed, goal_target_changed, debt_strategy_changed, savings_target_changed
 *
 * Every individual transaction categorization does NOT qualify.
 */

export const DECISION_ACTIONS = new Set([
  'plan_changed',
  'goal_target_changed',
  'debt_strategy_changed',
  'savings_target_changed',
]);

/**
 * Filter raw workspace_activity rows to financial-decision events only.
 * Each returned item is shaped for UI consumption.
 */
export function extractFinancialDecisions(activityRows) {
  return activityRows
    .filter((row) => DECISION_ACTIONS.has(row.action))
    .map((row) => {
      const meta = row.metadata ?? {};
      return {
        id: row.id,
        date: row.createdAt ?? row.created_at,
        actorUserId: row.actorUserId ?? row.actor_user_id ?? null,
        action: row.action,
        entityType: row.entityType ?? row.entity_type ?? null,
        entityId: row.entityId ?? row.entity_id ?? null,
        reason: meta.reason ?? null,
        before: meta.before ?? null,
        after: meta.after ?? null,
        relatedEntity: meta.relatedEntity ?? null,
        effectiveFrom: meta.effectiveFrom ?? null,
      };
    })
    .sort((a, b) => (b.date > a.date ? 1 : -1));
}

/**
 * Build the metadata payload to attach to a workspace_activity row when a
 * plan change is recorded.
 */
export function buildPlanChangeDecisionMetadata({ before, after, reason = null, effectiveFrom }) {
  return {
    before,
    after,
    reason: reason ?? null,
    effectiveFrom: effectiveFrom ?? null,
    relatedEntity: 'allocation_plan',
  };
}
