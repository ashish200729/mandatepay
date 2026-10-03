import { describe, expect, it } from "vitest";
import { approvalReasonText } from "./reasons";

describe("approval reason copy", () => {
  it("maps known policy codes to plain-language reasons", () => {
    expect(
      approvalReasonText({
        decision: "REQUIRE_APPROVAL",
        reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
      }),
    ).toBe("The amount is above your automatic spending limit.");
  });

  it("does not expose unknown machine codes", () => {
    expect(approvalReasonText({ decision: "REQUIRE_APPROVAL", reasonCodes: ["SECRET_CODE"] })).toBe(
      "This proposal needs your review under the mandate rules.",
    );
  });
});
