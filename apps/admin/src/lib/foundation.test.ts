import { describe, expect, it } from "vitest";
import { adminEnvironment } from "./environment";
import { AdminActionError, safeActionError } from "./action-error";
describe("admin UI boundaries", () => {
  it("uses explicit environment labels and never invents a production or staging environment", () => {
    expect(adminEnvironment(undefined, "http://127.0.0.1:3001")).toBe("local");
    expect(adminEnvironment("staging", "https://admin.example.test")).toBe("staging");
    expect(adminEnvironment("production", "https://admin.example.test")).toBe("production");
    expect(adminEnvironment(undefined, "https://admin.example.test")).toBe("unknown");
    expect(adminEnvironment("anything", "http://localhost:3001")).toBe("unknown");
    expect(adminEnvironment(undefined, "invalid")).toBe("unknown");
  });
  it("shows classified action failures without echoing provider errors or asserting success", () => {
    expect(safeActionError(new AdminActionError("conflict"))).toContain("record changed");
    expect(safeActionError(new Error("provider token=secret"))).not.toContain("secret");
    expect(safeActionError(new Error("provider token=secret"))).toContain("could not be confirmed");
  });
});
