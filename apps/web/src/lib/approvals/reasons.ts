import type { ApprovalDecision } from "./types";

const REASON_COPY: Record<string, string> = {
  AUTO_SPEND_THRESHOLD_EXCEEDED: "The amount is above your automatic spending limit.",
  GLOBAL_AUTONOMY_DISABLED: "Automatic purchasing is currently turned off.",
  NEW_MERCHANT_REQUIRES_APPROVAL: "This merchant is new for the mandate and needs your approval.",
};

export function approvalReasonText(decision: ApprovalDecision | null) {
  if (!decision) return "AgentGuard has not recorded a reason for this proposal yet.";
  const known = decision.reasonCodes.map((code) => REASON_COPY[code]).filter(Boolean);
  return known.length
    ? known.join(" ")
    : "This proposal needs your review under the mandate rules.";
}
