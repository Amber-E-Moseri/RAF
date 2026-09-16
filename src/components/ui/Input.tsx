import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
}

export function Input({ label, error, className = "", ...props }: InputProps) {
  return (
    <label className="block">
      <span className="mb-2 block text-[9.5px] font-[850] tracking-[0.01em] text-[var(--text-secondary)] uppercase">{label}</span>
      <input
        className={`ui-field ${className}`.trim()}
        {...props}
      />
      {error ? <span className="mt-2 block text-[10.5px] leading-[1.45] text-[var(--status-danger)]">{error}</span> : null}
    </label>
  );
}
