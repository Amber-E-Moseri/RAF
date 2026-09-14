import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
}

export function Input({ label, error, className = "", ...props }: InputProps) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold tracking-[0.01em] text-[var(--text-primary)]">{label}</span>
      <input
        className={`ui-field ${className}`.trim()}
        {...props}
      />
      {error ? <span className="mt-2 block text-sm leading-6 text-[var(--status-danger)]">{error}</span> : null}
    </label>
  );
}
