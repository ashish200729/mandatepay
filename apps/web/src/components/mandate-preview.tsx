import { Headphones } from "lucide-react";

const rules = [
  ["Allowed brands", "Sony, Bose"],
  ["Condition", "New only"],
  ["Maximum budget", "$180.00"],
  ["Automatic spending", "Up to $150.00"],
];

export function MandatePreview() {
  return (
    <figure
      aria-label="Illustrative purchase mandate"
      className="w-full rounded-2xl border border-sand-border bg-linear-to-b from-[#F7EED8]/70 via-sand to-[#EFE2C2] p-6 shadow-[0_8px_32px_rgba(27,20,14,0.04),inset_0_1px_0_rgba(255,255,255,0.7)] sm:p-8"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium tracking-wide uppercase text-foreground/70">
          Example mandate
        </span>
        <span className="text-muted-foreground">Headphones · USD</span>
      </div>
      <blockquote className="my-6 font-editorial text-[26px] leading-[1.3] tracking-[-0.025em] text-foreground sm:text-[30px]">
        “Find Sony or Bose headphones under $180. Buy new only. Ask me above $150.”
      </blockquote>
      <dl className="divide-y divide-sand-border/70 border-y border-sand-border/70 py-1">
        {rules.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 py-2.5 text-xs sm:text-sm"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {label === "Allowed brands" ? (
                <span className="inline-flex items-center rounded-md border border-sand-border/70 bg-background/80 px-2 py-0.5 text-xs font-medium text-foreground shadow-2xs">
                  {value}
                </span>
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 rounded-xl border border-border/70 bg-card p-5 shadow-[0_4px_20px_rgba(27,20,14,0.05),0_1px_2px_rgba(27,20,14,0.03)]">
        <div className="flex items-center gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-secondary/80 text-foreground">
            <Headphones size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">Sony WH-1000XM5</p>
            <p className="mt-0.5 text-xs text-muted-foreground">New · Matches your mandate</p>
          </div>
          <span className="text-lg font-semibold tracking-tight text-foreground tabular-nums">
            $169
          </span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3.5 text-xs">
          <span className="text-muted-foreground">Above your automatic limit</span>
          <span className="inline-flex items-center rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-foreground">
            Approval required
          </span>
        </div>
      </div>
      <figcaption className="mt-3.5 text-center text-xs tracking-tight text-muted-foreground">
        An illustrative proposal. Your approval comes before payment.
      </figcaption>
    </figure>
  );
}
