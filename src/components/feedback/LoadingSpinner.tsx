interface LoadingSpinnerProps {
  label?: string;
  size?: "sm" | "md" | "lg";
  inline?: boolean;
}

function spinnerSize(size: NonNullable<LoadingSpinnerProps["size"]>) {
  if (size === "sm") {
    return "h-4 w-4 border-2";
  }

  if (size === "lg") {
    return "h-10 w-10 border-[3px]";
  }

  return "h-6 w-6 border-2";
}

export function LoadingSpinner({
  label = "Loading...",
  size = "md",
  inline = false,
}: LoadingSpinnerProps) {
  const containerClassName = inline
    ? "inline-flex items-center gap-2"
    : "flex flex-col items-center justify-center gap-3";

  return (
    <div className={containerClassName} role="status" aria-live="polite">
      <span
        className={`inline-block animate-spin rounded-full border-[var(--border-strong)] border-t-[var(--theme-primary)] ${spinnerSize(size)}`}
        aria-hidden="true"
      />
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}
