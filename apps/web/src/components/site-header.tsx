"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowUpRight, Menu } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { Brand } from "@/components/brand";

const links = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#agentguard", label: "AgentGuard" },
  { href: "#your-control", label: "Your control" },
];

export function SiteHeader() {
  const mobileMenu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnOutsidePress = (event: PointerEvent) => {
      const menu = mobileMenu.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    const closeOnDesktop = () => {
      if (desktop.matches && mobileMenu.current) mobileMenu.current.open = false;
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      desktop.removeEventListener("change", closeOnDesktop);
    };
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background">
      <div className="relative mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-12">
        <Brand />
        <nav aria-label="Main navigation" className="hidden items-center gap-7 lg:flex xl:gap-9">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-muted-foreground decoration-foreground/35 underline-offset-8 transition-colors duration-200 hover:text-foreground hover:underline motion-reduce:transition-none"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <Link href="/chat" className={cn(buttonVariants(), "hidden sm:inline-flex")}>
          Explore MandatePay <ArrowUpRight aria-hidden="true" />
        </Link>
        <details
          ref={mobileMenu}
          className="group lg:hidden"
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              !event.currentTarget.contains(event.relatedTarget)
            ) {
              event.currentTarget.open = false;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && mobileMenu.current?.open) {
              mobileMenu.current.open = false;
              mobileMenu.current.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="Toggle navigation"
            className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full text-foreground transition-colors hover:bg-secondary active:bg-accent motion-reduce:transition-none [&::-webkit-details-marker]:hidden"
          >
            <Menu size={20} aria-hidden="true" />
          </summary>
          <nav
            aria-label="Mobile navigation"
            className="absolute inset-x-5 top-full flex flex-col gap-1 rounded-xl border border-border bg-card p-3 shadow-[0_8px_24px_rgba(27,20,14,0.08)]"
          >
            <Link href="/chat" className={cn(buttonVariants(), "mb-2")}>
              Open MandatePay <ArrowUpRight aria-hidden="true" />
            </Link>
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => {
                  if (mobileMenu.current) mobileMenu.current.open = false;
                }}
                className="flex min-h-12 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:bg-accent motion-reduce:transition-none"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </details>
      </div>
    </header>
  );
}
