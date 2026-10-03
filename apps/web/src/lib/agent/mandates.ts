import type { MandateDetail } from "../mandates/types";

export function activeShoppingMandates(mandates: MandateDetail[], now = Date.now()) {
  return mandates.filter((mandate) => {
    const startsAt = mandate.startsAt ? Date.parse(mandate.startsAt) : Number.NaN;
    const expiresAt = mandate.expiresAt ? Date.parse(mandate.expiresAt) : Number.NaN;
    return mandate.status === "ACTIVE" && startsAt <= now && expiresAt > now;
  });
}

export function selectShoppingMandate(mandates: MandateDetail[], current: string) {
  if (current && mandates.some((mandate) => mandate.id === current)) return current;
  return mandates.length === 1 ? (mandates[0]?.id ?? "") : "";
}
