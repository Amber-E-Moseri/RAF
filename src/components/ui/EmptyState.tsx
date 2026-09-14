interface EmptyStateProps {
  title: string;
  message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-3 flex h-[42px] w-[42px] items-center justify-center rounded-[13px]" style={{ background: "#f2f5f3" }}>
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-[var(--text-subtle)]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12h8M12 8v8" />
        </svg>
      </div>
      <h3 className="text-[12px] font-bold" style={{ color: "#344054" }}>{title}</h3>
      <p className="mt-1.5 max-w-[420px] text-[10.5px] leading-[1.5] text-[var(--text-secondary)]">{message}</p>
    </div>
  );
}
