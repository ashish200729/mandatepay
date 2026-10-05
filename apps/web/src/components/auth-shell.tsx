import Image from "next/image";
import { Brand } from "@/components/brand";

export function AuthShell({
  eyebrow,
  heading,
  description,
  children,
}: {
  eyebrow: string;
  heading: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background p-3 sm:p-5 lg:h-screen lg:max-h-screen lg:overflow-hidden lg:p-6 flex flex-col justify-center">
      <div className="mx-auto grid h-full max-h-[820px] w-full max-w-[1340px] overflow-hidden rounded-[24px] border border-border/80 bg-card shadow-[0_16px_60px_rgba(27,20,14,0.06)] lg:grid-cols-[0.95fr_1.05fr]">
        <div className="relative hidden h-full overflow-hidden bg-secondary lg:block">
          <Image
            src="/images/mandatepay-meadow.webp"
            alt=""
            fill
            sizes="(max-width: 1024px) 0px, 45vw"
            className="object-cover object-[center_70%]"
          />
          <div className="absolute inset-0 bg-linear-to-t from-[#1b140e]/80 via-[#1b140e]/15 to-background/15" />
          <div className="relative flex h-full flex-col justify-between p-8 xl:p-10">
            <Brand className="text-background [&>span:last-child]:text-background" />
            <div className="max-w-[420px] text-background">
              <p className="font-editorial text-[clamp(2.2rem,3.4vw,3.4rem)] leading-[1.12] tracking-[-0.03em]">
                Permission is the new checkout.
              </p>
              <p className="mt-3.5 max-w-[330px] text-sm leading-[1.7] text-background/80">
                Give an agent a clear mandate. Keep the final say when it matters.
              </p>
            </div>
          </div>
        </div>
        <div className="flex h-full flex-col justify-between overflow-y-auto px-6 py-6 sm:px-10 sm:py-8 lg:px-12 lg:py-8 xl:px-16">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="my-auto w-full max-w-[400px] py-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </p>
            <h1 className="mt-2.5 font-editorial text-[clamp(2.1rem,3.2vw,2.75rem)] leading-[1.15] tracking-[-0.025em] text-foreground">
              {heading}
            </h1>
            <p className="mt-3 max-w-[360px] text-xs leading-[1.7] text-muted-foreground sm:text-sm">
              {description}
            </p>
            <div className="mt-6">{children}</div>
          </div>
          <p className="mt-auto pt-3 text-[11px] leading-relaxed text-muted-foreground/75">
            MandatePay is a permission layer for agentic commerce. Your payment credentials stay
            with the payment provider.
          </p>
        </div>
      </div>
    </main>
  );
}
