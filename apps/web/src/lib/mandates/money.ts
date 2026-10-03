const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;

export function parseUsdDecimal(value: string) {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) throw new Error("Enter a non-negative USD amount with up to two decimal places.");

  const whole = match[1];
  if (whole === undefined) throw new Error("Enter a valid USD amount.");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const minor = BigInt(whole) * 100n + BigInt(fraction);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("This amount is too large to use safely.");
  }

  return Number(minor);
}

export function formatUsdMinor(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isSafeInteger(value) || value < 0) {
    return "";
  }

  const minor = BigInt(value);
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}`;
}

export function formatUsdLabel(value: number | null | undefined) {
  const decimal = formatUsdMinor(value);
  return decimal ? `$${decimal}` : "—";
}

export function parseQuantity(value: string) {
  if (!/^\d+$/.test(value.trim())) throw new Error("Quantity must be a whole number.");
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Quantity must be at least 1.");
  }
  return quantity;
}

export function toUtcIso(value: string) {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Use a valid UTC date and time.");

  const [, year, month, day, hours, minutes] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes)),
  );
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hours) ||
    date.getUTCMinutes() !== Number(minutes)
  ) {
    throw new Error("Use a valid UTC date and time.");
  }

  return date.toISOString();
}

export function fromUtcIso(value: string | undefined) {
  if (!value) return "";
  const date = new Date(`${value.endsWith("Z") ? value : `${value}Z`}`);
  if (Number.isNaN(date.getTime())) return "";

  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function formatUtcDate(value: string | null | undefined) {
  if (!value) return "Server default · UTC";
  const date = new Date(`${value.endsWith("Z") ? value : `${value}Z`}`);
  if (Number.isNaN(date.getTime())) return "Invalid UTC date";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
