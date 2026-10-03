import {
  CurrencyCodeSchema,
  ProductConditionSchema,
  minorUnitsSchema,
  parseDecimalToMinorUnits,
  toMinorUnits,
  type CurrencyCode,
  type MinorUnits,
  type ProductCondition,
} from "@mandatepay/shared";
import { z } from "zod";
import { Channel3NormalizationError } from "./errors.js";

const normalizedProductShape = {
  source: z.enum(["channel3", "demo"]),
  externalId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1).nullable(),
  condition: ProductConditionSchema,
  priceMinor: minorUnitsSchema,
  currency: CurrencyCodeSchema,
  merchant: z.string().trim().min(1),
  imageUrl: z.string().trim().min(1).nullable(),
  productUrl: z.string().trim().min(1).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  checkoutEligible: z.boolean(),
  demoSku: z.string().trim().min(1).nullable(),
} as const;

function checkoutEligibilityRefinement(
  product: { source: "channel3" | "demo"; checkoutEligible: boolean; demoSku: string | null },
  context: z.RefinementCtx,
): void {
  if (product.source === "demo" && (!product.checkoutEligible || product.demoSku === null)) {
    context.addIssue({
      code: "custom",
      path: ["demoSku"],
      message: "Demo products need checkout mapping.",
    });
  }
  if (product.source === "channel3" && (product.checkoutEligible || product.demoSku !== null)) {
    context.addIssue({
      code: "custom",
      path: ["checkoutEligible"],
      message: "External discovery products cannot be checkout eligible.",
    });
  }
}

export const NormalizedProductSchema = z
  .object(normalizedProductShape)
  .strict()
  .superRefine(checkoutEligibilityRefinement);

export type NormalizedProduct = z.output<typeof NormalizedProductSchema>;

export const ProductSnapshotSchema = z
  .object({
    ...normalizedProductShape,
    capturedAt: z.string().datetime({ offset: false }),
  })
  .strict()
  .superRefine(checkoutEligibilityRefinement);

export type ProductSnapshot = z.output<typeof ProductSnapshotSchema>;

export interface NormalizeProductOptions {
  readonly source?: "channel3" | "demo";
  readonly demoSku?: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function firstValue(records: readonly (JsonRecord | null)[], keys: readonly string[]): unknown {
  for (const source of records) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nestedName(value: unknown): string | undefined {
  return stringValue(value) ?? stringValue(record(value)?.name);
}

function normalizeCondition(value: unknown): ProductCondition | undefined {
  const normalized = stringValue(value)?.toUpperCase().replace(/[ -]+/gu, "_");
  if (!normalized) return undefined;
  if (normalized === "RENEWED" || normalized === "OPEN_BOX") return "REFURBISHED";
  return ProductConditionSchema.safeParse(normalized).success
    ? (normalized as ProductCondition)
    : undefined;
}

function rawMetadata(value: unknown): JsonRecord {
  const metadata = record(value);
  if (!metadata) return {};
  try {
    return JSON.parse(JSON.stringify(metadata)) as JsonRecord;
  } catch {
    throw new Channel3NormalizationError("INCOMPLETE_PRODUCT");
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonRecord)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

function parsePrice(
  raw: JsonRecord,
  offer: JsonRecord | null,
): { readonly amount: MinorUnits; readonly currency: CurrencyCode } {
  const priceValue = firstValue([raw, offer], ["price", "current_price", "amount"]);
  const priceRecord = record(priceValue);
  const amountValue = firstValue(
    [priceRecord, raw, offer],
    ["amount", "value", "price", "current_price"],
  );
  const currencyValue = firstValue(
    [priceRecord, raw, offer],
    ["currency", "currency_code", "currencyCode"],
  );
  const minorValue = firstValue([raw, offer], ["price_minor", "priceMinor"]);

  const hasAmount =
    typeof minorValue === "number" ||
    typeof minorValue === "string" ||
    typeof amountValue === "number" ||
    typeof amountValue === "string";
  if (!hasAmount) {
    throw new Channel3NormalizationError("INVALID_PRICE");
  }

  const currencyResult = CurrencyCodeSchema.safeParse(currencyValue);
  if (!currencyResult.success) {
    throw new Channel3NormalizationError("UNSUPPORTED_CURRENCY");
  }

  try {
    if (typeof minorValue === "number") {
      return { amount: toMinorUnits(minorValue), currency: currencyResult.data };
    }
    if (typeof minorValue === "string") {
      if (!/^(?:0|[1-9]\d*)$/u.test(minorValue)) {
        throw new Channel3NormalizationError("INVALID_PRICE");
      }
      return {
        amount: toMinorUnits(Number(minorValue)),
        currency: currencyResult.data,
      };
    }
    if (typeof amountValue === "number" || typeof amountValue === "string") {
      return {
        amount: parseDecimalToMinorUnits(String(amountValue), currencyResult.data),
        currency: currencyResult.data,
      };
    }
  } catch {
    throw new Channel3NormalizationError("INVALID_PRICE");
  }

  throw new Channel3NormalizationError("INVALID_PRICE");
}

function extractOffer(raw: JsonRecord): JsonRecord | null {
  const offers = raw.offers;
  if (!Array.isArray(offers)) return null;
  return record(offers[0]);
}

export function normalizeProduct(
  rawInput: unknown,
  options: NormalizeProductOptions = {},
): NormalizedProduct {
  const raw = record(rawInput);
  if (!raw) throw new Channel3NormalizationError("INCOMPLETE_PRODUCT");

  const source = options.source ?? "channel3";
  const offer = extractOffer(raw);
  const sources = [raw, offer] as const;
  const externalId = stringValue(
    firstValue(sources, ["id", "product_id", "productId", "canonical_product_id", "externalId"]),
  );
  const title = stringValue(firstValue(sources, ["title", "name", "product_title"]));
  const brand = nestedName(firstValue(sources, ["brand", "manufacturer"]));
  const categoryValue = firstValue(sources, ["category", "category_name", "categoryName"]);
  const category = nestedName(categoryValue);
  const condition = normalizeCondition(
    firstValue(sources, ["condition", "item_condition", "itemCondition"]),
  );
  const merchant = nestedName(firstValue(sources, ["merchant", "merchant_name", "seller"]));
  const imageValue = firstValue(sources, ["image_url", "imageUrl", "image"]);
  const imageUrl = stringValue(imageValue) ?? stringValue(record(imageValue)?.url);
  const productUrl = stringValue(firstValue(sources, ["product_url", "productUrl", "url"]));

  if (!externalId) throw new Channel3NormalizationError("INVALID_PRODUCT_ID");
  if (!title || !brand || !condition || !merchant) {
    throw new Channel3NormalizationError("INCOMPLETE_PRODUCT");
  }

  const price = parsePrice(raw, offer);
  const checkoutEligible = source === "demo";
  const demoSku = options.demoSku ?? null;
  if (source === "demo" && !demoSku) {
    throw new Channel3NormalizationError("INCOMPLETE_PRODUCT");
  }

  const product = NormalizedProductSchema.parse({
    source,
    externalId,
    title,
    brand,
    category: category ?? null,
    condition,
    priceMinor: price.amount,
    currency: price.currency,
    merchant,
    imageUrl: imageUrl ?? null,
    productUrl: productUrl ?? null,
    metadata: rawMetadata(raw.metadata),
    checkoutEligible,
    demoSku,
  });

  return freezeDeep(product);
}

export function snapshotProduct(product: NormalizedProduct, capturedAt: string): ProductSnapshot {
  const snapshot = ProductSnapshotSchema.parse({ ...product, capturedAt });
  return freezeDeep(snapshot);
}
