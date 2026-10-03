import { Check, Headphones, ShieldCheck } from "lucide-react";

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
      className="w-full rounded-2xl bg-sand p-5 sm:p-8"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <ShieldCheck size={16} aria-hidden="true" /> Example mandate
        </span>
        <span>Headphones · USD</span>
      </div>
      <blockquote className="my-7 font-editorial text-[28px] leading-[1.3] tracking-[-0.025em] sm:text-[32px]">
        “Find Sony or Bose headphones under $180. Buy new only. Ask me above $150.”
      </blockquote>
      <dl className="border-t border-sand-border">
        {rules.map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between gap-3 border-b border-sand-border py-3.5 text-sm"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-7 rounded-xl bg-card p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <Headphones size={22} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Sony WH-1000XM5</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Check size={12} aria-hidden="true" /> New · Matches your mandate
            </p>
          </div>
          <span className="text-lg font-medium tabular-nums">$169</span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-4 text-xs">
          <span className="text-muted-foreground">Above your automatic limit</span>
          <span className="font-medium">Approval required</span>
        </div>
      </div>
      <figcaption className="mt-4 text-xs text-muted-foreground">
        An illustrative proposal. Your approval comes before payment.
      </figcaption>
    </figure>
  );
}
