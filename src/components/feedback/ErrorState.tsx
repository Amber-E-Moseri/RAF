import { Button } from "../ui/Button";

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: ErrorStateProps) {
  return (
    <div className="rounded-3xl border border-[var(--badge-danger-ring)] bg-[var(--badge-danger-bg)] px-6 py-6 text-sm text-[var(--badge-danger-text)] shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-2.5 w-2.5 rounded-full bg-[var(--status-danger)]" />
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="mt-2 leading-6">{message}</p>
          {onRetry ? <Button className="mt-4" variant="secondary" onClick={onRetry}>Try again</Button> : null}
        </div>
      </div>
    </div>
  );
}
