import type { ReactNode } from "react";

interface PageShellProps {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
  embedded?: boolean;
}

export function PageShell({ eyebrow, title, description, actions, children, embedded = false }: PageShellProps) {
  return (
    <div className="space-y-8">
      {!embedded ? <header className="ui-card hidden p-5 sm:p-6 md:block">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              {eyebrow ? <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">{eyebrow}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </div>
          <div className="min-w-0">
            <h1 className="text-[30px] font-bold leading-[1.08] tracking-[-0.02em] text-[var(--text-primary)] sm:text-[34px]">{title}</h1>
            <p className="mt-3 max-w-[64ch] text-[15px] leading-7 text-[var(--text-secondary)]">{description}</p>
          </div>
        </div>
      </header> : null}
      {children}
    </div>
  );
}
