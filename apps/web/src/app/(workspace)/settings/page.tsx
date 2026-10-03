import { Settings2, UserRound } from "lucide-react";
import { AuthAutonomyToggle } from "@/components/auth-autonomy-toggle";
import { EmptyWorkspaceState, WorkspacePage } from "../_components/workspace-page";
import { getServerSession } from "@/lib/auth/server-api";

export default async function SettingsPage() {
  const principal = await getServerSession();

  return (
    <WorkspacePage
      title="Settings"
      description="Keep your account and purchasing controls easy to understand. Sensitive payment details stay with PayPal."
      icon={Settings2}
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-sand">
              <UserRound size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-editorial text-2xl tracking-[-0.02em]">Account</h2>
              <p className="text-xs text-muted-foreground">Your signed-in profile</p>
            </div>
          </div>
          <dl className="mt-8 divide-y divide-border border-y border-border text-sm">
            <div className="flex justify-between gap-4 py-4">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="text-right font-medium">{principal?.name ?? "Unavailable"}</dd>
            </div>
            <div className="flex justify-between gap-4 py-4">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="max-w-[65%] truncate text-right font-medium">
                {principal?.email ?? "Unavailable"}
              </dd>
            </div>
          </dl>
        </section>
        <AuthAutonomyToggle initialEnabled={principal?.autonomousPurchasingEnabled ?? false} />
        <EmptyWorkspaceState
          icon={Settings2}
          title="More controls will follow the same boundary."
          description="Global pause, payment connection, and mandate settings will become live controls as their server-backed phases are implemented."
          detail="This setting changes only the user permission recorded by the server. It never bypasses a hard policy block or PayPal approval requirement."
        />
      </div>
    </WorkspacePage>
  );
}
