import type { ReactNode } from "react";

interface PageShellProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  embedded?: boolean;
}

export function PageShell({ eyebrow, title, description, actions, children, embedded }: PageShellProps) {
  if (embedded) return <>{children}</>;

  return (
    <div className="space-y-6">
      <header className="hidden md:block">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow ? <p className="mb-1 text-[11px] font-[800] uppercase tracking-[0.16em] text-[var(--text-secondary)]">{eyebrow}</p> : null}
            <h1 className="text-[30px] leading-[1.08] tracking-[-0.02em] text-[var(--text-primary)]" style={{ fontWeight: 900 }}>{title}</h1>
            {description ? <p className="mt-2 max-w-[64ch] text-[12.5px] leading-[1.55] text-[var(--text-secondary)]">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div> : null}
        </div>
      </header>
      {children}
    </div>
  );
}
