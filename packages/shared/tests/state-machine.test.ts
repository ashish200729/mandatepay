import { describe, expect, it } from "vitest";
import {
  DomainError,
  MANDATE_TRANSITIONS,
  PROPOSAL_TRANSITIONS,
  REFUND_TRANSITIONS,
  canTransition,
  transitionMandate,
  transitionProposal,
  transitionRefund,
} from "../src/index.js";

describe("domain state machines", () => {
  it("freezes transition maps and their transition lists", () => {
    expect(Object.isFrozen(MANDATE_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(MANDATE_TRANSITIONS.ACTIVE)).toBe(true);
    expect(Object.isFrozen(PROPOSAL_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(REFUND_TRANSITIONS)).toBe(true);
  });

  it("allows mandate activation, pause/resume, and revocation paths", () => {
    expect(transitionMandate("DRAFT", "ACTIVE")).toBe("ACTIVE");
    expect(transitionMandate("ACTIVE", "PAUSED")).toBe("PAUSED");
    expect(transitionMandate("PAUSED", "ACTIVE")).toBe("ACTIVE");
    expect(transitionMandate("ACTIVE", "REVOKED")).toBe("REVOKED");
    expect(canTransition(MANDATE_TRANSITIONS, "REVOKED", "ACTIVE")).toBe(false);
  });

  it("allows all proposal decision branches and payment progression", () => {
    expect(transitionProposal("PROPOSED", "POLICY_CHECKED")).toBe("POLICY_CHECKED");
    expect(transitionProposal("POLICY_CHECKED", "BLOCKED")).toBe("BLOCKED");
    expect(transitionProposal("POLICY_CHECKED", "AWAITING_APPROVAL")).toBe("AWAITING_APPROVAL");
    expect(transitionProposal("AWAITING_APPROVAL", "APPROVED")).toBe("APPROVED");
    expect(transitionProposal("APPROVED", "AUTHORIZED")).toBe("AUTHORIZED");
    expect(transitionProposal("AUTHORIZED", "PAYPAL_ORDER_CREATED")).toBe("PAYPAL_ORDER_CREATED");
    expect(transitionProposal("PAYPAL_ORDER_CREATED", "PAYMENT_PENDING")).toBe("PAYMENT_PENDING");
    expect(transitionProposal("PAYMENT_PENDING", "COMPLETED")).toBe("COMPLETED");
  });

  it("rejects forbidden proposal and refund transitions with a typed error", () => {
    expect(() => transitionProposal("BLOCKED", "AUTHORIZED")).toThrowError(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    );
    expect(() => transitionProposal("COMPLETED", "PAYMENT_PENDING")).toThrowError(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    );
    expect(() => transitionRefund("COMPLETED", "FAILED")).toThrowError(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    );
  });

  it("keeps transition failures inspectable as DomainError instances", () => {
    try {
      transitionMandate("EXPIRED", "ACTIVE");
      throw new Error("expected transition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).details).toEqual({
        entity: "Mandate",
        from: "EXPIRED",
        to: "ACTIVE",
      });
    }
  });
});
