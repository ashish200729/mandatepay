"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@mandatepay/ui/components/button";
import { Separator } from "@mandatepay/ui/components/separator";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@mandatepay/ui/components/dialog";
import type { AdminMe } from "@/lib/session";
import type { AdminEnvironment } from "@/lib/environment";
import { StatusBadge } from "./status-badge";
import { AdminToastProvider } from "./toasts";

const groups: readonly {
  label: string;
  items: readonly { label: string; href: string | null }[];
}[] = [
  { label: "Workspace", items: [{ label: "Overview", href: "/" }] },
  {
    label: "Operations",
    items: [
      { label: "Users", href: "/users" },
      { label: "Mandates", href: "/mandates" },
      { label: "Proposals", href: "/proposals" },
      { label: "Approvals", href: "/approvals" },
      { label: "Orders", href: "/orders" },
      { label: "Payments", href: "/payments" },
      { label: "Refunds", href: "/refunds" },
    ],
  },
  {
    label: "Platform",
    items: [
      { label: "Agent Activity", href: "/agent" },
      { label: "Webhooks", href: "/webhooks" },
      { label: "Audit Logs", href: "/audit" },
      { label: "System Health", href: "/system" },
      { label: "Configuration", href: "/settings" },
    ],
  },
  { label: "Admin", items: [{ label: "My Session", href: "/session" }] },
];
export function AdminSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  function current(href: string) {
    return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  }
  return (
    <nav aria-label="Administration" className="space-y-5 px-4 py-5">
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="mb-2 px-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {group.label}
          </h2>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.label}>
                {item.href ? (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={current(item.href) ? "page" : undefined}
                    className={`flex min-h-11 items-center rounded-xl px-3 text-sm ${current(item.href) ? "bg-admin-active font-medium" : "hover:bg-secondary"}`}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className="flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 text-sm text-muted-foreground"
                  >
                    {item.label}
                    <span className="sr-only">, coming soon</span>
                    <span aria-hidden="true" className="text-[10px]">
                      Soon
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="Open administration menu"
          aria-expanded={open}
          aria-controls="admin-mobile-navigation"
          className="lg:hidden"
        >
          ☰
        </Button>
      </DialogTrigger>
      <DialogContent
        ref={content}
        id="admin-mobile-navigation"
        className="left-0 top-0 flex h-dvh max-h-dvh w-[min(20rem,calc(100%_-_3rem))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none p-0 sm:p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (
            content.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]') ??
            content.current?.querySelector<HTMLAnchorElement>("nav a")
          )?.focus();
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b p-4">
          <DialogTitle className="text-xl">Administration</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close administration menu">
              ×
            </Button>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">Choose an administration section.</DialogDescription>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AdminSidebar onNavigate={() => setOpen(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function AdminTopbar({
  admin,
  environment,
}: {
  admin: AdminMe;
  environment: AdminEnvironment;
}) {
  const pathname = usePathname();
  const labels = {
    local: "Local",
    test: "Test",
    staging: "Staging",
    production: "Production",
    unknown: "Environment unknown",
  };
  return (
    <header className="sticky top-0 z-40 flex min-h-[72px] flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-7">
      <div className="flex min-w-0 items-center gap-3">
        <MobileNavigation key={pathname} />
        <Link href="/" className="rounded text-sm font-medium lg:hidden">
          MandatePay Admin
        </Link>
        <span className="hidden text-sm text-muted-foreground lg:block">Administration</span>
        <StatusBadge
          status={environment}
          label={labels[environment]}
          tone={
            environment === "production"
              ? "danger"
              : environment === "staging" || environment === "unknown"
                ? "warning"
                : "neutral"
          }
        />
      </div>
      <div className="min-w-0 text-right">
        <p
          className="max-w-[180px] truncate text-xs font-medium sm:max-w-[240px]"
          title={admin.user.email}
        >
          {admin.user.name ?? admin.user.email}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">Main administrator</p>
      </div>
    </header>
  );
}
export function AdminShell({
  children,
  admin,
  environment,
  commitSha,
}: {
  children: ReactNode;
  admin: AdminMe;
  environment: AdminEnvironment;
  commitSha?: string | null;
}) {
  return (
    <AdminToastProvider>
      <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh min-h-0 flex-col border-r bg-admin-sidebar lg:flex">
          <Link
            href="/"
            className="flex min-h-[72px] shrink-0 items-center px-7 font-editorial text-xl"
          >
            MandatePay <span className="ml-2 font-sans text-xs">Admin</span>
          </Link>
          <Separator />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AdminSidebar />
          </div>
          <div className="shrink-0 border-t px-7 py-5 text-xs text-muted-foreground">
            Restricted access
            <br />
            <span className="mt-1 block">Activity is audited.</span>
            {commitSha ? (
              <span className="mt-1 block">Build {commitSha.slice(0, 7)}</span>
            ) : null}
          </div>
        </aside>
        <div className="min-w-0">
          <AdminTopbar admin={admin} environment={environment} />
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto max-w-[1440px] px-4 py-6 outline-none sm:px-7 sm:py-8 lg:px-9"
          >
            {children}
          </main>
        </div>
      </div>
    </AdminToastProvider>
  );
}
