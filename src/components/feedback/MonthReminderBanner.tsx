import { Link } from "react-router-dom";

import { formatMonthLabel } from "../../lib/period";
import { Badge } from "../ui/Badge";

interface MonthReminderBannerProps {
  monthKey: string;
  tone?: "warning" | "danger";
  ctaLabel?: string;
}

export function MonthReminderBanner({
  monthKey,
  tone = "warning",
  ctaLabel = "Review month",
}: MonthReminderBannerProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--badge-warning-ring)] bg-[var(--badge-warning-bg)] px-4 py-3 text-sm text-[var(--badge-warning-text)]">
      <div className="flex items-center gap-3">
        <Badge tone={tone}>{tone === "danger" ? "Needs attention" : "Still open"}</Badge>
        <p>
          {formatMonthLabel(monthKey)} is still open. Review and close it before continuing.
        </p>
      </div>
      <Link className="text-sm font-semibold text-[var(--badge-warning-text)] underline-offset-4 hover:underline" to="/monthly-review">
        {ctaLabel}
      </Link>
    </div>
  );
}
