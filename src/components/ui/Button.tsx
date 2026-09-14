import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

function buttonClasses(variant: "primary" | "secondary" | "ghost", disabled?: boolean) {
  const base = "inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold tracking-[0.01em] transition duration-150";

  if (disabled) {
    return `${base} cursor-not-allowed border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[var(--text-subtle)]`;
  }

  if (variant === "secondary") {
    return `${base} border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]`;
  }

  if (variant === "ghost") {
    return `${base} border border-transparent bg-transparent text-[var(--theme-primary)] hover:bg-[var(--theme-soft)]`;
  }

  return `${base} border border-transparent bg-[var(--theme-primary)] text-white hover:bg-[var(--theme-accent)]`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
}

export function Button({
  children,
  className = "",
  disabled,
  variant = "primary",
  ...props
}: PropsWithChildren<ButtonProps>) {
  return (
    <button
      className={`${buttonClasses(variant, disabled)} ${className}`.trim()}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
