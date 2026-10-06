import { formatMinorUnits, toMinorUnits } from "@mandatepay/shared";

export function formatUsd(amountMinor: number) {
  try {
    return formatMinorUnits(toMinorUnits(amountMinor), "USD");
  } catch {
    return "Amount unavailable";
  }
}
