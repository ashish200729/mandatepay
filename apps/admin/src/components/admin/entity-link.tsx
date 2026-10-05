import Link from "next/link";
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
      className="inline-flex min-h-11 items-center rounded underline underline-offset-4"
    >
      {label ?? id}
    </Link>
  );
}
