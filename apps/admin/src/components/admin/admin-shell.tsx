"use client";
import { AdminLink as Link } from "./link";
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
import {
  Activity,
  BadgeCheck,
  CircleUserRound,
  CreditCard,
  FileCheck2,
  LayoutDashboard,
  ListChecks,
  LockKeyhole,
  Menu,
  ReceiptText,
  RotateCcw,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { AdminWordmark } from "./wordmark";

const groups: readonly {
  label: string;
  items: readonly { label: string; href: string | null; icon: LucideIcon }[];
}[] = [
  { label: "Workspace", items: [{ label: "Overview", href: "/", icon: LayoutDashboard }] },
  {
    label: "Operations",
    items: [
      { label: "Users", href: "/users", icon: Users },
      { label: "Mandates", href: "/mandates", icon: FileCheck2 },
      { label: "Proposals", href: "/proposals", icon: ListChecks },
      { label: "Approvals", href: "/approvals", icon: BadgeCheck },
      { label: "Orders", href: "/orders", icon: ShoppingBag },
      { label: "Payments", href: "/payments", icon: CreditCard },
      { label: "Refunds", href: "/refunds", icon: RotateCcw },
    ],
  },
  {
    label: "Platform",
    items: [
      { label: "Agent Activity", href: "/agent", icon: Activity },
      { label: "Webhooks", href: "/webhooks", icon: Webhook },
      { label: "Audit Logs", href: "/audit", icon: ReceiptText },
      { label: "System Health", href: "/system", icon: ShieldCheck },
      { label: "Configuration", href: "/settings", icon: Settings2 },
    ],
  },
  { label: "Admin", items: [{ label: "My Session", href: "/session", icon: CircleUserRound }] },
];
export function AdminSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  function current(href: string) {
    return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  }
  return (
    <nav aria-label="Administration" className="space-y-6 px-3 py-5">
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="mb-2 px-3 text-xs font-medium text-muted-foreground">{group.label}</h2>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.label}>
                {item.href ? (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={current(item.href) ? "page" : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm transition-colors motion-reduce:transition-none ${current(item.href) ? "border-sand-border bg-admin-active font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-card hover:text-foreground"}`}
                  >
                    <item.icon
                      size={17}
                      strokeWidth={1.6}
                      aria-hidden="true"
                      className="shrink-0"
                    />
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
          <Menu size={19} aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        ref={content}
        onOverlayPointerDown={() => setOpen(false)}
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
              <X size={19} aria-hidden="true" />
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
    <header className="sticky top-0 z-40 flex min-h-[72px] items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-7 lg:px-9">
      <div className="flex min-w-0 items-center gap-3">
        <MobileNavigation key={pathname} />
        <Link href="/" className="rounded text-sm font-medium lg:hidden">
          <span className="sm:hidden">
            <AdminWordmark compact />
          </span>
          <span className="hidden sm:inline">
            <AdminWordmark />
          </span>
          <span className="sr-only">Admin</span>
        </Link>
        <span className="hidden text-sm font-medium lg:block">
          {groups
            .flatMap((group) => group.items)
            .find(
              (item) =>
                item.href &&
                (item.href === "/"
                  ? pathname === "/"
                  : pathname === item.href || pathname.startsWith(`${item.href}/`)),
            )?.label ?? "Administration"}
        </span>
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
      <Link
        href="/session"
        aria-label={`Admin session for ${admin.user.name ?? admin.user.email}`}
        className="flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors hover:bg-secondary motion-reduce:transition-none"
      >
        <div className="hidden min-w-0 text-right sm:block">
          <p
            className="max-w-[180px] truncate text-sm font-medium sm:max-w-[240px]"
            title={admin.user.email}
          >
            {admin.user.name ?? admin.user.email}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">Main administrator</p>
        </div>
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-sand-border bg-accent text-xs font-medium"
        >
          {(admin.user.name ?? admin.user.email)
            .trim()
            .split(/\s+/)
            .map((part) => part[0])
            .slice(0, 2)
            .join("")
            .toUpperCase()}
        </span>
      </Link>
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
            aria-label="MandatePay Admin overview"
            className="flex min-h-[72px] shrink-0 items-center px-5"
          >
            <AdminWordmark />
          </Link>
          <Separator />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AdminSidebar />
          </div>
          <div className="shrink-0 border-t px-5 py-5 text-xs text-muted-foreground">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <LockKeyhole size={14} aria-hidden="true" />
              Restricted access
            </p>
            <span className="mt-1.5 block">Activity is audited.</span>
            {commitSha ? <span className="mt-1 block">Build {commitSha.slice(0, 7)}</span> : null}
          </div>
        </aside>
        <div className="min-w-0">
          <AdminTopbar admin={admin} environment={environment} />
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto max-w-[1440px] px-4 py-6 outline-none sm:px-7 sm:py-8 lg:px-9 lg:py-9"
          >
            {children}
          </main>
        </div>
      </div>
    </AdminToastProvider>
  );
}
