interface SuccessNoticeProps {
  title: string;
  message: string;
}

export function SuccessNotice({ title, message }: SuccessNoticeProps) {
  return (
    <div className="rounded-3xl border border-[var(--badge-success-ring)] bg-[var(--badge-success-bg)] px-5 py-4 text-sm text-[var(--badge-success-text)]">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1">{message}</p>
    </div>
  );
}
