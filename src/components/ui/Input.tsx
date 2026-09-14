import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
}

export function Input({ label, error, className = "", ...props }: InputProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[9.5px] font-[850] text-[#667085]">{label}</span>
      <input className={`ui-field ${className}`.trim()} {...props} />
      {error ? <span className="mt-1.5 block text-[10.5px] leading-5 text-[var(--status-danger)]">{error}</span> : null}
    </label>
  );
}
