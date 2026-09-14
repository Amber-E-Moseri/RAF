import type { ReactNode } from "react";

interface BadgeProps {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", children, className = "" }: BadgeProps) {
  const classes = {
    neutral: "bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-text)] border border-[var(--badge-neutral-ring)]",
    success: "bg-[var(--badge-success-bg)] text-[var(--badge-success-text)] border border-[var(--badge-success-ring)]",
    warning: "bg-[var(--badge-warning-bg)] text-[var(--badge-warning-text)] border border-[var(--badge-warning-ring)]",
    danger: "bg-[var(--badge-danger-bg)] text-[var(--badge-danger-text)] border border-[var(--badge-danger-ring)]",
  }[tone];

  return <span className={`inline-flex min-h-[24px] items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.01em] ${classes} ${className}`.trim()}>{children}</span>;
}
