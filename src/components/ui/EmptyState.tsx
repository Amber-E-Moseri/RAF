interface EmptyStateProps {
  title: string;
  message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="rounded-3xl border border-dashed border-stone-300 bg-stone-50 px-6 py-10 text-center shadow-sm">
      <h3 className="text-lg font-semibold text-raf-ink">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-stone-500">{message}</p>
    </div>
  );
}
