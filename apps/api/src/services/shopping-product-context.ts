import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const text = z.string().min(1).max(1_000);
export const shoppingProductSchema = z
  .object({
    source: z.enum(["demo", "channel3"]),
    externalId: z.string().min(1).max(255),
    title: text,
    brand: text.nullable(),
    category: text.nullable(),
    categoryPath: z.array(text).max(40),
    condition: z.enum(["NEW", "USED", "REFURBISHED"]),
    priceMinor: z.number().int().nonnegative().safe(),
    currency: z.literal("USD"),
    merchant: text,
    productUrl: z.string().max(4_000).nullable(),
  })
  .strict();
export type ShoppingProduct = z.output<typeof shoppingProductSchema>;

const contextSchema = z
  .object({
    purpose: z.literal("shopping-discovery-v1"),
    userId: text,
    mandateId: text,
    mandateVersion: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    products: z.array(shoppingProductSchema).max(8),
  })
  .strict();
type Owner = { userId: string; mandateId: string; mandateVersion: number };

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`shopping-discovery-v1:${payload}`).digest();
}

/** These references preserve discovery facts, never approval or payment permission. */
export function signShoppingProducts(
  products: readonly ShoppingProduct[],
  owner: Owner,
  secret: string,
) {
  const payload = Buffer.from(
    JSON.stringify(
      contextSchema.parse({
        purpose: "shopping-discovery-v1",
        ...owner,
        expiresAt: Date.now() + 15 * 60_000,
        products: [...products].sort((a, b) => a.priceMinor - b.priceMinor).slice(0, 8),
      }),
    ),
  ).toString("base64url");
  const token = `${payload}.${signature(payload, secret).toString("base64url")}`;
  return token.length <= 50_000 ? token : null;
}

export function readShoppingProducts(
  token: string,
  owner: Owner,
  secret: string,
): ShoppingProduct[] | null {
  try {
    if (token.length > 50_000) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, supplied] = parts as [string, string];
    const expected = signature(payload, secret);
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const parsed = contextSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    const data = parsed.data;
    if (
      data.userId !== owner.userId ||
      data.mandateId !== owner.mandateId ||
      data.mandateVersion !== owner.mandateVersion ||
      data.expiresAt <= Date.now()
    )
      return null;
    return data.products;
  } catch {
    return null;
  }
}
