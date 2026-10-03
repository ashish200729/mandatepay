"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  ChevronRight,
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  PanelLeftClose,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { signOut } from "@/lib/auth/client";
import type { Principal } from "@/lib/auth/server-api";
import { getSafeReturnTo } from "@/lib/auth/return-to";

export type WorkspacePrincipal = Omit<Principal, "id">;

const navigation = [
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/mandates", label: "Mandates", icon: ShieldCheck },
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/dashboard", label: "Control center", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
] as const;

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Navigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Workspace navigation" className="space-y-1">
      {navigation.map(({ href, label, icon: Icon }) => {
        const active = isActivePath(pathname, href);

        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-[background-color,color] motion-reduce:transition-none ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <Icon size={17} strokeWidth={active ? 2 : 1.7} aria-hidden="true" />
            <span className="flex-1">{label}</span>
            {active ? <ChevronRight size={15} aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountBlock({ principal }: { principal: WorkspacePrincipal }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const initials = principal.name.trim().slice(0, 1).toUpperCase() || "M";

  async function handleSignOut() {
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      await signOut();
      router.replace(`/signin?returnTo=${encodeURIComponent(getSafeReturnTo("/chat"))}`);
    } catch {
      setError("Sign out is temporarily unavailable. Try again shortly.");
      setPending(false);
    }
  }

  return (
    <div className="border-t border-border pt-5">
      {error ? (
        <p role="alert" className="mb-3 text-xs leading-relaxed text-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3 rounded-xl bg-secondary px-3 py-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sand text-sm font-medium"
          aria-hidden="true"
        >
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{principal.name}</p>
          <p className="truncate text-xs text-muted-foreground">{principal.email}</p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={pending}
          aria-label="Sign out"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-3 flex items-center gap-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
        <span
          className={`size-1.5 rounded-full ${principal.autonomousPurchasingEnabled ? "bg-foreground" : "bg-muted-foreground/50"}`}
          aria-hidden="true"
        />
        Autonomous purchasing {principal.autonomousPurchasingEnabled ? "enabled" : "off"}
      </p>
    </div>
  );
}

export function AuthWorkspaceShell({
  principal,
  children,
}: {
  principal: WorkspacePrincipal;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen max-w-[1680px]">
        <aside className="sticky top-0 hidden h-screen w-[270px] shrink-0 flex-col border-r border-border bg-background px-5 py-6 lg:flex">
          <Brand className="px-2" />
          <div className="mt-12 flex items-center gap-2 px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <LayoutDashboard size={14} aria-hidden="true" />
            Workspace
          </div>
          <div className="mt-3 flex-1">
            <Navigation pathname={pathname} />
          </div>
          <AccountBlock principal={principal} />
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-border/80 bg-background/95 px-5 backdrop-blur-sm sm:px-8 lg:hidden">
            <Brand />
            <button
              type="button"
              onClick={() => setMobileOpen((open) => !open)}
              aria-expanded={mobileOpen}
              aria-controls="mobile-workspace-navigation"
              className="flex size-11 items-center justify-center rounded-xl text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              {mobileOpen ? (
                <X size={20} aria-hidden="true" />
              ) : (
                <Menu size={20} aria-hidden="true" />
              )}
              <span className="sr-only">
                {mobileOpen ? "Close workspace navigation" : "Open workspace navigation"}
              </span>
            </button>
          </header>

          {mobileOpen ? (
            <>
              <button
                type="button"
                aria-label="Close workspace navigation"
                onClick={() => setMobileOpen(false)}
                className="fixed inset-0 z-30 bg-foreground/10 lg:hidden"
              />
              <div
                id="mobile-workspace-navigation"
                className="absolute inset-x-4 top-[84px] z-40 rounded-2xl border border-border bg-card p-4 shadow-[0_16px_48px_rgba(27,20,14,0.12)] lg:hidden"
              >
                <Navigation pathname={pathname} onNavigate={() => setMobileOpen(false)} />
                <div className="mt-4">
                  <AccountBlock principal={principal} />
                </div>
              </div>
            </>
          ) : null}

          <main
            id="main"
            className="mx-auto max-w-[1240px] px-5 py-8 sm:px-8 sm:py-12 lg:px-12 lg:py-16"
          >
            <div className="mb-8 flex items-center gap-2 text-xs text-muted-foreground lg:hidden">
              <PanelLeftClose size={14} aria-hidden="true" />
              MandatePay workspace
            </div>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
