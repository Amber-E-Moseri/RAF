import { useSearchParams } from "react-router-dom";

import { PageShell } from "../components/layout/PageShell";
import { AppearanceSettings } from "./AppearanceSettings";
import { Members } from "./Members";

type SettingsTab = "household" | "appearance" | "financial" | "import-rules";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "household", label: "Household" },
  { id: "appearance", label: "Appearance" },
  { id: "financial", label: "Financial" },
  { id: "import-rules", label: "Import Rules" },
];

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as SettingsTab | null) ?? "household";

  function setTab(tab: SettingsTab) {
    setSearchParams({ tab }, { replace: true });
  }

  const validTab = TABS.some((t) => t.id === activeTab) ? activeTab : "household";

  return (
    <PageShell
      eyebrow="Settings"
      title="Make RAF feel like yours."
      description="Manage your household, appearance, financial categories and import rules."
    >
      <nav className="page-tabs" aria-label="Settings sections">
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

      <div className="mt-2">
        {validTab === "household" && <Members bare />}
        {validTab === "appearance" && <AppearanceSettings tab="preferences" />}
        {validTab === "financial" && <AppearanceSettings tab="savings_floor" />}
        {validTab === "import-rules" && <AppearanceSettings tab="import_rules" />}
      </div>
    </PageShell>
  );
}
