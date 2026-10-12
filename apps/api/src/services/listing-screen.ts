import { screenUntrustedContent, type ContentScreenResult } from "@mandatepay/agentguard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Screens every retailer-supplied text field of a catalog listing for instructions aimed at AI
 * agents. Shared by the shopping chat and the external agent gateway so both apply one policy.
 */
export function listingScreen(value: unknown): ContentScreenResult {
  if (!isRecord(value)) return screenUntrustedContent({});
  const text = (entry: unknown) => (typeof entry === "string" ? entry : null);
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  return screenUntrustedContent({
    title: text(value.title),
    brand: text(value.brand),
    category: text(value.category),
    merchant: text(value.merchant),
    categoryPath: Array.isArray(metadata.categoryPath)
      ? metadata.categoryPath.filter((entry): entry is string => typeof entry === "string")
      : [],
    description: text(metadata.description),
  });
}
