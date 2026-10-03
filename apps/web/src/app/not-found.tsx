import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <p className="font-editorial text-7xl">404</p>
      <h1 className="mt-5 text-2xl font-medium tracking-tight">This page hasn’t been built yet.</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The MandatePay foundation starts with the product concept.
      </p>
      <Link href="/" className={buttonVariants({ className: "mt-8" })}>
        <ArrowLeft aria-hidden="true" /> Return to MandatePay
      </Link>
    </main>
  );
}
