import { Money } from "./Money";
import { normalizeMoneyInput } from "../../lib/validation";

interface MoneyInputProps {
  label: string;
  name: string;
  value: string;
  onChange: (nextValue: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  error?: string | null;
  disabled?: boolean;
}

export function MoneyInput({
  label,
  name,
  value,
  onChange,
  onBlur,
  placeholder,
  error,
  disabled,
}: MoneyInputProps) {
  const normalized = normalizeMoneyInput(value);

  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium tracking-[0.01em] text-[var(--text-primary)]">{label}</span>
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-[var(--text-subtle)]">$</span>
        <input
          className="ui-field py-3 pl-8 pr-4"
          name={name}
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onBlur={onBlur}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === "" || /^(?:0|[1-9]\d*)(?:\.\d{0,2})?$/.test(nextValue)) {
              onChange(nextValue);
            }
          }}
        />
      </div>
      {normalized ? <span className="mt-2 block text-xs font-medium tracking-[0.01em] text-[var(--text-secondary)]">Preview: <Money value={normalized} /></span> : null}
      {error ? <span className="mt-2 block text-sm leading-6 text-[var(--status-danger)]">{error}</span> : null}
    </label>
  );
}
