import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getAllocationCategories,
  getAllocationCategoryHistory,
} from "../api/allocationCategoriesApi";
import { BufferStatusCard } from "../components/plan/BufferStatusCard";
import { PlanExecutionCard } from "../components/plan/PlanExecutionCard";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { PageShell } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { formatPercentWithDigits } from "../lib/format";
import type {
  AllocationCategory,
  AllocationCategorySnapshot,
} from "../lib/types";

function CurrentAllocationSummary() {
  const [categories, setCategories] = useState<AllocationCategory[]>([]);
  const [history, setHistory] = useState<AllocationCategorySnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [items, snapshots] = await Promise.all([
          getAllocationCategories(),
          getAllocationCategoryHistory(),
        ]);
        setCategories(items);
        setHistory(snapshots);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load allocation");
      } finally {
        setIsLoading(false);
      }
    }
    void load();
  }, []);

  const activeCategories = useMemo(
    () => categories.filter((c) => c.isActive),
    [categories]
  );

  const totalAllocatedPercent = useMemo(
    () => activeCategories.reduce((sum, c) => sum + Number(c.allocationPercent) * 100, 0),
    [activeCategories]
  );

  if (isLoading) return <LoadingState label="Loading allocation..." />;
  if (error) return <ErrorState title="Failed to load allocation" message={error} />;
  if (!activeCategories.length) {
    return (
      <EmptyState
        title="No active allocation"
        message="Set up your allocation preferences to get started."
      />
    );
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-3">
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Income allocated</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
            {totalAllocatedPercent.toFixed(0)}%
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Based on current percentages</p>
        </Card>
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Buffer share</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">
            {activeCategories.find((c) => c.slug === "buffer")
              ? formatPercentWithDigits(activeCategories.find((c) => c.slug === "buffer")!.allocationPercent, 0)
              : "0%"}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Rounding remainder routes here</p>
        </Card>
        <Card>
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Categories</p>
          <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">{activeCategories.length}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">100% total required</p>
        </Card>
      </section>

      <Card
        title="Current allocation preferences"
        subtitle="Percentages apply to income; these are not monthly spending budgets."
      >
        <div className="space-y-3">
          {activeCategories
            .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug))
            .map((category, index) => {
              const dotHue = (index * 137.5) % 360;
              const allocPercent = Number(category.allocationPercent) * 100;

              return (
                <div
                  key={category.id}
                  className="flex items-center gap-4 rounded-xl border border-[var(--border-color)] px-4 py-3"
                  style={{ background: "var(--surface-plain)" }}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: `hsl(${dotHue}, 55%, 55%)` }}
                    />
                    <span className="text-sm font-medium text-[var(--text-strong)]">
                      {category.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">
                        Share
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--text-strong)]">
                        {allocPercent.toFixed(0)}%
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">
                        Allocated
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--text-strong)]">
                        ${Math.round(allocPercent * 21)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">
                        Used
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--text-strong)]">
                        $0
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        <div className="mt-6 flex justify-end">
          <Link to="/plan/preferences">
            <Button>Edit plan →</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

export function Plan() {
  return (
    <PageShell
      eyebrow="Plan"
      title="Allocation without noise."
      description="Adjust allocation preferences, see execution, and keep Buffer visible without turning RAF into a traditional budgeting app."
    >
      <CurrentAllocationSummary />
      <PlanExecutionCard />
      <BufferStatusCard />
    </PageShell>
  );
}
