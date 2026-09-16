interface EmptyStateProps {
  title: string;
  message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-icon">📋</div>
      <b>{title}</b>
      <span>{message}</span>
    </div>
  );
}
