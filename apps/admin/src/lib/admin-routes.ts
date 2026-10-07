import {
  ADMIN_EXPORT_COLUMNS,
  AdminActivityQuerySchema,
  AdminApprovalQuerySchema,
  AdminAuditQuerySchema,
  AdminDomainAuditQuerySchema,
  AdminMandateQuerySchema,
  AdminMandateVersionQuerySchema,
  AdminNoteQuerySchema,
  AdminOrderQuerySchema,
  AdminOverviewQuerySchema,
  AdminPaymentQuerySchema,
  AdminProposalDecisionQuerySchema,
  AdminProposalQuerySchema,
  AdminRefundQuerySchema,
  AdminResourceIdSchema,
  AdminTraceIdSchema,
  AdminUserQuerySchema,
  AdminUserSessionQuerySchema,
  AdminWebhookQuerySchema,
  AdminAgentMetricsQuerySchema,
  AdminAgentRunQuerySchema,
  parseAdminActivityEvent,
  parseAdminApproval,
  parseAdminDetail,
  parseAdminDomainAudit,
  parseAdminList,
  parseAdminMandate,
  parseAdminMandateVersion,
  parseAdminMutation,
  parseAdminNote,
  parseAdminNullableDetail,
  parseAdminOrder,
  parseAdminOverview,
  parseAdminPayment,
  parseAdminPlatformSetting,
  parseAdminPolicyDecision,
  parseAdminProposal,
  parseAdminRefund,
  parseAdminReservation,
  parseAdminUser,
  parseAdminUserSession,
  parseAdminWebhook,
  parseAdminSystemHealth,
  parseAdminWorkerHealth,
  parseAdminIntegrationHealth,
  parseAdminAgentMetrics,
  parseAdminAgentRun,
  isPlatformSettingKey,
  type AdminExportResource,
} from "@mandatepay/shared";
import { parseAdminAuditResponse } from "./audit";
import { parseAdminMe } from "./session";

const GET = ["GET", "HEAD"] as const;
export type AdminProxyKind = "auth" | "me" | "json" | "csv";
export type AdminProxyMatch = {
  methods: readonly string[];
  kind: AdminProxyKind;
  query?: { safeParse: (value: unknown) => { success: boolean } };
  allowSearch: boolean;
  upstreamPath: string;
  parseJson?: (value: unknown) => unknown | null;
  csvResource?: AdminExportResource;
};

function id(value: string | undefined) {
  return value !== undefined && AdminResourceIdSchema.safeParse(value).success;
}

function runId(value: string | undefined) {
  return value !== undefined && AdminTraceIdSchema.safeParse(value).success;
}

export function matchAdminProxy(
  path: string[] | undefined,
  method = "GET",
): AdminProxyMatch | null {
  if (!path?.length || path.length > 3) return null;
  const [a, b, c] = path;
  if (path.length === 1) {
    if (a === "session")
      return {
        methods: ["POST"],
        kind: "auth",
        allowSearch: false,
        upstreamPath: "session",
        parseJson: parseAdminMeEnvelope,
      };
    if (a === "me")
      return {
        methods: GET,
        kind: "me",
        allowSearch: false,
        upstreamPath: "me",
        parseJson: parseAdminMeEnvelope,
      };
    if (a === "reauth")
      return {
        methods: ["POST"],
        kind: "auth",
        allowSearch: false,
        upstreamPath: "reauth",
        parseJson: parseAdminMeEnvelope,
      };
    if (a === "sign-out")
      return { methods: ["POST"], kind: "auth", allowSearch: false, upstreamPath: "sign-out" };
    if (a === "overview")
      return json("overview", AdminOverviewQuerySchema, (value) =>
        parseAdminDetail(value, parseAdminOverview),
      );
    if (a === "settings")
      return {
        methods: GET,
        kind: "json",
        allowSearch: false,
        upstreamPath: "settings",
        parseJson: (value) => parseAdminList(value, parseAdminPlatformSetting),
      };
    return list(a);
  }
  if (path.length === 2 && a === "settings" && b && isPlatformSettingKey(b))
    return {
      methods: ["PATCH"],
      kind: "json",
      allowSearch: false,
      upstreamPath: `settings/${b}`,
      parseJson: (value) => parseAdminMutation(value, parseAdminPlatformSetting),
    };
  if (path.length === 2 && a === "overview" && b === "activity")
    return json("overview/activity", AdminActivityQuerySchema, (value) =>
      parseAdminList(value, parseAdminActivityEvent),
    );
  if (path.length === 2 && a === "system" && b === "health")
    return {
      methods: GET,
      kind: "json",
      allowSearch: false,
      upstreamPath: "system/health",
      parseJson: (value) => parseAdminDetail(value, parseAdminSystemHealth),
    };
  if (path.length === 2 && a === "system" && b === "workers")
    return {
      methods: GET,
      kind: "json",
      allowSearch: false,
      upstreamPath: "system/workers",
      parseJson: (value) => parseAdminDetail(value, parseAdminWorkerHealth),
    };
  if (path.length === 2 && a === "system" && b === "integrations")
    return {
      methods: GET,
      kind: "json",
      allowSearch: false,
      upstreamPath: "system/integrations",
      parseJson: (value) => parseAdminDetail(value, parseAdminIntegrationHealth),
    };
  if (path.length === 2 && a === "agent" && b === "metrics")
    return json("agent/metrics", AdminAgentMetricsQuerySchema, (value) =>
      parseAdminDetail(value, parseAdminAgentMetrics),
    );
  if (path.length === 2 && a === "agent" && b === "runs")
    return json("agent/runs", AdminAgentRunQuerySchema, (value) =>
      parseAdminList(value, parseAdminAgentRun),
    );
  if (path.length === 3 && a === "agent" && b === "runs" && runId(c))
    return {
      methods: GET,
      kind: "json",
      allowSearch: false,
      upstreamPath: `agent/runs/${c}`,
      parseJson: (value) => parseAdminDetail(value, parseAdminAgentRun),
    };
  if (path.length === 2 && b === "export") return exportRoute(a);
  if (path.length === 2 && a === "audit" && id(b))
    return {
      methods: GET,
      kind: "json",
      allowSearch: false,
      upstreamPath: `audit/${b}`,
      parseJson: (value) => parseAdminAuditResponse(value, true),
    };
  if (path.length === 2 && a && nestedList(a) && id(b) === false && b) return null;
  if (path.length === 2 && a && id(b)) return detail(a, b!);
  if (path.length === 3 && a && id(b) && c) {
    if (method === "POST") return nestedMutation(a, b!, c);
    return nested(a, b!, c);
  }
  return null;
}

