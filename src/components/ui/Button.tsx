import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

function buttonClasses(variant: "primary" | "secondary" | "ghost" | "danger", disabled?: boolean) {
  const base = "inline-flex items-center justify-center transition duration-150 hover:-translate-y-px";
  const sizing = "rounded-[11px] px-[13px] py-[9px] text-[11.5px] font-[850]";

  if (disabled) return `${base} ${sizing} cursor-not-allowed border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[var(--text-subtle)]`;
  if (variant === "secondary") return `${base} ${sizing} border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]`;
  if (variant === "ghost") return `${base} ${sizing} border border-transparent bg-transparent text-[var(--theme-primary)] hover:bg-[var(--theme-soft)]`;
  if (variant === "danger") return `${base} ${sizing} border border-[#f1caca] bg-[var(--badge-danger-bg)] text-[var(--status-danger)]`;
  return `${base} ${sizing} border border-transparent bg-[var(--theme-primary)] text-white shadow-[0_8px_20px_rgba(14,159,115,0.16)] hover:bg-[var(--theme-accent)]`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export function Button({ children, className = "", disabled, variant = "primary", ...props }: PropsWithChildren<ButtonProps>) {
  return (
    <button className={`${buttonClasses(variant, disabled)} ${className}`.trim()} disabled={disabled} {...props}>
      {children}
    </button>
  );
}
