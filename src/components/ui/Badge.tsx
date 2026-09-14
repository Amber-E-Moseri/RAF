import type { ReactNode } from "react";

interface BadgeProps {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", children, className = "" }: BadgeProps) {
  const classes = {
    neutral: "bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-text)]",
    success: "bg-[var(--badge-success-bg)] text-[var(--badge-success-text)]",
    warning: "bg-[var(--badge-warning-bg)] text-[var(--badge-warning-text)]",
    danger: "bg-[var(--badge-danger-bg)] text-[var(--badge-danger-text)]",
  }[tone];

  return <span className={`inline-flex items-center rounded-full px-2 py-[5px] text-[9px] font-[900] whitespace-nowrap ${classes} ${className}`.trim()}>{children}</span>;
}
