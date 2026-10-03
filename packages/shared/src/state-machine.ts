import { z } from "zod";
import { DomainError } from "./errors.js";

export const MANDATE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "EXPIRED", "REVOKED"] as const;
export const MandateStatusSchema = z.enum(MANDATE_STATUSES);
export type MandateStatus = z.infer<typeof MandateStatusSchema>;

export const PROPOSAL_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "POLICY_CHECKED",
  "BLOCKED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "AUTHORIZED",
  "PAYPAL_ORDER_CREATED",
  "PAYMENT_PENDING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const REFUND_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
] as const;
export const RefundStatusSchema = z.enum(REFUND_STATUSES);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

export type TransitionMap<State extends string> = Readonly<{
  [Status in State]: readonly State[];
}>;

export const MANDATE_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(["ACTIVE"]),
  ACTIVE: Object.freeze(["PAUSED", "EXPIRED", "REVOKED"]),
  PAUSED: Object.freeze(["ACTIVE", "EXPIRED", "REVOKED"]),
  EXPIRED: Object.freeze([]),
  REVOKED: Object.freeze([]),
} as const satisfies TransitionMap<MandateStatus>);

export const PROPOSAL_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(["PROPOSED", "CANCELLED"]),
  PROPOSED: Object.freeze(["POLICY_CHECKED", "CANCELLED", "EXPIRED"]),
  POLICY_CHECKED: Object.freeze([
    "BLOCKED",
    "AWAITING_APPROVAL",
    "AUTHORIZED",
    "CANCELLED",
    "EXPIRED",
  ]),
  BLOCKED: Object.freeze([]),
  AWAITING_APPROVAL: Object.freeze(["APPROVED", "CANCELLED", "EXPIRED"]),
  APPROVED: Object.freeze(["AUTHORIZED", "CANCELLED", "EXPIRED"]),
  AUTHORIZED: Object.freeze(["PAYPAL_ORDER_CREATED", "FAILED", "CANCELLED"]),
  PAYPAL_ORDER_CREATED: Object.freeze(["PAYMENT_PENDING", "FAILED", "CANCELLED"]),
  PAYMENT_PENDING: Object.freeze(["COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
} as const satisfies TransitionMap<ProposalStatus>);

export const REFUND_TRANSITIONS = Object.freeze({
  REQUESTED: Object.freeze(["APPROVED", "FAILED"]),
  APPROVED: Object.freeze(["SUBMITTED", "FAILED"]),
  SUBMITTED: Object.freeze(["COMPLETED", "FAILED"]),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
} as const satisfies TransitionMap<RefundStatus>);

export function canTransition<State extends string>(
  transitions: TransitionMap<State>,
  from: State,
  to: State,
): boolean {
  return transitions[from].includes(to);
}

export function transitionState<State extends string>(
  transitions: TransitionMap<State>,
  entity: string,
  from: State,
  to: State,
): State {
  if (!canTransition(transitions, from, to)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `${entity} cannot transition from ${from} to ${to}.`,
      { entity, from, to },
    );
  }

  return to;
}

export function transitionMandate(from: MandateStatus, to: MandateStatus): MandateStatus {
  return transitionState(MANDATE_TRANSITIONS, "Mandate", from, to);
}

export function transitionProposal(from: ProposalStatus, to: ProposalStatus): ProposalStatus {
  return transitionState(PROPOSAL_TRANSITIONS, "Purchase proposal", from, to);
}

export function transitionRefund(from: RefundStatus, to: RefundStatus): RefundStatus {
  return transitionState(REFUND_TRANSITIONS, "Refund", from, to);
}
