import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronDown, Headphones } from "lucide-react";
import { cn } from "@mandatepay/ui/lib/utils";
import { Brand } from "@/components/brand";
import { SiteHeader } from "@/components/site-header";
import { MandatePreview } from "@/components/mandate-preview";
import { SectionHeading } from "@/components/section-heading";

const outcomes = [
  {
    amount: "$139",
    title: "A little freedom.",
    detail: "Below your automatic limit. The agent has permission to proceed.",
    decision: "Allowed by your rules",
    rule: "Automatic limit",
    limit: "$150",
    result: "Within your permission",
  },
  {
    amount: "$169",
    title: "A moment to decide.",
    detail: "Within your budget, but above the automatic limit. The decision comes back to you.",
    decision: "Your approval required",
    rule: "Maximum budget",
    limit: "$180",
    result: "Waiting for your approval",
  },
  {
    amount: "$220",
    title: "A boundary that holds.",
    detail: "Above your maximum budget. The proposal stops before money can move.",
    decision: "Blocked by your rules",
    rule: "Maximum budget",
    limit: "$180",
    result: "Outside your permission",
  },
];

const stages = [
  {
    title: "Tell it what you need.",
    description:
      "Describe the purchase in your own words. Set the brands, budget, and conditions that matter to you.",
  },
  {
    title: "Give it clear boundaries.",
    description:
      "AgentGuard is designed to check each proposal against your mandate. Allow, ask, or block. Every time.",
  },
  {
    title: "Keep the final say.",
    description:
      "PayPal handles the payment after authorization, with customer approval where required.",
  },
];

const questions = [
  {
    question: "What is a purchase mandate?",
    answer:
      "A purchase mandate is the permission you give an AI agent: what it may buy, how much it may spend, and when it must ask you. Your original request becomes a clear set of purchasing rules.",
  },
  {
    question: "Can an AI override my spending rules?",
    answer:
      "The intended architecture keeps recommendation and authorization separate. AI proposes a purchase; AgentGuard evaluates explicit rules. A recommendation cannot override a hard spending limit.",
  },
  {
    question: "Can I make a purchase here today?",
    answer:
      "This is the MandatePay design foundation. The examples illustrate the intended experience; AI, policy enforcement, product discovery, and PayPal payments are not connected yet.",
  },
];

