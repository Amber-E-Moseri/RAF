import { useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { APP_NAME } from "../../lib/constants";
import rafLogo from "../../assets/raf-logo.png";
import { useAuth } from "../../context/AuthContext";
import { buildMonthOptions } from "../../lib/period";
import { usePeriod } from "./PeriodProvider";
import { useAppearance } from "./AppearanceProvider";

// ── Navigation structure ────────────────────────────────────────────────────

const desktopNavigation = [
  {
    label: "Overview",
    items: [
      { to: "/dashboard", label: "Home", icon: "home" },
      { to: "/transactions", label: "Transactions", icon: "list" },
    ],
  },
  {
    label: "Planning",
    items: [
      { to: "/plan", label: "Plan", icon: "plan" },
      { to: "/outlook", label: "Outlook", icon: "chart" },
      { to: "/monthly-review", label: "Monthly Review", icon: "calendar" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/remi", label: "Remi", icon: "remi" },
      { to: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

const mobileTabs = [
  { to: "/dashboard", label: "Home", icon: "home" },
  { to: "/transactions", label: "Transactions", icon: "list" },
  { to: "/plan", label: "Plan", icon: "plan" },
  { to: "/outlook", label: "Outlook", icon: "chart" },
];

// ── Icon components ─────────────────────────────────────────────────────────

function NavIcon({ type }: { type: string }) {
  if (type === "home") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5 10.5V20h14v-9.5" />
      </svg>
    );
  }
  if (type === "list") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M8 6h11M8 12h11M8 18h11M4 6h.01M4 12h.01M4 18h.01" />
      </svg>
    );
  }
  if (type === "plan") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <path d="M14 17.5h7M17.5 14v7" />
      </svg>
    );
  }
  if (type === "chart") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19h16" />
        <path d="M7 16V9" />
        <path d="M12 16V5" />
        <path d="M17 16v-3" />
      </svg>
    );
  }
  if (type === "calendar") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      </svg>
    );
  }
  if (type === "remi") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <path d="M8 10h.01M12 10h.01M16 10h.01" />
      </svg>
    );
  }
  if (type === "settings") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    );
  }
  if (type === "more") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="6" cy="12" r="1.2" fill="currentColor" />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" />
        <circle cx="18" cy="12" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (type === "plus") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10.5V20h14v-9.5" />
    </svg>
  );
}

// ── Period picker (desktop sidebar) ────────────────────────────────────────

function PeriodPicker({
  activeMonth,
  activeMonthLabel,
  isCurrentMonth,
  monthOptions,
  onPrev,
  onNext,
  onCurrent,
  onSelect,
}: {
  activeMonth: string;
  activeMonthLabel: string;
  isCurrentMonth: boolean;
  monthOptions: Array<{ value: string; label: string }>;
  onPrev: () => void;
  onNext: () => void;
  onCurrent: () => void;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button type="button" className="period-trigger" onClick={() => setOpen((c) => !c)}>
        <span>{activeMonthLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="period-menu">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button type="button" className="period-menu-button" onClick={onPrev}>Previous</button>
            <span className="text-[11px] font-semibold text-[var(--text-primary)]">{activeMonthLabel}</span>
            <button type="button" className="period-menu-button" disabled={isCurrentMonth} onClick={onNext}>Next</button>
          </div>
          <button
            type="button"
            className="period-menu-current"
            onClick={() => { onCurrent(); setOpen(false); }}
          >
            Current month
          </button>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {monthOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`period-option${option.value === activeMonth ? " period-option-active" : ""}`}
                onClick={() => { onSelect(option.value); setOpen(false); }}
              >
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Topbar month switch ────────────────────────────────────────────────────

function TopbarMonthSwitch({
  label,
  isCurrentMonth,
  onPrev,
  onNext,
}: {
  label: string;
  isCurrentMonth: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-[6px]">
      <button type="button" className="topbar-iconbtn" onClick={onPrev} title="Previous month" aria-label="Previous month">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <span className="topbar-month-pill">{label}</span>
      <button type="button" className="topbar-iconbtn" onClick={onNext} disabled={isCurrentMonth} title="Next month" aria-label="Next month">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M9 18l6-6-6-6" /></svg>
      </button>
    </div>
  );
}

// ── Sidebar group ─────────────────────────────────────────────────────────

function SidebarGroup({ label, items }: { label: string; items: Array<{ to: string; label: string; icon: string }> }) {
  return (
    <section className="space-y-1">
      <h3 className="nav-group-title">{label}</h3>
      <div className="space-y-[2px]">
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? "nav-link nav-link-active" : "nav-link"}>
            <span className="inline-flex h-4 w-4 items-center justify-center flex-shrink-0">
              <NavIcon type={item.icon} />
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </section>
  );
}

// ── Quick Add dropdown ────────────────────────────────────────────────────

const QUICK_ADD_ITEMS = [
  { label: "Add income", icon: "income", to: "/income/new" },
  { label: "Add transaction", icon: "tx", to: "/transactions" },
  { divider: true },
  { label: "Fund goal", icon: "goal", to: "/plan?tab=goals" },
  { label: "Record debt payment", icon: "debt", to: "/plan?tab=debts" },
  { divider: true },
  { label: "Add goal", icon: "goal", to: "/plan?tab=goals" },
  { label: "Add debt", icon: "debt", to: "/plan?tab=debts" },
] as const;

function QuickAddIcon({ icon }: { icon: string }) {
  if (icon === "income") return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  );
  if (icon === "tx") return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h11M8 12h11M8 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
  );
  if (icon === "goal") return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
  );
  if (icon === "debt") return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M16 13h2" /><path d="M3 9V7a2 2 0 0 1 2-2h12" /></svg>
  );
  return null;
}

