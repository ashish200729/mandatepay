import { describe, expect, it } from "vitest";
import { DEMO_MANDATE_PROMPT } from "./demo";

describe("demo mandate request", () => {
  it("states every rule the demo scenarios depend on", () => {
    expect(DEMO_MANDATE_PROMPT).toBe(
      "Buy Sony or Bose noise-cancelling headphones, new only. Never spend more than $180 on one purchase, and buy automatically up to $150. Don't ask me again for new stores.",
    );
  });
});
