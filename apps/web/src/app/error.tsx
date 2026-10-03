"use client";

import { useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button, buttonVariants } from "@mandatepay/ui/components/button";

export default function PageError({ reset }: { reset: () => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="max-w-lg font-editorial text-4xl leading-tight tracking-[-0.03em] sm:text-5xl">
        We couldn’t load this page.
      </h1>
      <p role="status" className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
        The service may be temporarily unavailable. Try again in a moment, or return to the home
        page.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button disabled={pending} onClick={() => startTransition(reset)}>
          <RotateCcw aria-hidden="true" />
          {pending ? "Retrying…" : "Try again"}
        </Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft aria-hidden="true" /> Return home
        </Link>
      </div>
    </main>
  );
}