export default function HomePage() {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-foreground px-4 py-3 text-background focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <section
          aria-labelledby="hero-heading"
          className="relative mx-4 mt-3 flex min-h-[640px] max-w-[1408px] flex-col justify-between overflow-hidden rounded-2xl bg-secondary px-5 pb-6 pt-10 text-center sm:mx-5 sm:mt-4 sm:min-h-[680px] sm:px-8 sm:pb-8 sm:pt-14 lg:h-[calc(100dvh-5.5rem)] lg:min-h-[700px] lg:max-h-[820px] xl:rounded-[24px] min-[1450px]:mx-auto"
        >
          <Image
            src="/images/mandatepay-meadow.webp"
            alt=""
            fill
            sizes="(max-width: 1440px) 100vw, 1408px"
            priority
            className="object-cover object-[center_60%]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-linear-to-b from-background/90 via-background/45 to-background/5"
          />
          <div className="relative flex flex-col items-center">
            <h1
              id="hero-heading"
              className="max-w-[860px] font-editorial text-[clamp(2.35rem,4.4vw,3.75rem)] leading-[1.1] font-normal tracking-[-0.03em] text-balance text-foreground"
            >
              A smarter way to shop.
              <br className="hidden sm:block" /> On your terms.
            </h1>
            <p className="mt-3.5 max-w-[460px] text-sm leading-[1.65] text-foreground/80 sm:text-base">
              Let your AI find the right purchase.
              <br className="hidden sm:block" /> You decide what it has permission to spend.
            </p>
            <div className="mt-5 flex w-full max-w-[420px] flex-col justify-center gap-3 sm:max-w-none sm:flex-row">
              <Link
                href="/chat"
                className="group inline-flex h-11 items-center justify-center gap-2 rounded-full bg-foreground px-5 text-sm font-medium tracking-tight text-background shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_2px_8px_rgba(27,20,14,0.1)] transition-all duration-200 ease-out hover:bg-foreground/90 active:scale-[0.985] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span>Explore MandatePay</span>
                <ArrowUpRight
                  size={15}
                  aria-hidden="true"
                  className="opacity-80 transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
                />
              </Link>
              <a
                href="#agentguard"
                className="group inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border/80 bg-background/80 px-5 text-sm font-medium tracking-tight text-foreground shadow-2xs backdrop-blur-xs transition-all duration-200 ease-out hover:border-foreground/30 hover:bg-background active:scale-[0.985] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span>Meet AgentGuard</span>
                <ArrowRight
                  size={14}
                  aria-hidden="true"
                  className="opacity-70 transition-transform duration-200 ease-out group-hover:translate-x-1 group-hover:opacity-100"
                />
              </a>
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-[620px] pt-6 sm:pt-8">
            <div className="rounded-2xl border border-white/80 bg-card/95 p-5 text-left shadow-[0_10px_32px_rgba(27,20,14,0.06)] backdrop-blur-md sm:p-6 dark:border-border/80">
              <p className="font-editorial text-[17px] sm:text-[19px] leading-[1.5] text-foreground tracking-[-0.015em]">
                “Find Sony or Bose headphones under $180.
                <br className="hidden sm:block" /> Automatically buy up to $150. Ask me above that.”
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs">
                <span className="rounded-md border border-border/50 bg-secondary/70 px-2.5 py-1 font-medium text-foreground/85">
                  Sony or Bose
                </span>
                <span className="rounded-md border border-border/50 bg-secondary/70 px-2.5 py-1 font-medium text-foreground/85">
                  New only
                </span>
                <span className="rounded-md border border-border/50 bg-secondary/70 px-2.5 py-1 font-medium text-foreground/85">
                  Budget enforced by rules
                </span>
              </div>
            </div>
            <p className="mx-auto mt-3 w-fit rounded-full border border-border/40 bg-background/85 px-3 py-0.5 text-[11px] text-muted-foreground backdrop-blur-xs">
              An illustrative mandate. No purchase is being made.
            </p>
          </div>
        </section>

        <section
          id="how-it-works"
          aria-labelledby="outcomes-heading"
          className="mx-auto max-w-[1328px] px-5 pb-20 pt-12 sm:px-8 sm:pb-28 sm:pt-16 lg:px-12"
        >
          <div className="mx-auto max-w-[660px] text-center">
            <SectionHeading id="outcomes-heading">
              One mandate. Three clear outcomes.
            </SectionHeading>
            <p className="mx-auto mt-5 max-w-[540px] text-base leading-[1.7] text-muted-foreground sm:text-lg">
              Set the rules once. Every proposal has a clear next step.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3 lg:mt-14 lg:gap-6">
            {outcomes.map((outcome, idx) => {
              const isHighlight = idx === 1;

              return (
                <article
                  key={outcome.amount}
                  className={cn(
                    "group flex flex-col rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1 lg:p-7",
                    isHighlight
                      ? "border border-sand-border bg-linear-to-b from-[#FAF2DE] via-sand to-[#F1E4C4] shadow-[0_6px_28px_rgba(27,20,14,0.05),inset_0_1px_0_rgba(255,255,255,0.6)] hover:shadow-[0_14px_40px_rgba(27,20,14,0.08)]"
                      : "border border-border/80 bg-card shadow-[0_2px_16px_rgba(27,20,14,0.03)] hover:shadow-[0_12px_36px_rgba(27,20,14,0.06)]",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-medium shadow-2xs",
                      isHighlight
                        ? "bg-foreground text-background"
                        : "border border-border/80 bg-secondary/80 text-foreground",
                    )}
                  >
                    {outcome.decision}
                  </span>
                  <h3 className="mt-6 font-editorial text-[27px] leading-[1.2] tracking-[-0.025em] text-foreground">
                    {outcome.title}
                  </h3>
                  <p className="mb-6 mt-3 text-sm leading-[1.75] text-muted-foreground">
                    {outcome.detail}
                  </p>
                  <div
                    className={cn(
                      "mt-auto rounded-xl border p-5 transition-colors",
                      isHighlight
                        ? "border-border/60 bg-card/95 shadow-[0_2px_12px_rgba(27,20,14,0.04)] backdrop-blur-xs"
                        : "border-border/60 bg-secondary/50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex size-10 items-center justify-center rounded-lg border border-border/40 bg-secondary text-foreground">
                        <Headphones size={20} strokeWidth={1.5} aria-hidden="true" />
                      </span>
                      <span className="text-[28px] font-semibold tracking-tight text-foreground tabular-nums">
                        {outcome.amount}
                      </span>
                    </div>
                    <p className="mt-4 text-sm font-semibold tracking-tight text-foreground">
                      Sony headphones
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">New · Noise-cancelling</p>
                    <dl className="my-3.5 border-y border-border/60 py-2.5">
                      <div className="flex justify-between gap-2 text-xs">
                        <dt className="text-muted-foreground">{outcome.rule}</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                          {outcome.limit}
                        </dd>
                      </div>
                    </dl>
                    <p className="text-xs font-medium text-foreground/80">{outcome.result}</p>
                  </div>
                </article>
              );
            })}
          </div>
          <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">
            Illustrative proposals · Maximum budget $180 · Automatic limit $150 · Prices in USD
          </p>
        </section>

        <section
          id="agentguard"
          aria-labelledby="journey-heading"
          className="border-y border-border/70 bg-secondary/50"
        >
          <div className="mx-auto max-w-[1328px] px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
            <div className="mx-auto max-w-[670px] text-center">
              <SectionHeading id="journey-heading">
                From a little request
                <br className="hidden sm:block" /> to a clear permission.
              </SectionHeading>
              <p className="mt-5 text-base leading-[1.7] text-muted-foreground sm:text-lg">
                AI understands what you want. AgentGuard checks what you allow.
              </p>
            </div>
            <div className="mt-14 grid items-center gap-12 lg:grid-cols-[1fr_0.9fr] lg:gap-24">
              <MandatePreview />
              <ol className="space-y-8">
                {stages.map((stage, index) => (
                  <li key={stage.title} className="flex gap-4">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card font-mono text-[11px] font-medium text-foreground shadow-2xs">
                      0{index + 1}
                    </span>
                    <div>
                      <h3 className="font-editorial text-2xl leading-tight tracking-[-0.02em] text-foreground sm:text-[28px]">
                        {stage.title}
                      </h3>
                      <p className="mt-2.5 max-w-[360px] text-sm leading-[1.8] text-muted-foreground">
                        {stage.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section
          id="your-control"
          aria-labelledby="control-heading"
          className="mx-auto grid max-w-[1328px] gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[1fr_0.9fr] lg:gap-24 lg:px-12"
        >
          <div>
            <SectionHeading id="control-heading">
              A little delegation.
              <br />A lot of control.
            </SectionHeading>
            <p className="mt-6 max-w-[370px] text-base leading-[1.8] text-muted-foreground">
              A good assistant knows your preferences. A trusted one knows its boundaries.
            </p>
            <a
              href="#questions"
              className="group mt-7 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-foreground no-underline transition-colors hover:text-muted-foreground motion-reduce:transition-none"
            >
              <span>A few things worth knowing</span>
              <ArrowRight
                size={15}
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:translate-x-1"
              />
            </a>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_4px_24px_rgba(27,20,14,0.03)]">
            <div className="grid divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              {[
                {
                  index: "01",
                  title: "Your purchases, your preferences.",
                  text: "Choose brands, conditions, and the things that matter.",
                },
                {
                  index: "02",
                  title: "A budget with a hard boundary.",
                  text: "Set automatic spending limits and a maximum amount.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="flex flex-col justify-between p-6 transition-colors duration-200 hover:bg-secondary/40 sm:p-7"
                >
                  <span className="font-mono text-[11px] font-medium tracking-widest text-muted-foreground/60 uppercase">
                    {item.index}
                  </span>
                  <div className="mt-6">
                    <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
                      {item.title}
                    </h3>
                    <p className="mt-2 text-sm leading-[1.7] text-muted-foreground">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-border/60">
              <div className="grid divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                {[
                  {
                    index: "03",
                    title: "An approval when it matters.",
                    text: "Decide exactly when the agent should come back to you.",
                  },
                  {
                    index: "04",
                    title: "Permission you can take back.",
                    text: "Mandates are designed to be paused or disabled by you.",
                  },
                ].map((item) => (
                  <div
                    key={item.title}
                    className="flex flex-col justify-between p-6 transition-colors duration-200 hover:bg-secondary/40 sm:p-7"
                  >
                    <span className="font-mono text-[11px] font-medium tracking-widest text-muted-foreground/60 uppercase">
                      {item.index}
                    </span>
                    <div className="mt-6">
                      <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
                        {item.title}
                      </h3>
                      <p className="mt-2 text-sm leading-[1.7] text-muted-foreground">
                        {item.text}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section
          id="questions"
          aria-labelledby="questions-heading"
          className="mx-auto max-w-[880px] px-5 pb-24 sm:px-8 sm:pb-32"
        >
          <div className="mb-12 text-center sm:mb-16">
            <SectionHeading id="questions-heading">A few things worth knowing.</SectionHeading>
          </div>
          <div className="border-y border-border/80 divide-y divide-border/60">
            {questions.map((item) => (
              <details key={item.question} className="group transition-colors duration-200">
                <summary className="flex min-h-[4.75rem] cursor-pointer list-none items-center justify-between gap-6 py-5 text-left transition-colors duration-150 hover:text-foreground/80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <span className="font-editorial text-[20px] sm:text-[23px] font-normal leading-[1.3] tracking-[-0.015em] text-foreground">
                    {item.question}
                  </span>
                  <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground/60 transition-transform duration-300 group-open:rotate-180 group-hover:text-foreground">
                    <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                </summary>
                <div className="pb-7 pr-8 sm:pr-12">
                  <p className="text-[15px] sm:text-base leading-[1.8] text-muted-foreground">
                    {item.answer}
                  </p>
                </div>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="relative mx-4 mb-4 max-w-[1408px] overflow-hidden rounded-[24px] border border-border/80 bg-secondary shadow-[0_4px_24px_rgba(27,20,14,0.03)] sm:mx-5 sm:mb-5 min-[1450px]:mx-auto">
        <Image
          src="/images/mandatepay-footer.webp"
          alt=""
          fill
          sizes="(max-width: 1440px) 100vw, 1408px"
          className="pointer-events-none object-cover object-[center_55%]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-b from-background/80 via-background/25 to-background/90"
        />
        <section
          aria-labelledby="closing-heading"
          className="relative px-5 py-16 text-center sm:px-8 sm:py-20"
        >
          <SectionHeading id="closing-heading">
            Give it a mandate.
            <br className="sm:hidden" /> Keep the control.
          </SectionHeading>
          <p className="mt-5 text-base text-foreground/80">AI commerce, with your permission.</p>
          <Link
            href="/mandates/new"
            className="group mt-8 inline-flex h-12 items-center justify-center gap-2.5 rounded-full border border-foreground/10 bg-foreground px-6 text-[15px] font-medium tracking-tight text-background shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_2px_8px_rgba(27,20,14,0.1)] transition-all duration-200 ease-out hover:bg-foreground/90 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_6px_20px_rgba(27,20,14,0.16)] active:scale-[0.985] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
          >
            <span>Create your first mandate</span>
            <ArrowUpRight
              size={16}
              aria-hidden="true"
              className="opacity-80 transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
            />
          </Link>
        </section>
        <div className="relative mx-auto max-w-[1328px] border-t border-foreground/10 px-5 pb-8 pt-10 sm:px-8 lg:px-12">
          <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-start">
            <div>
              <Brand />
              <p className="mt-4 max-w-[250px] text-sm leading-relaxed text-foreground/75">
                AI proposes. Policy authorizes.
                <br />
                You stay in control.
              </p>
            </div>
            <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-7 gap-y-3 text-sm">
              <a
                href="#how-it-works"
                className="inline-flex min-h-11 items-center no-underline transition-colors hover:text-foreground motion-reduce:transition-none"
              >
                How it works
              </a>
              <a
                href="#agentguard"
                className="inline-flex min-h-11 items-center no-underline transition-colors hover:text-foreground motion-reduce:transition-none"
              >
                AgentGuard
              </a>
              <a
                href="#your-control"
                className="inline-flex min-h-11 items-center no-underline transition-colors hover:text-foreground motion-reduce:transition-none"
              >
                Your control
              </a>
            </nav>
          </div>
          <div className="mt-10 flex flex-col justify-between gap-3 border-t border-foreground/10 pt-6 text-xs leading-relaxed text-foreground/75 sm:flex-row">
            <span>© 2026 MandatePay</span>
            <span>
              Product concept · Illustrative examples · No live AI or payment integrations
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
