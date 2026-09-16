import { useSearchParams } from "react-router-dom";

import { PageShell } from "../components/layout/PageShell";
import { CashFlowForecast } from "./CashFlowForecast";
import { Insights } from "./Insights";

type OutlookTab = "forecast" | "reports";

const TABS: Array<{ id: OutlookTab; label: string }> = [
  { id: "forecast", label: "Forecast" },
  { id: "reports", label: "Reports" },
];

export function Outlook() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as OutlookTab | null) ?? "forecast";

  function setTab(tab: OutlookTab) {
    setSearchParams({ tab }, { replace: true });
  }

  const validTab = TABS.some((t) => t.id === activeTab) ? activeTab : "forecast";

  return (
    <PageShell
      eyebrow="Outlook"
      title="What is coming and what happened."
      description="See projected cash position for the next 30–90 days, explore spending and income patterns, and understand what changed."
    >
      <nav className="page-tabs" aria-label="Outlook sections">
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
        {validTab === "forecast" && <CashFlowForecast />}
        {validTab === "reports" && <Insights />}
      </div>
    </PageShell>
  );
}
