import type { ReactNode } from "react";

import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

interface SummaryMetricCardProps {
  title: string;
  value: string;
  subtitle: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  badge?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function SummaryMetricCard({ title, value, subtitle, tone = "neutral", badge, icon, action }: SummaryMetricCardProps) {
  return (
    <Card className="summary-metric-card min-h-[100px] overflow-hidden sm:min-h-[110px]">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] text-[var(--text-secondary)]" style={{ fontWeight: 750 }}>{title}</p>
          {badge ? <Badge tone={tone}>{badge}</Badge> : null}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="financial-value text-[25px] leading-none text-[var(--text-primary)]" style={{ fontWeight: 900, letterSpacing: "-0.045em" }}>{value}</p>
            <p className="mt-1.5 text-[10px] font-medium text-[var(--text-secondary)]">{subtitle}</p>
            {action ? <div className="mt-2">{action}</div> : null}
          </div>
          {icon ? <div className="text-[var(--text-subtle)]">{icon}</div> : null}
        </div>
      </div>
    </Card>
  );
}