function parseAdminMeEnvelope(value: unknown) {
  const admin = parseAdminMe(value);
  return admin ? { data: admin } : null;
}

function list(resource: string | undefined): AdminProxyMatch | null {
  const query =
    resource === "users"
      ? AdminUserQuerySchema
      : resource === "mandates"
        ? AdminMandateQuerySchema
        : resource === "proposals"
          ? AdminProposalQuerySchema
          : resource === "approvals"
            ? AdminApprovalQuerySchema
            : resource === "orders"
              ? AdminOrderQuerySchema
              : resource === "payments"
                ? AdminPaymentQuerySchema
                : resource === "refunds"
                  ? AdminRefundQuerySchema
                  : resource === "webhooks"
                    ? AdminWebhookQuerySchema
                    : resource === "domain-audit"
                      ? AdminDomainAuditQuerySchema
                      : resource === "audit"
                        ? AdminAuditQuerySchema
                        : null;
  const parse =
    resource === "users"
      ? (value: unknown) => parseAdminList(value, parseAdminUser)
      : resource === "mandates"
        ? (value: unknown) => parseAdminList(value, parseAdminMandate)
        : resource === "proposals"
          ? (value: unknown) => parseAdminList(value, parseAdminProposal)
          : resource === "approvals"
            ? (value: unknown) => parseAdminList(value, parseAdminApproval)
            : resource === "orders"
              ? (value: unknown) => parseAdminList(value, parseAdminOrder)
              : resource === "payments"
                ? (value: unknown) => parseAdminList(value, parseAdminPayment)
                : resource === "refunds"
                  ? (value: unknown) => parseAdminList(value, parseAdminRefund)
                  : resource === "webhooks"
                    ? (value: unknown) => parseAdminList(value, parseAdminWebhook)
                    : resource === "domain-audit"
                      ? (value: unknown) => parseAdminList(value, parseAdminDomainAudit)
                      : resource === "audit"
                        ? (value: unknown) => parseAdminAuditResponse(value, false)
                        : null;
  if (!query || !parse || !resource) return null;
  return json(resource, query, parse);
}

function detail(resource: string, recordId: string): AdminProxyMatch | null {
  const parse =
    resource === "users"
      ? (value: unknown) => parseAdminDetail(value, parseAdminUser)
      : resource === "mandates"
        ? (value: unknown) => parseAdminDetail(value, parseAdminMandate)
        : resource === "proposals"
          ? (value: unknown) => parseAdminDetail(value, parseAdminProposal)
          : resource === "approvals"
            ? (value: unknown) => parseAdminDetail(value, parseAdminApproval)
            : resource === "orders"
              ? (value: unknown) => parseAdminDetail(value, parseAdminPayment)
              : resource === "payments"
                ? (value: unknown) => parseAdminDetail(value, parseAdminPayment)
                : resource === "refunds"
                  ? (value: unknown) => parseAdminDetail(value, parseAdminRefund)
                  : resource === "webhooks"
                    ? (value: unknown) => parseAdminDetail(value, parseAdminWebhook)
                    : resource === "domain-audit"
                      ? (value: unknown) => parseAdminDetail(value, parseAdminDomainAudit)
                      : null;
  if (!parse) return null;
  return {
    methods: GET,
    kind: "json",
    allowSearch: false,
    upstreamPath: `${resource}/${recordId}`,
    parseJson: parse,
  };
}

