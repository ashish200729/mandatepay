import { AdminLink as Link } from "./link";
import { AdminResourceIdSchema } from "@mandatepay/shared";
export function EntityLink({
  resource,
  id,
  label,
}: {
  resource:
    | "users"
    | "mandates"
    | "proposals"
    | "approvals"
    | "orders"
    | "payments"
    | "refunds"
    | "webhooks"
    | "audit";
  id: string;
  label?: string;
}) {
  if (!AdminResourceIdSchema.safeParse(id).success) return <span>Record unavailable</span>;
  return (
    <Link
      href={`/${resource}/${encodeURIComponent(id)}`}
      className="inline-flex min-h-11 max-w-full items-center rounded font-medium underline decoration-border underline-offset-4 hover:decoration-foreground [overflow-wrap:anywhere]"
    >
      {label ?? id}
    </Link>
  );
}
