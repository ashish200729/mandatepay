"use client";

import { useId, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import { cn } from "@mandatepay/ui/lib/utils";
import {
  explainApprovalDecision,
  promptInjectionKind,
  verdictLabel,
} from "@/lib/approvals/reasons";
import type { ApprovalDecision, DecisionCheck } from "@/lib/approvals/types";

const STATUS_COPY: Record<DecisionCheck["status"], string> = {
  pass: "Passed",
  approval: "Needs approval",
  block: "Blocked",
};

function CheckIcon({ status }: { status: DecisionCheck["status"] }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
        status === "pass" && "bg-secondary text-foreground",
        status === "approval" && "border border-sand-border bg-sand text-foreground",
        status === "block" && "bg-foreground text-background",
      )}
    >
      {status === "pass" ? (
        <Check size={13} aria-hidden="true" />
      ) : status === "approval" ? (
        <CircleAlert size={13} aria-hidden="true" />
      ) : (
        <X size={13} aria-hidden="true" />
      )}
      <span className="sr-only">{STATUS_COPY[status]}:</span>
    </span>
  );
}

export function VerdictBadge({ decision }: { decision: string | null | undefined }) {
  const Icon =
    decision === "BLOCK" ? X : decision === "REQUIRE_APPROVAL" ? ShieldQuestion : ShieldCheck;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium leading-5",
        decision === "BLOCK" && "bg-foreground text-background",
        decision === "REQUIRE_APPROVAL" && "border border-sand-border bg-sand text-foreground",
        decision === "ALLOW" && "bg-secondary text-foreground",
        !decision && "bg-secondary text-muted-foreground",
      )}
    >
      <Icon size={13} aria-hidden="true" />
      {verdictLabel(decision)}
    </span>
  );
}

/**
 * A distinct callout when AgentGuard recorded that a listing's own text tried to
 * instruct AI agents (blocked) or contained instruction-like text (needs review).
 */
export function PromptInjectionNotice({
  kind,
  className,
}: {
  kind: "blocked" | "review";
  className?: string;
}) {
  const blocked = kind === "blocked";
  return (
    <div
      role="note"
      aria-label={blocked ? "Prompt-injection attempt blocked" : "Instruction-like listing text"}
      className={cn(
        "flex min-w-0 gap-3 rounded-lg border px-3 py-3 text-sm",
        blocked
          ? "border-foreground bg-foreground text-background"
          : "border-sand-border bg-sand text-foreground",
        className,
      )}
    >
      <ShieldAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium leading-6">
          {blocked ? "Prompt-injection attempt blocked" : "Instruction-like listing text"}
        </p>
        <p className="break-words leading-6 opacity-90">
          {blocked
            ? "The seller’s listing tried to instruct AI shopping agents. MandatePay treats product text as data, so the instructions were ignored and AgentGuard stopped the purchase. Your mandate and PayPal were never touched."
            : "This listing had hidden or instruction-like text. It was kept away from the AI, and AgentGuard asks you to review the exact purchase."}
        </p>
      </div>
    </div>
  );
}

/**
 * The recorded AgentGuard verdict with its server-templated reason and an
 * optional rule-by-rule disclosure. It explains a decision; it never makes one.
 */
export function DecisionExplanation({
  decision,
  className,
  defaultOpen = false,
}: {
  decision: ApprovalDecision | null;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const explanation = decision ? explainApprovalDecision(decision) : null;
  const injection = promptInjectionKind(decision);

  if (!decision || !explanation) {
    return (
      <div className={cn("text-sm", className)}>
        <VerdictBadge decision={null} />
        <p className="mt-2 leading-relaxed text-muted-foreground">
          AgentGuard has not recorded a decision for this proposal yet.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 text-sm", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">AgentGuard</span>
        <VerdictBadge decision={explanation.decision} />
      </div>
      {injection ? <PromptInjectionNotice kind={injection} className="mt-3" /> : null}
      <p className="mt-2.5 break-words font-medium leading-6 text-foreground">
        {explanation.headline}
      </p>
      <p className="mt-1 break-words leading-6 text-muted-foreground">{explanation.summary}</p>
      {explanation.checks.length ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
            className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Why?
            <span className="sr-only">
              {open ? " Hide" : " Show"} each mandate rule AgentGuard checked
            </span>
            <ChevronDown
              size={15}
              aria-hidden="true"
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
          <ul
            id={panelId}
            hidden={!open}
            aria-label="Rules AgentGuard checked"
            className="mt-1 divide-y divide-border rounded-lg border border-border bg-card"
          >
            {explanation.checks.map((check, index) => (
              <li
                key={`${check.rule}-${index}`}
                className="flex min-w-0 flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="flex min-w-0 gap-3">
                  <CheckIcon status={check.status} />
                  <div className="min-w-0">
                    <p className="font-medium leading-6">{check.label}</p>
                    <p className="break-words leading-6 text-muted-foreground">{check.message}</p>
                  </div>
                </div>
                {check.limit || check.actual ? (
                  <dl className="ml-9 grid shrink-0 grid-cols-[auto_auto] gap-x-3 text-xs leading-5 sm:ml-0 sm:text-right">
                    {check.limit ? (
                      <>
                        <dt className="text-muted-foreground">Limit</dt>
                        <dd className="font-medium tabular-nums">{check.limit}</dd>
                      </>
                    ) : null}
                    {check.actual ? (
                      <>
                        <dt className="text-muted-foreground">This proposal</dt>
                        <dd className="font-medium tabular-nums">{check.actual}</dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
