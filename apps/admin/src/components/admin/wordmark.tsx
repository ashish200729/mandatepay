import { cn } from "@mandatepay/ui/lib/utils";

export function AdminWordmark({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
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
      {!compact && (
        <span className="text-xl font-bold tracking-[-0.035em]">
          MandatePay<span className="font-normal">.</span>
        </span>
      )}
    </span>
  );
}
