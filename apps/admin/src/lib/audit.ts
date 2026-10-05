import { parseAdminAuditEvent, type AdminAuditEventDTO } from "@mandatepay/shared";

/** Project every row again at the BFF boundary; never spread upstream JSON. */
export function parseAdminAuditResponse(
  value: unknown,
  detail: boolean,
): {
  data: AdminAuditEventDTO | AdminAuditEventDTO[];
  page?: { limit: number; nextCursor: string | null };
} | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  if (detail) {
    const event = parseAdminAuditEvent(value.data);
    return event ? { data: event } : null;
  }
  if (
    !Array.isArray(value.data) ||
    value.data.length > 100 ||
    !("page" in value) ||
    !value.page ||
    typeof value.page !== "object"
  )
    return null;
  const events = value.data.map(parseAdminAuditEvent);
  if (events.some((event) => event === null)) return null;
  const page = value.page as { limit?: unknown; nextCursor?: unknown };
  if (
    !Number.isInteger(page.limit) ||
    typeof page.limit !== "number" ||
    page.limit < 1 ||
    page.limit > 100 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" || page.nextCursor.length > 2048))
  )
    return null;
  if (events.length > page.limit || page.nextCursor === "") return null;
  return {
    data: events as AdminAuditEventDTO[],
    page: { limit: page.limit, nextCursor: page.nextCursor as string | null },
  };
}
