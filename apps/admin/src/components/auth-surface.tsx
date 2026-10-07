import Image from "next/image";
import { ShieldCheck } from "lucide-react";
import meadow from "../../../web/public/images/mandatepay-meadow.webp";
import { AdminWordmark } from "./admin/wordmark";
import type { AdminEnvironment } from "@/lib/environment";
import { StatusBadge } from "./admin/status-badge";

export function AuthSurface({
  title,
  description,
  children,
  environment = "unknown",
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  environment?: AdminEnvironment;
}) {
  const labels = {
    local: "Local",
    test: "Test",
    staging: "Staging",
    production: "Production",
    unknown: "Environment unknown",
  };
  return (
    <main
      id="main"
      className="flex min-h-dvh items-center justify-center bg-background p-5 sm:p-8 lg:p-10"
    >
      <div className="grid w-full max-w-[1120px] overflow-hidden rounded-2xl border bg-card lg:min-h-[680px] lg:grid-cols-[1fr_1fr]">
        <div className="relative hidden min-h-full flex-col justify-between overflow-hidden bg-secondary p-9 lg:flex xl:p-12">
          <Image
            src={meadow}
            alt=""
            fill
            priority
            sizes="(min-width: 1024px) 560px, 1px"
            className="object-cover object-[42%_center]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-linear-to-b from-background/95 via-background/70 to-background/15"
          />
          <div className="relative">
            <AdminWordmark />
          </div>
          <div className="relative mb-auto mt-20 max-w-sm">
            <p className="font-editorial text-4xl leading-[1.18] tracking-tight text-balance">
              AI proposes.
              <br />
              Policy authorizes.
              <br />
              You stay in control.
            </p>
            <p className="mt-5 max-w-xs text-sm leading-6 text-foreground/80">
              MandatePay administration
            </p>
          </div>
          <p className="relative mt-16 flex items-center gap-2 text-xs text-foreground">
            <ShieldCheck size={16} aria-hidden="true" />
            Restricted access · Activity is audited
          </p>
        </div>
        <section className="flex min-w-0 flex-col justify-center px-6 py-9 sm:px-10 sm:py-12 xl:px-14">
          <div className="mb-10 flex flex-wrap items-center justify-between gap-4">
            <span className="lg:hidden">
              <AdminWordmark />
            </span>
            <span className="hidden text-sm font-medium lg:block">Administration</span>
            <StatusBadge
              status={environment}
              label={labels[environment]}
              tone={environment === "production" ? "danger" : "neutral"}
            />
          </div>
          <h1 className="font-editorial text-3xl leading-tight tracking-tight text-balance sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
          <div className="mt-8">{children}</div>
          <p className="mt-9 border-t pt-5 text-xs leading-5 text-muted-foreground">
            MandatePay Admin · PayPal Sandbox
          </p>
        </section>
      </div>
    </main>
  );
}
