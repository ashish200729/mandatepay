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
        <nav aria-label="Main navigation" className="hidden items-center gap-2 lg:flex xl:gap-3">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <Link
          href="/chat"
          className="group hidden h-9 items-center justify-center gap-2 rounded-full bg-foreground px-4 text-[13px] font-medium tracking-tight text-background no-underline transition-all duration-200 ease-out hover:bg-foreground/85 active:scale-[0.985] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none sm:inline-flex"
        >
          <span>Explore MandatePay</span>
          <ArrowUpRight
            size={14}
            aria-hidden="true"
            className="opacity-75 transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
          />
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
            <Link
              href="/chat"
              className="group mb-2 flex h-11 items-center justify-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium tracking-tight text-background no-underline transition-all duration-200 ease-out hover:bg-foreground/85 active:scale-[0.985] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <span>Open MandatePay</span>
              <ArrowUpRight
                size={15}
                aria-hidden="true"
                className="opacity-75 transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
              />
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
