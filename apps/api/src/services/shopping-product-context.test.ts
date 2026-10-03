import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readShoppingProducts,
  signShoppingProducts,
  type ShoppingProduct,
} from "./shopping-product-context.js";

const owner = { userId: "owner", mandateId: "nike", mandateVersion: 1 };
const secret = "fixture-context-signing-key";
const product: ShoppingProduct = {
  source: "channel3",
  externalId: "pegasus",
  title: "M AIR PEGASUS 2005",
  brand: "Nike",
  category: "Sneakers",
  categoryPath: ["Shoes", "Sneakers"],
  condition: "NEW",
  priceMinor: 4_900,
  currency: "USD",
  merchant: "ka-yo.com",
  productUrl: "https://ka-yo.com/product/pegasus",
};
describe("verified shopping references", () => {
  afterEach(() => vi.useRealTimers());
  it("retains only the eight displayed listings and preserves their exact retailer and price", () => {
    const token = signShoppingProducts(
      Array.from({ length: 12 }, (_, i) => ({
        ...product,
        externalId: String(i),
        priceMinor: 4900 + i,
      })),
      owner,
      secret,
    )!;
    const products = readShoppingProducts(token, owner, secret)!;
    expect(products).toHaveLength(8);
    expect(products[0]).toMatchObject({ merchant: "ka-yo.com", priceMinor: 4900 });
  });
  it.each([
    [{ ...owner, userId: "someone-else" }, secret],
    [{ ...owner, mandateId: "another-mandate" }, secret],
    [{ ...owner, mandateVersion: 2 }, secret],
    [owner, "wrong-secret"],
  ])("rejects another owner, mandate, version or signing key", (recipient, key) => {
    expect(
      readShoppingProducts(signShoppingProducts([product], owner, secret)!, recipient, key),
    ).toBeNull();
  });
  it("rejects client-modified prices and expired references", () => {
    vi.useFakeTimers();
    const token = signShoppingProducts([product], owner, secret)!;
    const [payload, signature] = token.split(".");
    const modified = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    modified.products[0].priceMinor = 1;
    const forged = `${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signature}`;
    expect(readShoppingProducts(forged, owner, secret)).toBeNull();
    vi.advanceTimersByTime(15 * 60_000);
    expect(readShoppingProducts(token, owner, secret)).toBeNull();
  });
  it.each(["", "invalid", "a.b.c", "x".repeat(50_001)])("rejects malformed references", (token) => {
    expect(readShoppingProducts(token, owner, secret)).toBeNull();
  });
});