function nested(resource: string, recordId: string, child: string): AdminProxyMatch | null {
  if (resource === "users" && child === "sessions")
    return json(`users/${recordId}/sessions`, AdminUserSessionQuerySchema, (value) =>
      parseAdminList(value, parseAdminUserSession),
    );
  if (resource === "mandates" && child === "versions")
    return json(`mandates/${recordId}/versions`, AdminMandateVersionQuerySchema, (value) =>
      parseAdminList(value, parseAdminMandateVersion),
    );
  if (resource === "proposals" && child === "decisions")
    return json(`proposals/${recordId}/decisions`, AdminProposalDecisionQuerySchema, (value) =>
      parseAdminList(value, parseAdminPolicyDecision),
    );
  if (resource === "proposals" && child === "reservation")
    return {
      methods: GET,
      kind: "json",
      allowSearch: false,
      upstreamPath: `proposals/${recordId}/reservation`,
      parseJson: (value) => parseAdminNullableDetail(value, parseAdminReservation),
    };
  if (resource === "users" && child === "notes")
    return json(`users/${recordId}/notes`, AdminNoteQuerySchema, (value) =>
      parseAdminList(value, parseAdminNote),
    );
  return null;
}

function nestedMutation(resource: string, recordId: string, child: string): AdminProxyMatch | null {
  const mutation = (parseItem: (value: unknown) => unknown | null): AdminProxyMatch => ({
    methods: ["POST"],
    kind: "json",
    allowSearch: false,
    upstreamPath: `${resource}/${recordId}/${child}`,
    parseJson: (value) => parseAdminMutation(value, parseItem),
  });
  if (resource === "users") {
    if (["disable", "enable", "revoke-sessions", "disable-autonomy"].includes(child))
      return mutation(parseAdminUser);
    if (child === "notes") return mutation(parseAdminNote);
  }
  if (resource === "mandates" && (child === "pause" || child === "revoke"))
    return mutation(parseAdminMandate);
  if (resource === "proposals" && child === "re-evaluate") return mutation(parseAdminProposal);
  if (resource === "orders" && child === "reconcile") return mutation(parseAdminPayment);
  if (resource === "payments" && child === "reconcile") return mutation(parseAdminPayment);
  if (resource === "payments" && child === "refund") return mutation(parseAdminPayment);
  if (resource === "refunds" && child === "refresh") return mutation(parseAdminRefund);
  if (resource === "webhooks" && (child === "retry" || child === "reconcile"))
    return mutation(parseAdminWebhook);
  return null;
}

function nestedList(resource: string) {
  return [
    "users",
    "mandates",
    "proposals",
    "approvals",
    "orders",
    "payments",
    "refunds",
    "webhooks",
    "domain-audit",
    "audit",
  ].includes(resource);
}

function exportRoute(resource: string | undefined): AdminProxyMatch | null {
  if (!resource || !(resource in ADMIN_EXPORT_COLUMNS)) return null;
  const query =
    resource === "users"
      ? AdminUserQuerySchema
      : resource === "mandates"
        ? AdminMandateQuerySchema
        : resource === "proposals"
          ? AdminProposalQuerySchema
          : resource === "approvals"
            ? AdminApprovalQuerySchema
            : resource === "orders"
              ? AdminOrderQuerySchema
              : resource === "payments"
                ? AdminPaymentQuerySchema
                : resource === "refunds"
                  ? AdminRefundQuerySchema
                  : resource === "webhooks"
                    ? AdminWebhookQuerySchema
                    : resource === "audit"
                      ? AdminAuditQuerySchema
                      : null;
  if (!query) return null;
  return {
    methods: ["GET"],
    kind: "csv",
    query,
    allowSearch: true,
    upstreamPath: `${resource}/export`,
    csvResource: resource as AdminExportResource,
  };
}

function json(
  upstreamPath: string,
  query: { safeParse: (value: unknown) => { success: boolean } },
  parseJson: (value: unknown) => unknown | null,
): AdminProxyMatch {
  return { methods: GET, kind: "json", query, allowSearch: true, upstreamPath, parseJson };
}
