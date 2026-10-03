import { describe, expect, it } from "vitest";
import { readApprovalProposal } from "./client";
const base = {
  id: "proposal-1",
  status: "AUTHORIZED",
  total: 13900,
  currency: "USD",
  quantity: 1,
  shipping: 0,
  tax: 0,
  expiresAt: "2026-10-02T20:00:00.000Z",
  approvalExpiresAt: null,
  product: {
    title: "Demo headphones",
    brand: "Sony",
    condition: "NEW",
    merchant: "Demo Store",
    source: "demo",
  },
  mandate: { title: "Headphones", version: 1 },
};
describe("proposal approval context", () => {
  it("preserves missing historical brand and expiry facts without inventing them", () => {
    expect(
      readApprovalProposal({ ...base, expiresAt: null, product: { ...base.product, brand: null } }),
    ).toMatchObject({ expiresAt: null, product: { brand: null } });
  });
  it("permits policy-authorized checkout without inventing a human approval deadline", () => {
    expect(readApprovalProposal(base)).toMatchObject({
      status: "AUTHORIZED",
      approvalExpiresAt: null,
    });
  });
  it("rejects a pending approval without its exact deadline", () => {
    expect(() => readApprovalProposal({ ...base, status: "AWAITING_APPROVAL" })).toThrow();
  });
});