function QuickAddMenu({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <div className="quick-add-menu" role="menu" aria-label="Quick add">
      {QUICK_ADD_ITEMS.map((item, i) => {
        if ("divider" in item && item.divider) {
          return <div key={`div-${i}`} className="quick-add-divider" />;
        }
        if ("to" in item) {
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="quick-add-item"
              onClick={() => { onClose(); navigate(item.to); }}
            >
              <span className="quick-add-item-icon">
                <QuickAddIcon icon={item.icon} />
              </span>
              <span>{item.label}</span>
            </button>
          );
        }
        return null;
      })}
    </div>
  );
}

// ── Mobile "More" sheet ────────────────────────────────────────────────────

function MobileMoreSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  const moreItems = [
    { label: "Monthly Review", icon: "calendar", to: "/monthly-review" },
    { label: "Remi", icon: "remi", to: "/remi" },
    { label: "Settings", icon: "settings", to: "/settings" },
  ];

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed bottom-0 left-0 right-0 z-50 rounded-t-[22px] bg-[var(--surface-card)] pb-safe pt-2"
        style={{ boxShadow: "0 -8px 40px rgba(17,24,39,.12)" }}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--border-strong)]" />
        <div className="px-4 pb-6">
          <p className="mb-3 text-[11px] font-[900] uppercase tracking-[0.1em] text-[var(--text-secondary)]">More</p>
          <div className="grid grid-cols-3 gap-2">
            {moreItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className="flex flex-col items-center gap-2 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2 py-4 text-[11px] font-[800] text-[var(--text-primary)] transition hover:bg-[var(--surface-muted)]"
                style={{ boxShadow: "var(--shadow-sm)" }}
                onClick={() => { onClose(); navigate(item.to); }}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--theme-soft)] text-[var(--theme-accent)]">
                  <NavIcon type={item.icon} />
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Initials helper ───────────────────────────────────────────────────────

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "U";
}

// ── App layout ────────────────────────────────────────────────────────────

