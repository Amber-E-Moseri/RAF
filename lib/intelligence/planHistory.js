/**
 * Plan History — surfaces the existing allocation_categories snapshot infrastructure.
 * Never creates a separate plan-history table; reads snapshot_id / effective_from / superseded_at.
 */

/**
 * Group allocation_category rows into ordered plan snapshots.
 * Each snapshot = one version of the plan (same snapshot_id).
 *
 * @param {Array} categories  All allocation_category rows for the workspace,
 *                            with fields: snapshot_id, slug, label, allocation_percent,
 *                            is_active, effective_from, superseded_at, sort_order
 * @param {Array} [activities]  Optional workspace_activity rows with action='plan_changed'
 *                              and metadata.reason to attach user reasons.
 * @returns {Array} Ordered plan snapshots, newest first.
 *   Each entry: { snapshotId, effectiveFrom, supersededAt, reason, categories }
 *   categories: [{ slug, label, allocationPercent, isActive }]
 */
export function buildPlanHistory(categories, activities = []) {
  if (!Array.isArray(categories) || categories.length === 0) return [];

  // Index activity reasons by effective_from date (ISO date string).
  const reasonByDate = new Map();
  for (const act of activities) {
    const meta = act.metadata ?? {};
    if (meta.reason && meta.effectiveFrom) {
      reasonByDate.set(meta.effectiveFrom, meta.reason);
    }
  }

  // Group by snapshot_id.
  const snapshotMap = new Map();
  for (const cat of categories) {
    const sid = cat.snapshotId ?? cat.snapshot_id;
    if (!sid) continue;
    if (!snapshotMap.has(sid)) {
      snapshotMap.set(sid, {
        snapshotId: sid,
        effectiveFrom: cat.effectiveFrom ?? cat.effective_from ?? null,
        supersededAt: cat.supersededAt ?? cat.superseded_at ?? null,
        categories: [],
      });
    }
    const snap = snapshotMap.get(sid);
    snap.categories.push({
      slug: cat.slug,
      label: cat.label,
      allocationPercent: Number(cat.allocationPercent ?? cat.allocation_percent ?? 0),
      isActive: cat.isActive ?? cat.is_active ?? true,
      isBuffer: cat.isBuffer ?? cat.is_buffer ?? false,
      sortOrder: cat.sortOrder ?? cat.sort_order ?? 0,
    });
  }

  // Sort each snapshot's categories.
  for (const snap of snapshotMap.values()) {
    snap.categories.sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
  }

  // Produce ordered snapshots (newest first) and annotate with diffs.
  const snapshots = [...snapshotMap.values()]
    .sort((a, b) => (b.effectiveFrom > a.effectiveFrom ? 1 : -1));

  // Attach reason from activity log.
  for (const snap of snapshots) {
    snap.reason = reasonByDate.get(snap.effectiveFrom) ?? null;
  }

  // Compute before→after diffs (relative to the next-older snapshot).
  for (let i = 0; i < snapshots.length - 1; i++) {
    const current = snapshots[i];
    const previous = snapshots[i + 1];
    current.diff = computePlanDiff(previous.categories, current.categories);
  }
  if (snapshots.length > 0) {
    const oldest = snapshots[snapshots.length - 1];
    oldest.diff = null; // no predecessor
  }

  return snapshots;
}

/**
 * Compute the before→after diff between two plan versions.
 * Returns only categories that changed.
 */
export function computePlanDiff(before, after) {
  const beforeBySlug = new Map(before.map((c) => [c.slug, c]));
  const afterBySlug = new Map(after.map((c) => [c.slug, c]));
  const allSlugs = new Set([...beforeBySlug.keys(), ...afterBySlug.keys()]);

  const changes = [];
  for (const slug of allSlugs) {
    const b = beforeBySlug.get(slug) ?? null;
    const a = afterBySlug.get(slug) ?? null;

    const beforePct = b?.allocationPercent ?? null;
    const afterPct = a?.allocationPercent ?? null;

    if (beforePct === afterPct && (b?.isActive ?? null) === (a?.isActive ?? null)) continue;

    changes.push({
      slug,
      label: a?.label ?? b?.label ?? slug,
      before: b ? { allocationPercent: beforePct, isActive: b.isActive } : null,
      after: a ? { allocationPercent: afterPct, isActive: a.isActive } : null,
      deltaPercent: beforePct !== null && afterPct !== null
        ? Number((afterPct - beforePct).toFixed(4))
        : null,
    });
  }

  return changes;
}
