import type { LucideIcon } from "lucide-react";

export function WorkspacePage({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="max-w-[760px]">
        <div className="flex items-center gap-3">
          <span className="hidden shrink-0 text-muted-foreground sm:flex">
            <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <h1 className="font-editorial text-3xl leading-tight tracking-[-0.025em] sm:text-[40px]">
            {title}
          </h1>
        </div>
        <p className="mt-3 max-w-[640px] text-sm leading-6 text-muted-foreground sm:text-[15px]">
          {description}
        </p>
      </div>
      <div className="mt-8">{children}</div>
    </div>
  );
}

export function EmptyWorkspaceState({
  icon: Icon,
  title,
  description,
  detail,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  detail?: string;
}) {
  return (
    <section className="grid min-h-[320px] items-center gap-10 rounded-2xl border border-border bg-card p-6 sm:p-10 lg:grid-cols-[auto_1fr] lg:p-14">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-sand text-foreground">
        <Icon size={28} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div className="max-w-[520px]">
        <h2 className="font-editorial text-3xl leading-tight tracking-[-0.025em] sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 text-sm leading-[1.8] text-muted-foreground sm:text-base">
          {description}
        </p>
        {detail ? (
          <p className="mt-5 text-xs leading-[1.7] text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </section>
  );
}
