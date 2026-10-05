import { Badge } from "@mandatepay/ui/components/badge";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";
const tones: Record<StatusTone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  success: "bg-admin-success text-admin-success-foreground",
  warning: "bg-admin-warning text-admin-warning-foreground",
  danger: "bg-admin-danger text-admin-danger-foreground",
  info: "bg-admin-info text-admin-info-foreground",
};
export function statusTone(status: string): StatusTone {
  if (["SUCCESS", "ACTIVE", "COMPLETED", "PROCESSED", "ready", "VERIFIED"].includes(status))
    return "success";
  if (["FAILURE", "FAILED", "DENIED", "BLOCKED", "unavailable", "REVOKED"].includes(status))
    return "danger";
  if (
    [
      "PENDING",
      "PROCESSING",
      "CAPTURE_PENDING",
      "AWAITING_APPROVAL",
      "degraded",
      "PAUSED",
    ].includes(status)
  )
    return "warning";
  return "neutral";
}
export function StatusBadge({
  status,
  label,
  tone,
}: {
  status: string;
  label?: string;
  tone?: StatusTone;
}) {
  return (
    <Badge
      variant="outline"
      className={`${tones[tone ?? statusTone(status)]} border-transparent px-2.5 py-1 text-xs`}
    >
      {label ?? status.toLowerCase().replaceAll("_", " ")}
    </Badge>
  );
}
export function HealthIndicator({
  status,
}: {
  status: "ready" | "degraded" | "unavailable" | "unknown";
}) {
  return <StatusBadge status={status} label={`Health: ${status}`} />;
}
