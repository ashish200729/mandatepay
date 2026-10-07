import { AdminLink as Link } from "./link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { RecordIdentifier } from "./record-identifier";

export type Breadcrumb = { label: string; href?: string };
export function Breadcrumbs({ items }: { items: readonly Breadcrumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {items.map((item, index) => (
          <li key={index} className="flex min-w-0 items-center gap-2 [overflow-wrap:anywhere]">
            {index > 0 && <ChevronRight size={12} aria-hidden="true" className="shrink-0" />}
            {item.href && index !== items.length - 1 ? (
              <Link
                href={item.href}
                className="inline-flex min-h-11 items-center rounded py-2 hover:text-foreground hover:underline"
              >
                {item.label}
              </Link>
            ) : (
              <span aria-current={index === items.length - 1 ? "page" : undefined} className="py-3">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  recordId,
}: {
  title: string;
  description: string;
  breadcrumbs?: readonly Breadcrumb[];
  actions?: ReactNode;
  recordId?: string;
}) {
  return (
    <header className="mb-7 border-b pb-7">
      {breadcrumbs && (recordId || breadcrumbs.length > 2) && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <h1 className="font-editorial text-3xl leading-tight tracking-tight text-balance sm:text-[38px]">
            {title}
            {recordId && <span className="sr-only"> {recordId}</span>}
          </h1>
          <p className="mt-3 max-w-[65ch] text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
      </div>
      {recordId && <RecordIdentifier id={recordId} />}
    </header>
  );
}
