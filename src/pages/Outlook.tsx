import { useSearchParams } from "react-router-dom";

import { PageShell } from "../components/layout/PageShell";
import { CashFlowForecast } from "./CashFlowForecast";
import { Insights } from "./Insights";

type OutlookTab = "forecast" | "reports";

const VALID_OUTLOOK_TABS: OutlookTab[] = ["forecast", "reports"];

const outlookTabs: Array<{ id: OutlookTab; label: string }> = [
  { id: "forecast", label: "Forecast" },
  { id: "reports", label: "Reports" },
];

export function Outlook() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab") as OutlookTab | null;
  const activeTab: OutlookTab = rawTab && VALID_OUTLOOK_TABS.includes(rawTab) ? rawTab : "forecast";

  function setTab(tab: OutlookTab) {
    setSearchParams({ tab }, { replace: true });
  }

  return (
    <PageShell
      eyebrow="Outlook"
      title="Outlook"
      description="Forward-looking cash flow projections, scenario planning, and financial health reports."
    >
      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {outlookTabs.map((tab) => (
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

      {activeTab === "forecast" ? <CashFlowForecast embedded /> : null}
      {activeTab === "reports" ? <Insights embedded /> : null}
    </PageShell>
  );
}
