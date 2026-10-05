import Link from "next/link";
import type { ReactNode } from "react";

export type Breadcrumb = { label: string; href?: string };
export function Breadcrumbs({ items }: { items: readonly Breadcrumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {items.map((item, index) => (
          <li key={index} className="flex min-w-0 items-center gap-2">
            {index > 0 && <span aria-hidden="true">/</span>}
            {item.href && index !== items.length - 1 ? (
              <Link href={item.href} className="rounded py-3 hover:underline">
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
}: {
  title: string;
  description: string;
  breadcrumbs?: readonly Breadcrumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="font-editorial text-3xl tracking-tight sm:text-[40px]">{title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            {description}
          </p>
        </div>
        {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
      </div>
    </header>
  );
}
