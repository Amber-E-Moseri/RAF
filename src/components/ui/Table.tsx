import type { PropsWithChildren, ReactNode } from "react";

interface TableProps {
  headers: ReactNode[];
  thClassNames?: (string | undefined)[];
  footer?: ReactNode;
  tableClassName?: string;
}

export function Table({ headers, thClassNames, footer, tableClassName = "", children }: PropsWithChildren<TableProps>) {
  return (
    <div className="table-wrap">
      <table className={`w-full border-collapse ${tableClassName}`.trim()}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={index} className={["px-4 py-3.5 text-left text-[8.5px] font-[900] uppercase tracking-[0.06em] text-[var(--text-secondary)] bg-[var(--surface-muted)]", thClassNames?.[index] ?? ""].filter(Boolean).join(" ")}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {footer ? <div className="border-t border-[var(--border-subtle)] bg-transparent px-[13px] py-[11px]">{footer}</div> : null}
    </div>
  );
}
