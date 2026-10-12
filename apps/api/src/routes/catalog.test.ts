import { describe, expect, it } from "vitest";
import { lookupDemoProduct } from "@mandatepay/channel3";
import { screenProductSnapshot } from "../services/proposals.js";
import { SNAPSHOT_DESCRIPTION_MAX_LENGTH, snapshotDescription } from "./catalog.js";

describe("product snapshot description", () => {
  it("keeps the catalog description, trimmed and bounded to 2,000 characters", () => {
    expect(snapshotDescription({ description: "  Quiet, comfortable headphones.  " })).toEqual({
      description: "Quiet, comfortable headphones.",
    });
    const long = snapshotDescription({ description: "a".repeat(5_000) });
    expect(SNAPSHOT_DESCRIPTION_MAX_LENGTH).toBe(2_000);
    expect(long.description).toHaveLength(2_000);
  });

  it("omits missing, blank and non-text descriptions", () => {
    expect(snapshotDescription(undefined)).toEqual({});
    expect(snapshotDescription(null)).toEqual({});
    expect(snapshotDescription(["description"])).toEqual({});
    expect(snapshotDescription({})).toEqual({});
    expect(snapshotDescription({ description: "   " })).toEqual({});
    expect(snapshotDescription({ description: 42 })).toEqual({});
  });

  it("lets content screening flag seller text from the snapshot alone", () => {
    const product = lookupDemoProduct("demo-headphones-openbox-135");
    expect(product).not.toBeNull();
    // A non-demo source cannot fall back to the in-process catalog, so only the
    // snapshot's own description can carry the injected instruction.
    const snapshot = {
      source: "channel3",
      title: product!.title,
      brand: product!.brand,
      category: product!.category,
      merchant: product!.merchant,
    };
    expect(screenProductSnapshot({ ...snapshot, metadata: {} }).risk).toBe("none");
    const screened = screenProductSnapshot({
      ...snapshot,
      metadata: { externalId: product!.externalId, ...snapshotDescription(product!.metadata) },
    });
    expect(screened.risk).toBe("malicious");
    expect(screened.fields).toContain("description");
  });
});
