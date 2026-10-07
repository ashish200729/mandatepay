const day = /^\d{4}-\d{2}-\d{2}$/u;

export function queryPath(path: string, extra: Record<string, string | undefined | null> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  params.sort();
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export function utcDayBounds(value: string) {
  if (!day.test(value)) return null;
  const from = `${value}T00:00:00.000Z`;
  return { from, to: new Date(Date.parse(from) + 86_400_000).toISOString() };
}

export function chartRecordHref(
  metric: string,
  key: string,
  range: { from: string; to: string },
): string | null {
  const dated = (path: string, extra: Record<string, string | undefined> = {}) =>
    queryPath(path, { from: range.from, to: range.to, ...extra });
  const dayRange = utcDayBounds(key);
  if (metric === "newUsersByDay" && dayRange)
    return queryPath("/users", { from: dayRange.from, to: dayRange.to });
  if (metric === "capturedGrossByDay" && dayRange)
    return queryPath("/payments", {
      dateBasis: "captured",
      from: dayRange.from,
      to: dayRange.to,
    });
  if (metric === "refundsByDay" && dayRange)
    return queryPath("/refunds", {
      status: "COMPLETED",
      dateBasis: "settled",
      from: dayRange.from,
      to: dayRange.to,
    });
  if (metric === "policyDistribution") return dated("/proposals", { decision: key });
  if (metric === "approvalFunnel") {
    if (key === "CREATED") return dated("/proposals");
    if (key === "REQUIRE_APPROVAL") return dated("/proposals", { decision: "REQUIRE_APPROVAL" });
    if (key === "APPROVAL_CREATED") return queryPath("/approvals");
    if (key === "APPROVED" || key === "REJECTED" || key === "PENDING" || key === "EXPIRED")
      return queryPath("/approvals", { decision: key });
  }
  if (metric === "checkoutFunnel") {
    if (key === "CREATED") return dated("/proposals");
    if (key === "POLICY_ALLOW") return dated("/proposals", { decision: "ALLOW" });
    if (key === "ORDER_CREATED") return dated("/orders");
    if (key === "PROVIDER_APPROVED") return queryPath("/payments", { status: "APPROVED" });
    if (key === "CAPTURED") return dated("/payments", { dateBasis: "captured" });
    if (key === "FAILED") return dated("/payments", { status: "FAILED" });
  }
  if (metric === "webhookStatusCounts") return queryPath("/webhooks", { status: key });
  if (metric === "webhookDeliveriesByDay" && dayRange)
    return queryPath("/webhooks", { from: dayRange.from, to: dayRange.to });
  if (metric === "webhookDeliveryOutcomes") return dated("/webhooks");
  if (metric === "mandateStatusDistribution") {
    if (key === "EFFECTIVELY_EXPIRED") return queryPath("/mandates", { effectiveExpired: "true" });
    return queryPath("/mandates", { status: key });
  }
  if (metric === "agentRunsByDay" && dayRange)
    return queryPath("/agent", { from: dayRange.from, to: dayRange.to });
  if (metric === "agentErrorClasses")
    return dated("/agent", { errorClass: key, outcome: "FAILED" });
  if (metric === "topErrorCategories") {
    if (key.startsWith("AGENT:"))
      return dated("/agent", { errorClass: key.slice("AGENT:".length), outcome: "FAILED" });
    if (key.startsWith("PAY:")) return dated("/payments", { status: "FAILED" });
    if (key.startsWith("REF:")) return dated("/refunds", { status: "FAILED" });
    if (key.startsWith("WEBHOOK:")) return dated("/webhooks", { status: "FAILED" });
  }
  return null;
}

export const CHART_RANGE_HREFS: Record<string, (range: { from: string; to: string }) => string> = {
  newUsersByDay: (range) => queryPath("/users", range),
  capturedGrossByDay: (range) => queryPath("/payments", { ...range, dateBasis: "captured" }),
  refundsByDay: (range) =>
    queryPath("/refunds", { ...range, status: "COMPLETED", dateBasis: "settled" }),
  policyDistribution: (range) => queryPath("/proposals", range),
  approvalFunnel: (range) => queryPath("/proposals", range),
  checkoutFunnel: (range) => queryPath("/proposals", range),
  webhookStatusCounts: () => "/webhooks",
  webhookDeliveriesByDay: (range) => queryPath("/webhooks", range),
  webhookDeliveryOutcomes: (range) => queryPath("/webhooks", range),
  topErrorCategories: (range) => queryPath("/payments", { ...range, status: "FAILED" }),
  mandateStatusDistribution: () => "/mandates",
  agentRunsByDay: (range) => queryPath("/agent", range),
  agentErrorClasses: (range) => queryPath("/agent", { ...range, outcome: "FAILED" }),
};
