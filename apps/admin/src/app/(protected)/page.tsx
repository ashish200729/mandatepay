import { getAdminSession } from "@/lib/server-session";
import { redirect } from "next/navigation";
import { SessionControls } from "@/components/session-controls";
import { PageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { formatUtcDate } from "@/components/admin/timeline";
export default async function AdminHome() {
  const result = await getAdminSession();
  if (result.status !== "authenticated") redirect("/login?state=expired");
  return (
    <>
      <PageHeader
        title="Your admin session"
        description="Review your access, confirm your password for sensitive actions, or end this session."
        breadcrumbs={[{ label: "Administration" }, { label: "My Session" }]}
      />
      <section
        aria-label="Session security"
        className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      >
        <div className="rounded-2xl border bg-card p-6 sm:p-7">
          <div className="mb-6 flex items-center justify-between gap-4">
            <h2 className="text-lg font-medium">Account access</h2>
            <StatusBadge status="VERIFIED" label="Verified admin" />
          </div>
          <dl className="space-y-3 break-words text-sm">
            <div>
              <dt className="text-muted-foreground">Signed in as</dt>
              <dd className="mt-1 font-medium">{result.admin.user.email}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Role</dt>
              <dd className="mt-1">Main administrator</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Session security</dt>
              <dd className="mt-1">30-minute idle timeout · 10-minute password confirmation</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Session expires</dt>
              <dd className="mt-1">{formatUtcDate(result.admin.session.expiresAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Password confirmation valid until</dt>
              <dd className="mt-1">{formatUtcDate(result.admin.session.freshAuthUntil)}</dd>
            </div>
          </dl>
        </div>
        <div className="rounded-2xl border bg-card p-6 sm:p-7">
          <h2 className="text-lg font-medium">Session controls</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Password confirmation lasts ten minutes. Sensitive actions check it again before they
            run.
          </p>
          <SessionControls />
        </div>
      </section>
    </>
  );
}
