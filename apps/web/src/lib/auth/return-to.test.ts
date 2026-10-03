import { describe, expect, it } from "vitest";
import { getAuthLink, getSafeReturnTo } from "./return-to";

describe("safe auth return paths", () => {
  it("keeps an allowed workspace path and its query string", () => {
    expect(getSafeReturnTo("/dashboard?range=week")).toBe("/dashboard?range=week");
    expect(getSafeReturnTo("/mandates/mandate_123")).toBe("/mandates/mandate_123");
    expect(getSafeReturnTo("/proposals/proposal_123")).toBe("/proposals/proposal_123");
  });

  it("falls back for external and disallowed destinations", () => {
    expect(getSafeReturnTo("https://example.com/phishing")).toBe("/chat");
    expect(getSafeReturnTo("//example.com/phishing")).toBe("/chat");
    expect(getSafeReturnTo("/signin")).toBe("/chat");
    expect(getSafeReturnTo("/chat\\\\example.com")).toBe("/chat");
    expect(getSafeReturnTo(null)).toBe("/chat");
  });

  it("encodes the validated destination in auth links", () => {
    expect(getAuthLink("/signin", "/approvals?filter=pending")).toBe(
      "/signin?returnTo=%2Fapprovals%3Ffilter%3Dpending",
    );
  });
});
