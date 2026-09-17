interface EmptyStateProps {
  title: string;
  message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <div className="text-4xl">📋</div>
      <b className="text-sm font-semibold text-[var(--text-strong)]">{title}</b>
      <span className="text-sm text-[var(--text-muted)]">{message}</span>
    </div>
  );
}
