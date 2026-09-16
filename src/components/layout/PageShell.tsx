import type { ReactNode } from "react";

interface PageShellProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function PageShell({ eyebrow, title, description, actions, children }: PageShellProps) {
  return (
    <div className="space-y-6">
      <header className="page-shell-header hidden md:flex items-start justify-between gap-5 mb-[22px]">
        <div className="min-w-0">
          {eyebrow ? <p className="text-[11px] font-[800] uppercase tracking-[0.14em] text-[var(--text-secondary)] mb-[6px]">{eyebrow}</p> : null}
          <h1 className="text-[30px] font-black leading-[1.1] tracking-[-0.045em] text-[var(--text-primary)] m-0">{title}</h1>
          {description ? <p className="mt-[7px] max-w-[670px] text-[12.5px] leading-[1.55] text-[var(--text-secondary)]">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
