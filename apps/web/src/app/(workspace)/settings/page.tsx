import Link from "next/link";
import { ArrowRight, Settings2, UserRound } from "lucide-react";
import { AuthAutonomyToggle } from "@/components/auth-autonomy-toggle";
import { WorkspacePage } from "../_components/workspace-page";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { getServerSession } from "@/lib/auth/server-api";

export default async function SettingsPage() {
  const principal = await getServerSession();

  return (
    <WorkspacePage
      title="Settings"
      description="Keep your account and purchasing controls easy to understand. Sensitive payment details stay with PayPal."
      icon={Settings2}
    >
      <div className="grid items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-sand">
              <UserRound size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-medium">Account</h2>
              <p className="text-xs text-muted-foreground">Your signed-in profile</p>
            </div>
          </div>
          <dl className="mt-8 divide-y divide-border border-y border-border text-sm">
            <div className="flex justify-between gap-4 py-4">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="min-w-0 break-words text-right font-medium">
                {principal?.name ?? "Unavailable"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-4">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="max-w-[70%] break-all text-right font-medium">
                {principal?.email ?? "Unavailable"}
              </dd>
            </div>
          </dl>
        </section>
        <div className="min-w-0 space-y-6">
          <AuthAutonomyToggle initialEnabled={principal?.autonomousPurchasingEnabled ?? false} />
          <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
            <h2 className="text-lg font-medium">Payment environment</h2>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="rounded-md bg-sand px-3 py-1.5 text-xs font-medium">
                PayPal Sandbox
              </span>
              <Link href="/orders" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                View orders
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              Checkout uses PayPal Sandbox. A permitted proposal may still need your approval in
              PayPal before payment can complete.
            </p>
          </section>
          <section className="border-t border-border pt-5">
            <h2 className="text-sm font-medium">Your rules always apply</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Mandates control budgets, products, merchants, and expiry. Turning on automatic
              permissions keeps those boundaries in place.
            </p>
            <Link
              href="/mandates"
              className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
            >
              Manage purchase mandates
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </section>
        </div>
      </div>
    </WorkspacePage>
  );
}
