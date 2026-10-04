import { normalizeProduct, type NormalizedProduct } from "./product.js";

const demoSourceProducts = [
  {
    id: "demo-headphones-139",
    title: "Sony WH-1000XM5 Noise Cancelling Headphones",
    brand: "Sony",
    category: "Headphones",
    condition: "NEW",
    price: "139.00",
    currency: "USD",
    merchant: "Mandate Demo Store",
    url: "https://demo.mandatepay.local/products/demo-headphones-139",
    metadata: { demoScenario: "allow", checkout: "demo" },
  },
  {
    id: "demo-headphones-169",
    title: "Sony WH-1000XM5 Noise Cancelling Headphones",
    brand: "Sony",
    category: "Headphones",
    condition: "NEW",
    price: "169.00",
    currency: "USD",
    merchant: "Mandate Demo Store",
    url: "https://demo.mandatepay.local/products/demo-headphones-169",
    metadata: { demoScenario: "approval", checkout: "demo" },
  },
  {
    id: "demo-headphones-refurbished",
    title: "Bose QuietComfort Refurbished Headphones",
    brand: "Bose",
    category: "Headphones",
    condition: "REFURBISHED",
    price: "120.00",
    currency: "USD",
    merchant: "Mandate Demo Store",
    url: "https://demo.mandatepay.local/products/demo-headphones-refurbished",
    metadata: { demoScenario: "blocked-condition", checkout: "demo" },
  },
  {
    id: "demo-printer-paper-27",
    title: "Everyday Printer Paper 500 Sheets",
    brand: "Mandate Supply Co.",
    category: "Office Supplies",
    condition: "NEW",
    price: "27.00",
    currency: "USD",
    merchant: "Mandate Demo Store",
    url: "https://demo.mandatepay.local/products/demo-printer-paper-27",
    metadata: { demoScenario: "autonomous", checkout: "demo" },
  },
] as const;

const DEMO_SKUS: Record<string, string> = {
  "demo-headphones-139": "demo-sku-headphones-139",
  "demo-headphones-169": "demo-sku-headphones-169",
  "demo-headphones-refurbished": "demo-sku-headphones-refurbished",
  "demo-printer-paper-27": "demo-sku-printer-paper-27",
};

export const DEMO_CATALOG: readonly NormalizedProduct[] = Object.freeze(
  demoSourceProducts.map((product) =>
    normalizeProduct(product, { source: "demo", demoSku: DEMO_SKUS[product.id] }),
  ),
);

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function searchDemoCatalog(
  query: string,
  limit = 20,
  brandHints: readonly string[] = [],
): readonly NormalizedProduct[] {
  let text = normalizeSearchText(query);
  const brands = [
    ...new Set(
      [...brandHints, ...DEMO_CATALOG.map((product) => product.brand ?? "")]
        .map(normalizeSearchText)
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  const brandPattern = brands.join("|");
  const alternatives = brandPattern
    ? text.match(
        new RegExp(
          `\\b(?:${brandPattern}) or (?:${brandPattern})(?: or (?:${brandPattern}))*\\b`,
          "u",
        ),
      )?.[0]
    : undefined;
  const allowedBrands = alternatives ? new Set(alternatives.split(" or ")) : null;
  if (alternatives) text = text.replace(alternatives, " ");
  const terms = text.split(/\s+/u).filter(Boolean);
  const matches =
    terms.length === 0
      ? DEMO_CATALOG.filter(
          (product) =>
            !allowedBrands || allowedBrands.has(normalizeSearchText(product.brand ?? "")),
        )
      : DEMO_CATALOG.filter((product) => {
          if (allowedBrands && !allowedBrands.has(normalizeSearchText(product.brand ?? "")))
            return false;
          const haystack = normalizeSearchText(
            [product.title, product.brand, product.category, product.merchant]
              .filter((value): value is string => value !== null)
              .join(" "),
          );
          return terms.every((term) => haystack.includes(term));
        });

  return matches.slice(0, limit);
}

export function lookupDemoProduct(productId: string): NormalizedProduct | null {
  return (
    DEMO_CATALOG.find(
      (product) => product.externalId === productId || product.demoSku === productId,
    ) ?? null
  );
}

export function demoPrice(productId: string): number | null {
  return lookupDemoProduct(productId)?.priceMinor ?? null;
}
