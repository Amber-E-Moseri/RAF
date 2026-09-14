import type { PropsWithChildren, ReactNode } from "react";

interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, actions, className = "", children }: PropsWithChildren<CardProps>) {
  return (
    <section className={`ui-card p-5 sm:p-6 ${className}`.trim()}>
      {(title || subtitle || actions) ? (
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">{title}</h2> : null}
            {subtitle ? <p className="mt-2 max-w-2xl text-[14px] leading-6 text-[var(--text-secondary)]">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}