export function AppLayout() {
  const { session, switchWorkspace } = useAuth();
  const {
    activeMonth,
    activeMonthLabel,
    isCurrentMonth,
    nextMonth,
    prevMonth,
    jumpToCurrentMonth,
    setActiveMonth,
  } = usePeriod();
  const monthOptions = useMemo(() => buildMonthOptions(activeMonth), [activeMonth]);
  const { preferences, togglePrivacyMode } = useAppearance();
  const workspaces = session?.workspaces ?? [];
  const activeWorkspaceId = session?.workspaceId ?? session?.householdId;
  const initials = getInitials(null, session?.email);

  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const quickAddRef = useRef<HTMLDivElement>(null);

  return (
    <div className="theme-shell app-grid">
      {/* ── Dark sidebar (desktop only) ── */}
      <aside className="hidden md:flex sidebar-shell">
        <div className="sidebar-brand">
          <img src={rafLogo} alt="RAF" className="brand-logo" />
          <div>
            <p className="sidebar-brand-name">{APP_NAME}</p>
            <p className="sidebar-brand-sub">Revenue Allocation Formula</p>
          </div>
        </div>

        {workspaces.length > 1 ? (
          <select
            className="ui-field mb-3 text-[12px] font-semibold"
            aria-label="Active household"
            value={activeWorkspaceId}
            onChange={(event) => switchWorkspace(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
            ))}
          </select>
        ) : null}

        <PeriodPicker
          activeMonth={activeMonth}
          activeMonthLabel={activeMonthLabel}
          isCurrentMonth={isCurrentMonth}
          monthOptions={monthOptions}
          onPrev={prevMonth}
          onNext={nextMonth}
          onCurrent={jumpToCurrentMonth}
          onSelect={setActiveMonth}
        />

        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto">
          {desktopNavigation.map((group) => (
            <SidebarGroup key={group.label} label={group.label} items={group.items} />
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            aria-pressed={preferences.privacy_mode}
            onClick={togglePrivacyMode}
            className={["sidebar-action w-full", preferences.privacy_mode ? "opacity-60" : ""].filter(Boolean).join(" ")}
            title={preferences.privacy_mode ? "Privacy mode on" : "Privacy mode off"}
          >
            <span className="inline-flex h-4 w-4 items-center justify-center flex-shrink-0" aria-hidden="true">
              {preferences.privacy_mode ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" /></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </span>
            <span>{preferences.privacy_mode ? "Privacy on" : "Privacy off"}</span>
          </button>
        </div>
      </aside>

      {/* ── Right-side content shell ── */}
      <div className="shell">
        {/* Mobile header */}
        <header className="mobile-top">
          <div className="flex items-center gap-2">
            <img src={rafLogo} alt="RAF" className="brand-logo" />
            <div className="leading-none">
              <p className="text-[15px] font-bold text-[var(--text-primary)]">{APP_NAME}</p>
              <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Revenue Allocation Formula</p>
            </div>
          </div>
          <PeriodPicker
            activeMonth={activeMonth}
            activeMonthLabel={activeMonthLabel}
            isCurrentMonth={isCurrentMonth}
            monthOptions={monthOptions}
            onPrev={prevMonth}
            onNext={nextMonth}
            onCurrent={jumpToCurrentMonth}
            onSelect={setActiveMonth}
          />
        </header>

        {/* Desktop topbar */}
        <header className="topbar-desktop hidden md:flex">
          <div className="flex items-center gap-2">
            <TopbarMonthSwitch
              label={activeMonthLabel}
              isCurrentMonth={isCurrentMonth}
              onPrev={prevMonth}
              onNext={nextMonth}
            />
          </div>
          <div className="flex items-center gap-[7px]">
            {preferences.privacy_mode ? (
              <span className="topbar-privacy-badge">Privacy on</span>
            ) : null}

            {/* Quick Add button */}
            <div className="relative" ref={quickAddRef}>
              <button
                type="button"
                className="topbar-iconbtn"
                title="Quick add"
                aria-label="Quick add"
                aria-expanded={quickAddOpen}
                onClick={() => setQuickAddOpen((o) => !o)}
              >
                <NavIcon type="plus" />
              </button>
              {quickAddOpen && (
                <>
                  <div
                    className="fixed inset-0 z-50"
                    onClick={() => setQuickAddOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="relative z-[60]">
                    <QuickAddMenu onClose={() => setQuickAddOpen(false)} />
                  </div>
                </>
              )}
            </div>

            <NavLink to="/settings?tab=profile" className="topbar-avatar" title="Profile" aria-label="Profile">
              {initials}
            </NavLink>
          </div>
        </header>

        <main className="shell-content">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="mobile-bottom-nav" aria-label="Primary navigation">
          {mobileTabs.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? "mobile-tab mobile-tab-active" : "mobile-tab"}>
              <span className="inline-flex h-4 w-4 items-center justify-center">
                <NavIcon type={item.icon} />
              </span>
              <span>{item.label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            className={`mobile-tab${moreOpen ? " mobile-tab-active" : ""}`}
            onClick={() => setMoreOpen((o) => !o)}
            aria-label="More"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center">
              <NavIcon type="more" />
            </span>
            <span>More</span>
          </button>
        </nav>

        {moreOpen && <MobileMoreSheet onClose={() => setMoreOpen(false)} />}
      </div>
    </div>
  );
}
