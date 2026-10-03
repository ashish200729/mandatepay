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
    <main className="min-h-screen bg-background px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto grid min-h-[calc(100vh-2rem)] max-w-[1380px] overflow-hidden rounded-[28px] border border-border bg-card shadow-[0_20px_80px_rgba(27,20,14,0.07)] sm:min-h-[calc(100vh-3rem)] lg:grid-cols-[0.92fr_1.08fr]">
        <div className="relative hidden min-h-[720px] overflow-hidden bg-secondary lg:block">
          <Image
            src="/images/mandatepay-meadow.webp"
            alt=""
            fill
            sizes="(max-width: 1024px) 0px, 45vw"
            className="object-cover object-[center_70%]"
          />
          <div className="absolute inset-0 bg-linear-to-t from-[#1b140e]/80 via-[#1b140e]/10 to-background/15" />
          <div className="relative flex h-full flex-col justify-between p-10 xl:p-12">
            <Brand className="text-background [&>span:last-child]:text-background" />
            <div className="max-w-[420px] text-background">
              <p className="font-editorial text-[clamp(2.5rem,4vw,4.5rem)] leading-[1.02] tracking-[-0.035em]">
                Permission is the new checkout.
              </p>
              <p className="mt-5 max-w-[330px] text-sm leading-[1.8] text-background/75">
                Give an agent a clear mandate. Keep the final say when it matters.
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col px-6 py-8 sm:px-12 sm:py-12 lg:px-16 lg:py-14 xl:px-24">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="m-auto w-full max-w-[420px] py-10 lg:py-16">
            <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
            <h1 className="mt-4 font-editorial text-[clamp(2.7rem,6vw,4.6rem)] leading-[1.02] tracking-[-0.035em]">
              {heading}
            </h1>
            <p className="mt-5 max-w-[360px] text-sm leading-[1.8] text-muted-foreground">
              {description}
            </p>
            <div className="mt-9">{children}</div>
          </div>
          <p className="mt-auto text-xs leading-relaxed text-muted-foreground">
            MandatePay is a permission layer for agentic commerce. Your payment credentials stay
            with the payment provider.
          </p>
        </div>
      </div>
    </main>
  );
}
