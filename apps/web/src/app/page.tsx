import Image from "next/image";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Headphones,
  ShieldCheck,
  X,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
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
    icon: Check,
    rule: "Automatic limit",
    limit: "$150",
    result: "Within your permission",
  },
  {
    amount: "$169",
    title: "A moment to decide.",
    detail: "Within your budget, but above the automatic limit. The decision comes back to you.",
    decision: "Your approval required",
    icon: CircleHelp,
    rule: "Maximum budget",
    limit: "$180",
    result: "Waiting for your approval",
  },
  {
    amount: "$220",
    title: "A boundary that holds.",
    detail: "Above your maximum budget. The proposal stops before money can move.",
    decision: "Blocked by your rules",
    icon: X,
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
          className="relative mx-4 mt-4 max-w-[1408px] overflow-hidden rounded-2xl bg-secondary sm:mx-5 sm:mt-5 lg:min-h-[720px] xl:rounded-[24px] min-[1450px]:mx-auto"
        >
          <Image
            src="/images/mandatepay-meadow.webp"
            alt=""
            fill
            sizes="(max-width: 1440px) 100vw, 1408px"
            preload
            className="object-cover object-[center_65%]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-linear-to-b from-background/90 via-background/70 to-background/5"
          />
          <div className="relative flex min-h-[710px] flex-col items-center px-5 pb-8 pt-16 text-center sm:min-h-[760px] sm:px-8 sm:pt-20 lg:min-h-[760px] lg:pt-20">
            <h1
              id="hero-heading"
              className="max-w-[940px] font-editorial text-[clamp(2.7rem,5.5vw,5rem)] leading-[1.08] font-normal tracking-[-0.035em] text-balance"
            >
              A smarter way to shop.
              <br className="hidden sm:block" /> On your terms.
            </h1>
            <p className="mt-6 max-w-[470px] text-base leading-[1.7] sm:text-lg">
              Let your AI find the right purchase.
              <br className="hidden sm:block" /> You decide what it has permission to spend.
            </p>
            <div className="mt-7 flex w-full max-w-[440px] flex-col justify-center gap-3 sm:max-w-none sm:flex-row">
              <Link
                href="/chat"
                className={buttonVariants({ size: "lg", className: "rounded-xl" })}
              >
                Explore MandatePay <ArrowUpRight aria-hidden="true" />
              </Link>
              <a
                href="#agentguard"
                className={cn(
                  buttonVariants({ size: "lg", variant: "outline" }),
                  "rounded-xl border-transparent hover:border-primary/20",
                )}
              >
                Meet AgentGuard <ArrowRight aria-hidden="true" />
              </a>
            </div>
            <div className="mt-auto w-full max-w-[700px] pt-16 sm:pt-24">
              <div className="rounded-2xl bg-card p-5 text-left shadow-[0_8px_32px_rgba(27,20,14,0.08)] sm:p-6">
                <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck size={15} aria-hidden="true" /> A purchase mandate, in your words
                </div>
                <div className="flex items-center gap-4">
                  <p className="flex-1 text-sm leading-[1.6] sm:text-base">
                    “Find Sony or Bose headphones under $180.
                    <br className="hidden sm:block" /> Automatically buy up to $150. Ask me above
                    that.”
                  </p>
                  <a
                    href="#agentguard"
                    aria-label="Explore this example mandate"
                    className={buttonVariants({ size: "icon" })}
                  >
                    <ArrowDown size={19} aria-hidden="true" />
                  </a>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Check size={12} aria-hidden="true" /> Sony or Bose
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Check size={12} aria-hidden="true" /> New only
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Check size={12} aria-hidden="true" /> Your budget, enforced by rules
                  </span>
                </div>
              </div>
              <p className="mx-auto mt-4 w-fit rounded-md bg-background/95 px-3 py-1.5 text-xs text-foreground">
                An illustrative mandate. No purchase is being made.
              </p>
            </div>
          </div>
        </section>

        <div className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-5 px-6 py-10 sm:flex-row sm:gap-8 sm:py-12">
          <p className="text-sm text-muted-foreground">A simple idea. Clear responsibilities.</p>
          <div className="flex flex-wrap items-center justify-center gap-4 text-sm font-medium sm:gap-6">
            <span>AI proposes</span>
            <ArrowRight size={14} className="text-muted-foreground" aria-hidden="true" />
            <span>AgentGuard authorizes</span>
            <ArrowRight size={14} className="text-muted-foreground" aria-hidden="true" />
            <span>PayPal executes</span>
          </div>
        </div>

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
            {outcomes.map((outcome) => (
              <article
                key={outcome.amount}
                className="flex flex-col rounded-2xl border border-sand-border bg-sand p-6 lg:p-7"
              >
                <span className="w-fit rounded-md bg-background px-3 py-1.5 text-xs font-medium">
                  {outcome.decision}
                </span>
                <h3 className="mt-7 font-editorial text-[29px] leading-[1.2] tracking-[-0.025em]">
                  {outcome.title}
                </h3>
                <p className="mb-7 mt-4 text-sm leading-[1.75] text-muted-foreground">
                  {outcome.detail}
                </p>
                <div className="mt-auto rounded-xl bg-card p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-secondary">
                      <Headphones size={22} strokeWidth={1.5} aria-hidden="true" />
                    </span>
                    <span className="text-[30px] font-medium tracking-[-0.025em] tabular-nums">
                      {outcome.amount}
                    </span>
                  </div>
                  <p className="mt-4 text-sm font-medium">Sony headphones</p>
                  <p className="mt-1 text-xs text-muted-foreground">New · Noise-cancelling</p>
                  <dl className="my-4 border-y border-border py-3">
                    <div className="flex justify-between gap-2 text-xs">
                      <dt className="text-muted-foreground">{outcome.rule}</dt>
                      <dd className="font-medium tabular-nums">{outcome.limit}</dd>
                    </div>
                  </dl>
                  <p className="flex items-center gap-2 text-xs font-medium">
                    <outcome.icon size={15} aria-hidden="true" />
                    {outcome.result}
                  </p>
                </div>
              </article>
            ))}
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
              <ol className="space-y-9">
                {stages.map((stage, index) => (
                  <li key={stage.title} className="flex gap-5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-sm tabular-nums">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="font-editorial text-2xl leading-tight tracking-[-0.02em] sm:text-[28px]">
                        {stage.title}
                      </h3>
                      <p className="mt-3 max-w-[350px] text-sm leading-[1.85] text-muted-foreground">
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
              className="mt-7 inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 transition-colors hover:text-muted-foreground hover:underline motion-reduce:transition-none"
            >
              A few things worth knowing <ArrowRight size={15} aria-hidden="true" />
            </a>
          </div>
          <dl className="divide-y divide-border border-y border-border">
            {[
              {
                title: "Your purchases, your preferences.",
                text: "Choose brands, conditions, and the things that matter.",
              },
              {
                title: "A budget with a hard boundary.",
                text: "Set automatic spending limits and a maximum amount.",
              },
              {
                title: "An approval when it matters.",
                text: "Decide exactly when the agent should come back to you.",
              },
              {
                title: "Permission you can take back.",
                text: "Mandates are designed to be paused or disabled by you.",
              },
            ].map((item) => (
              <div key={item.title} className="py-5">
                <dt className="flex items-center gap-3 text-base font-medium">
                  <Check size={16} strokeWidth={1.6} aria-hidden="true" />
                  {item.title}
                </dt>
                <dd className="mt-2 pl-7 text-sm leading-relaxed text-muted-foreground">
                  {item.text}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          id="questions"
          aria-labelledby="questions-heading"
          className="mx-auto max-w-[900px] px-5 pb-24 sm:px-8 sm:pb-28"
        >
          <SectionHeading id="questions-heading" className="mb-10 text-center">
            A few things worth knowing.
          </SectionHeading>
          <div className="divide-y divide-border border-y border-border">
            {questions.map((item) => (
              <details key={item.question} className="group py-1">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-5 rounded-md py-5 text-base font-medium transition-colors hover:text-muted-foreground motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <ChevronDown
                    size={18}
                    className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </summary>
                <p className="max-w-[680px] pb-6 pr-6 text-sm leading-[1.9] text-muted-foreground">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="relative mx-4 mb-4 max-w-[1408px] overflow-hidden rounded-[24px] bg-secondary sm:mx-5 sm:mb-5 min-[1450px]:mx-auto">
        <Image
          src="/images/mandatepay-meadow.webp"
          alt=""
          fill
          sizes="(max-width: 1440px) 100vw, 1408px"
          className="pointer-events-none object-cover object-[center_75%]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-b from-background/95 via-background/85 to-background/75"
        />
        <section
          aria-labelledby="closing-heading"
          className="relative px-5 py-16 text-center sm:px-8 sm:py-20"
        >
          <SectionHeading id="closing-heading">
            Give it a mandate.
            <br className="sm:hidden" /> Keep the control.
          </SectionHeading>
          <p className="mt-5 text-base text-foreground/75">AI commerce, with your permission.</p>
          <Link href="/mandates/new" className={cn(buttonVariants({ size: "lg" }), "mt-8")}>
            Create your first mandate <ArrowUpRight aria-hidden="true" />
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
                className="inline-flex min-h-11 items-center underline-offset-4 transition-colors hover:text-foreground/70 hover:underline motion-reduce:transition-none"
              >
                How it works
              </a>
              <a
                href="#agentguard"
                className="inline-flex min-h-11 items-center underline-offset-4 transition-colors hover:text-foreground/70 hover:underline motion-reduce:transition-none"
              >
                AgentGuard
              </a>
              <a
                href="#your-control"
                className="inline-flex min-h-11 items-center underline-offset-4 transition-colors hover:text-foreground/70 hover:underline motion-reduce:transition-none"
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
