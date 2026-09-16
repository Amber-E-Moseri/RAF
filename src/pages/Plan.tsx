import { useSearchParams } from "react-router-dom";

import { PageShell } from "../components/layout/PageShell";
import { AllocationPreferences } from "./AllocationPreferences";
import { Debts } from "./Debts";
import { Goals } from "./Goals";

type PlanTab = "allocations" | "goals" | "debts";

const TABS: Array<{ id: PlanTab; label: string }> = [
  { id: "allocations", label: "Allocations" },
  { id: "goals", label: "Goals" },
  { id: "debts", label: "Debts" },
];

export function Plan() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as PlanTab | null) ?? "allocations";

  function setTab(tab: PlanTab) {
    setSearchParams({ tab }, { replace: true });
  }

  const validTab = TABS.some((t) => t.id === activeTab) ? activeTab : "allocations";

  return (
    <PageShell
      eyebrow="Plan"
      title="Allocation without noise."
      description="Adjust allocation preferences, track goal progress, and manage debts — without turning RAF into a traditional budgeting app."
    >
      <nav className="page-tabs" aria-label="Plan sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`page-tab${validTab === tab.id ? " page-tab-active" : ""}`}
            onClick={() => setTab(tab.id)}
            aria-current={validTab === tab.id ? "page" : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="tab-content-wrapper">
        {validTab === "allocations" && <AllocationPreferences />}
        {validTab === "goals" && <Goals />}
        {validTab === "debts" && <Debts />}
      </div>
    </PageShell>
  );
}
