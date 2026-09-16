import type { PropsWithChildren, ReactNode } from "react";

interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, actions, className = "", children }: PropsWithChildren<CardProps>) {
  return (
    <section className={`ui-card p-[18px] ${className}`.trim()}>
      {(title || subtitle || actions) ? (
        <header className="mb-[14px] flex items-start justify-between gap-[12px]">
          <div className="min-w-0">
            {title ? <h2 className="text-[13.5px] font-black leading-snug tracking-[-0.02em] text-[var(--text-primary)]">{title}</h2> : null}
            {subtitle ? <p className="mt-[3px] max-w-2xl text-[10.5px] leading-[1.45] text-[var(--text-secondary)]">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}
