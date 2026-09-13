import { useSearchParams } from "react-router-dom";

import { PageShell } from "../components/layout/PageShell";
import { AllocationPreferences } from "./AllocationPreferences";
import { Debts } from "./Debts";
import { Goals } from "./Goals";

type PlanTab = "allocations" | "goals" | "debts";

const VALID_PLAN_TABS: PlanTab[] = ["allocations", "goals", "debts"];

const planTabs: Array<{ id: PlanTab; label: string }> = [
  { id: "allocations", label: "Allocations" },
  { id: "goals", label: "Goals" },
  { id: "debts", label: "Debts" },
];

export function Plan() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab") as PlanTab | null;
  const activeTab: PlanTab = rawTab && VALID_PLAN_TABS.includes(rawTab) ? rawTab : "allocations";

  function setTab(tab: PlanTab) {
    setSearchParams({ tab }, { replace: true });
  }

  return (
    <PageShell
      eyebrow="Plan"
      title="Plan"
      description="Manage your allocation percentages and savings goals."
    >
      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {planTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTab(tab.id)}
            className={`px-4 py-2 text-[13px] font-semibold transition-colors ${
              activeTab === tab.id
                ? "border-b-2 border-[var(--primary-color)] text-[var(--primary-color)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "allocations" ? <AllocationPreferences embedded /> : null}
      {activeTab === "goals" ? <Goals embedded /> : null}
      {activeTab === "debts" ? <Debts embedded /> : null}
    </PageShell>
  );
}
