import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFinancialDecisions,
  buildPlanChangeDecisionMetadata,
  DECISION_ACTIONS,
} from '../lib/intelligence/financialDecisions.js';

function makeActivity(id, action, metadata = {}, created_at = '2026-09-01T10:00:00Z') {
  return { id, action, metadata, actor_user_id: 'user-1', entity_type: 'plan', entity_id: 'plan-1', created_at };
}

describe('financial decisions', () => {
  // 23. Filters to only decision actions
  it('23. extractFinancialDecisions returns only strategy-level actions', () => {
    const rows = [
      makeActivity('a1', 'plan_changed', { reason: 'Rebalanced' }),
      makeActivity('a2', 'transaction_categorized', {}),    // not a decision
      makeActivity('a3', 'goal_target_changed', { reason: 'Raised savings goal' }),
      makeActivity('a4', 'debt_strategy_changed', {}),
      makeActivity('a5', 'savings_target_changed', {}),
      makeActivity('a6', 'user_login', {}),               // not a decision
    ];
    const decisions = extractFinancialDecisions(rows);
    assert.equal(decisions.length, 4);
    const actions = decisions.map((d) => d.action);
    assert.ok(actions.includes('plan_changed'));
    assert.ok(actions.includes('goal_target_changed'));
    assert.ok(actions.includes('debt_strategy_changed'));
    assert.ok(actions.includes('savings_target_changed'));
    assert.ok(!actions.includes('transaction_categorized'));
    assert.ok(!actions.includes('user_login'));
  });

  // 24. Sorted newest first
  it('24. decisions are returned newest-first', () => {
    const rows = [
      makeActivity('a1', 'plan_changed', {}, '2026-07-01T00:00:00Z'),
      makeActivity('a2', 'plan_changed', {}, '2026-09-01T00:00:00Z'),
      makeActivity('a3', 'plan_changed', {}, '2026-08-01T00:00:00Z'),
    ];
    const decisions = extractFinancialDecisions(rows);
    assert.equal(decisions[0].id, 'a2'); // newest
    assert.equal(decisions[1].id, 'a3');
    assert.equal(decisions[2].id, 'a1'); // oldest
  });

  // 25. Metadata fields are surfaced correctly
  it('25. reason, before, after, effectiveFrom extracted from metadata', () => {
    const rows = [
      makeActivity('a1', 'plan_changed', {
        reason: 'Cost of living adjustment',
        before: { savings: 0.20 },
        after: { savings: 0.25 },
        effectiveFrom: '2026-09-01',
        relatedEntity: 'allocation_plan',
      }),
    ];
    const decisions = extractFinancialDecisions(rows);
    const d = decisions[0];
    assert.equal(d.reason, 'Cost of living adjustment');
    assert.deepEqual(d.before, { savings: 0.20 });
    assert.deepEqual(d.after, { savings: 0.25 });
    assert.equal(d.effectiveFrom, '2026-09-01');
    assert.equal(d.relatedEntity, 'allocation_plan');
  });

  // 26. DECISION_ACTIONS set completeness
  it('26. DECISION_ACTIONS contains all four strategy-level action types', () => {
    assert.ok(DECISION_ACTIONS.has('plan_changed'));
    assert.ok(DECISION_ACTIONS.has('goal_target_changed'));
    assert.ok(DECISION_ACTIONS.has('debt_strategy_changed'));
    assert.ok(DECISION_ACTIONS.has('savings_target_changed'));
  });

  // 27. buildPlanChangeDecisionMetadata shapes payload correctly
  it('27. buildPlanChangeDecisionMetadata produces correct payload shape', () => {
    const meta = buildPlanChangeDecisionMetadata({
      before: { savings: 0.20 },
      after: { savings: 0.25 },
      reason: 'Increased savings rate',
      effectiveFrom: '2026-09-01',
    });
    assert.deepEqual(meta.before, { savings: 0.20 });
    assert.deepEqual(meta.after, { savings: 0.25 });
    assert.equal(meta.reason, 'Increased savings rate');
    assert.equal(meta.effectiveFrom, '2026-09-01');
    assert.equal(meta.relatedEntity, 'allocation_plan');
  });

  // 28. Empty rows → empty result
  it('28. empty activity rows → empty decisions', () => {
    const decisions = extractFinancialDecisions([]);
    assert.deepEqual(decisions, []);
  });
});
