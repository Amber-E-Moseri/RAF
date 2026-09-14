import type { PropsWithChildren, ReactNode } from "react";

interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, actions, className = "", children }: PropsWithChildren<CardProps>) {
  return (
    <section className={`ui-card ${className}`.trim()} style={{ padding: 18 }}>
      {(title || subtitle || actions) ? (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h2 className="text-[13.5px] font-[900] tracking-[-0.02em] text-[var(--text-primary)]">{title}</h2> : null}
            {subtitle ? <p className="mt-1.5 max-w-2xl text-[10.5px] leading-[1.45] text-[var(--text-secondary)]">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}
