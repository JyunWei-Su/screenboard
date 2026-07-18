import type { ReactNode } from "react";

/** Responsive page header: title (+ optional subtitle) on the left, actions on the right. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-dark-text">
          {title}
        </h1>
        {subtitle && <p className="mt-1 break-words text-sm text-slate-500 dark:text-dark-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{children}</div>}
    </div>
  );
}

/** Card whose contents (a <table>) scroll horizontally on narrow screens. */
export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-dark-border dark:bg-dark-surface dark:shadow-none">
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

/** Full-width placeholder row for empty / loading table states. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="hover:bg-transparent">
      <td
        className="td px-4 py-8 text-center text-sm text-slate-400 dark:text-dark-subtle"
        colSpan={colSpan}
      >
        {children}
      </td>
    </tr>
  );
}
