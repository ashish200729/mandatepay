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
      <div className="max-w-[720px]">
        <div className="flex items-start gap-4">
          <span className="mt-1.5 hidden size-10 shrink-0 items-center justify-center rounded-xl bg-sand text-foreground sm:flex">
            <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <h1 className="font-editorial text-[clamp(2.6rem,5vw,4.8rem)] leading-[1.02] tracking-[-0.035em]">
            {title}
          </h1>
        </div>
        <p className="mt-5 max-w-[580px] text-base leading-[1.8] text-muted-foreground sm:text-lg">
          {description}
        </p>
      </div>
      <div className="mt-12">{children}</div>
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
