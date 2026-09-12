import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanHistory, computePlanDiff } from '../lib/intelligence/planHistory.js';

function makeCategory(snapshotId, slug, percent, overrides = {}) {
  return {
    snapshot_id: snapshotId,
    slug,
    label: slug,
    allocation_percent: percent,
    is_active: true,
    is_buffer: false,
    effective_from: overrides.effectiveFrom ?? '2026-01-01',
    superseded_at: overrides.supersededAt ?? null,
    sort_order: overrides.sortOrder ?? 0,
  };
}

describe('plan history', () => {
  // 17. Empty categories → empty history
  it('17. returns empty array when no categories provided', () => {
    const history = buildPlanHistory([]);
    assert.deepEqual(history, []);
  });

  // 18. Single snapshot groups correctly
  it('18. single snapshot_id produces one history entry', () => {
    const cats = [
      makeCategory('snap-1', 'savings', 0.20, { effectiveFrom: '2026-01-01' }),
      makeCategory('snap-1', 'dining', 0.15, { effectiveFrom: '2026-01-01' }),
    ];
    const history = buildPlanHistory(cats);
    assert.equal(history.length, 1);
    assert.equal(history[0].snapshotId, 'snap-1');
    assert.equal(history[0].categories.length, 2);
    assert.equal(history[0].diff, null); // oldest snapshot has no predecessor
  });

  // 19. Two snapshots: newest first, diff computed
  it('19. two snapshots are ordered newest first and diff is computed', () => {
    const cats = [
      // Older snapshot
      makeCategory('snap-1', 'savings', 0.20, { effectiveFrom: '2026-01-01' }),
      makeCategory('snap-1', 'dining', 0.15, { effectiveFrom: '2026-01-01' }),
      // Newer snapshot
      makeCategory('snap-2', 'savings', 0.25, { effectiveFrom: '2026-06-01' }),
      makeCategory('snap-2', 'dining', 0.10, { effectiveFrom: '2026-06-01' }),
    ];
    const history = buildPlanHistory(cats);
    assert.equal(history.length, 2);
    assert.equal(history[0].snapshotId, 'snap-2'); // newest first
    assert.equal(history[1].snapshotId, 'snap-1'); // oldest last

    // Diff on newest should show what changed vs snap-1
    const diff = history[0].diff;
    assert.ok(Array.isArray(diff));
    const savingsDiff = diff.find((d) => d.slug === 'savings');
    assert.ok(savingsDiff, 'savings should appear in diff');
    assert.equal(savingsDiff.deltaPercent, 0.05); // 0.25 - 0.20
    const diningDiff = diff.find((d) => d.slug === 'dining');
    assert.ok(diningDiff, 'dining should appear in diff');
    assert.equal(diningDiff.deltaPercent, -0.05); // 0.10 - 0.15
  });

  // 20. Reason attached from workspace_activity metadata
  it('20. reason from workspace_activity attached to matching effectiveFrom snapshot', () => {
    const cats = [
      makeCategory('snap-1', 'savings', 0.20, { effectiveFrom: '2026-01-01' }),
      makeCategory('snap-2', 'savings', 0.25, { effectiveFrom: '2026-06-01' }),
    ];
    const activities = [
      {
        id: 'act-1',
        action: 'plan_changed',
        metadata: { reason: 'Bumped savings target', effectiveFrom: '2026-06-01' },
        created_at: '2026-06-01T10:00:00Z',
      },
    ];
    const history = buildPlanHistory(cats, activities);
    const newestSnap = history.find((h) => h.snapshotId === 'snap-2');
    assert.equal(newestSnap.reason, 'Bumped savings target');
  });

  // computePlanDiff tests
  it('21. computePlanDiff returns only changed categories', () => {
    const before = [
      { slug: 'savings', allocationPercent: 0.20, isActive: true },
      { slug: 'dining', allocationPercent: 0.15, isActive: true },
      { slug: 'gas', allocationPercent: 0.05, isActive: true },
    ];
    const after = [
      { slug: 'savings', allocationPercent: 0.20, isActive: true }, // unchanged
      { slug: 'dining', allocationPercent: 0.18, isActive: true },  // changed
      { slug: 'gas', allocationPercent: 0.05, isActive: false },    // deactivated
    ];
    const diff = computePlanDiff(before, after);
    assert.equal(diff.length, 2);
    const slugs = diff.map((d) => d.slug);
    assert.ok(slugs.includes('dining'));
    assert.ok(slugs.includes('gas'));
    assert.ok(!slugs.includes('savings'));
  });

  it('22. computePlanDiff handles new categories (added)', () => {
    const before = [{ slug: 'savings', allocationPercent: 0.20, isActive: true }];
    const after = [
      { slug: 'savings', allocationPercent: 0.20, isActive: true },
      { slug: 'travel', allocationPercent: 0.10, isActive: true },  // new
    ];
    const diff = computePlanDiff(before, after);
    assert.equal(diff.length, 1);
    assert.equal(diff[0].slug, 'travel');
    assert.equal(diff[0].before, null);
    assert.equal(diff[0].deltaPercent, null); // no before value
  });
});
