import type { PropsWithChildren, ReactNode } from "react";

interface TableProps {
  headers: ReactNode[];
  footer?: ReactNode;
  tableClassName?: string;
}

export function Table({ headers, footer, tableClassName = "", children }: PropsWithChildren<TableProps>) {
  return (
    <div className="ui-card overflow-hidden" style={{ borderRadius: 16 }}>
      <div className="overflow-x-auto">
        <table className={`min-w-full ${tableClassName}`.trim()}>
          <thead>
            <tr style={{ background: "#fafaf8" }}>
              {headers.map((header, index) => (
                <th key={index} className="px-[13px] py-[11px] text-left text-[8.5px] font-[900] uppercase tracking-[0.14em] text-[var(--text-secondary)] first:pl-[18px] last:pr-[18px]">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">{children}</tbody>
        </table>
      </div>
      {footer ? <div className="border-t border-[var(--border-subtle)] px-[18px] py-3" style={{ background: "#fafaf8" }}>{footer}</div> : null}
    </div>
  );
}
