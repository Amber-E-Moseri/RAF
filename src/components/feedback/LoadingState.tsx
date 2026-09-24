import { LoadingSpinner } from "./LoadingSpinner";

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-6 py-10 shadow-panel">
      <LoadingSpinner label={label} size="lg" />
    </div>
  );
}
