import type { PropsWithChildren, ReactNode } from "react";

interface TableProps {
  headers: ReactNode[];
  footer?: ReactNode;
  tableClassName?: string;
}

export function Table({ headers, footer, tableClassName = "", children }: PropsWithChildren<TableProps>) {
  return (
    <div className="ui-table">
      <div className="overflow-x-auto">
        <table className={`min-w-full divide-y divide-stone-200/90 ${tableClassName}`.trim()}>
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th key={index} className="px-4 py-3.5 text-left text-[0.7rem] font-semibold uppercase text-stone-500 first:pl-5 last:pr-5">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">{children}</tbody>
        </table>
      </div>
      {footer ? <div className="border-t border-stone-200 bg-stone-50/80 px-5 py-3">{footer}</div> : null}
    </div>
  );
}
