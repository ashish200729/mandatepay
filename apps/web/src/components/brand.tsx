import { cn } from "@mandatepay/ui/lib/utils";
import Link from "next/link";

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="MandatePay home"
      className={cn("inline-flex items-center gap-2.5", className)}
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 18V6L12 13L19 6V18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-[21px] font-bold tracking-[-0.035em]">
        MandatePay<span className="font-normal">.</span>
      </span>
    </Link>
  );
}
