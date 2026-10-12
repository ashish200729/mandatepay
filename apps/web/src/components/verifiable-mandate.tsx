"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  CircleAlert,
  Copy,
  Download,
  KeyRound,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import {
  MANDATE_JWKS_PATH,
  credentialFileName,
  credentialLabel,
  describeConstraint,
  getCartMandate,
  getMandateCredentials,
  hashPrefix,
  type CartMandate,
  type MandateCredential,
  type MandateCredentialSet,
} from "@/lib/mandates/credentials";
import { formatUtcDate } from "@/lib/mandates/money";

// Buttons keep a 40px target but may wrap their label on a 320px screen.
const wrapButton = "h-auto min-h-10 whitespace-normal py-2 text-left";

function CredentialActions({ credential }: { credential: MandateCredential }) {
  const [message, setMessage] = useState("");
  const label = credentialLabel(credential.kind).toLowerCase();

  async function copy() {
    try {
      await navigator.clipboard.writeText(credential.jwt);
      setMessage(`Copied the ${label}.`);
    } catch {
      setMessage("Copy is unavailable in this browser. Use Download .jwt instead.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([credential.jwt], { type: "application/jwt" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = credentialFileName(credential);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage(`Downloaded the ${label}.`);
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), wrapButton)}
          aria-label={`Copy credential: ${credentialLabel(credential.kind)}`}
        >
          <Copy aria-hidden="true" /> Copy credential
        </button>
        <button
          type="button"
          onClick={download}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), wrapButton)}
          aria-label={`Download .jwt: ${credentialLabel(credential.kind)}`}
        >
          <Download aria-hidden="true" /> Download .jwt
        </button>
      </div>
      <p className="mt-2 min-h-5 text-xs text-muted-foreground" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

function ConstraintTable({ credential }: { credential: MandateCredential }) {
  const rows = credential.constraints.map(describeConstraint);
  const captionId = `constraints-${credential.id}`;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[30rem] text-left text-sm" aria-labelledby={captionId}>
        <caption id={captionId} className="sr-only">
          Constraints signed in the {credentialLabel(credential.kind)}
        </caption>
        <thead className="bg-secondary/60 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Rule
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Signed limit
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Credential field
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border align-top">
              <th scope="row" className="px-3 py-2 font-medium">
                {row.rule}
              </th>
              <td className="break-words px-3 py-2">{row.value}</td>
              <td className="px-3 py-2">
                <code className="break-all text-xs">{row.field}</code>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {row.standard}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statusNote(status: string) {
  if (status === "PAUSED")
    return "This mandate is paused. The credential still proves what you signed, but MandatePay will not authorize purchases until you resume it.";
  if (status === "REVOKED" || status === "EXPIRED")
    return `This mandate is ${status.toLowerCase()}. The credential still proves what you signed, but MandatePay no longer honors it.`;
  return null;
}

/** Mandate detail: the signed AP2-shaped open mandates for the active version. */
export function VerifiableMandatePanel({
  mandateId,
  version,
  status,
}: {
  mandateId: string;
  version: number;
  status: string;
}) {
  const [data, setData] = useState<MandateCredentialSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getMandateCredentials(mandateId);
      if (current === request.current) setData(next);
    } catch (cause) {
      if (current === request.current) {
        setError(cause instanceof Error ? cause.message : "Credentials could not be loaded.");
      }
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [mandateId]);

  useEffect(() => {
    // Reload after activation or a new version so the panel shows the signed limits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      request.current += 1;
    };
  }, [load, version, status]);

  const credentials = data?.credentials ?? [];
  const verified = credentials.length > 0 && credentials.every((item) => item.verified);
  const first = credentials[0];
  const note = statusNote(data?.mandateStatus ?? status);

  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-7"
      aria-labelledby="verifiable-mandate-heading"
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2
          id="verifiable-mandate-heading"
          className="flex items-center gap-2 text-base font-medium"
        >
          <KeyRound size={18} aria-hidden="true" /> Verifiable mandate
        </h2>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle
              size={14}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Checking signature…
          </span>
        ) : verified ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
            <BadgeCheck size={14} aria-hidden="true" /> Verified
          </span>
        ) : credentials.length ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive">
            <ShieldAlert size={14} aria-hidden="true" /> Not verified
          </span>
        ) : null}
      </div>
      <p className="mt-3 max-w-[75ch] text-sm leading-relaxed text-muted-foreground">
        Any party can verify this was issued by MandatePay for exactly these limits. It is an
        AP2-shaped mandate credential (v0.2 field names) signed with ES256 when you activated this
        version; the signature was checked on the server. It is not AP2-certified and is not bound
        to a specific agent key yet.
      </p>

      {error ? (
        <div
          className="mt-4 flex flex-wrap items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="font-medium underline underline-offset-4"
          >
            Try again
          </button>
        </div>
      ) : null}

      {!loading && !error && credentials.length === 0 ? (
        <p className="mt-4 rounded-lg bg-secondary px-4 py-3 text-sm">
          {status === "DRAFT"
            ? "A signed credential is issued when you activate this mandate."
            : "No credential was issued for this version."}
        </p>
      ) : null}

      {note && credentials.length ? (
        <p className="mt-4 rounded-lg bg-sand px-4 py-3 text-sm">{note}</p>
      ) : null}

      {first ? (
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Key ID (kid)</dt>
            <dd className="mt-1 break-all font-mono text-xs">{first.kid}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Issued</dt>
            <dd className="mt-1 font-medium">{formatUtcDate(first.issuedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Expires</dt>
            <dd className="mt-1 font-medium">
              {first.expiresAt ? formatUtcDate(first.expiresAt) : "—"}
            </dd>
          </div>
        </dl>
      ) : null}

      {credentials.map((credential) => (
        <div key={credential.id} className="mt-6 border-t border-border pt-5">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {credentialLabel(credential.kind)}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-normal">
              {credential.vct}
            </code>
            {!credential.verified ? (
              <span className="text-xs font-normal text-destructive">
                Signature check failed ({credential.verificationReason ?? "unknown"})
              </span>
            ) : null}
          </h3>
          <ConstraintTable credential={credential} />
          <CredentialActions credential={credential} />
        </div>
      ))}

      <p className="mt-5 border-t border-border pt-4 text-sm">
        <a
          href={MANDATE_JWKS_PATH}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          MandatePay public keys (JWKS)
        </a>
        <span className="text-muted-foreground"> · verify offline with any JOSE library.</span>
      </p>
    </section>
  );
}

/** Proposal and receipt: the closed cart mandate's checkout hash check. */
export function CartMandateBadge({ proposalId }: { proposalId: string }) {
  const [data, setData] = useState<CartMandate | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getCartMandate(proposalId)
      .then((next) => {
        if (active) setData(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [proposalId]);

  const base =
    "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-4 py-3 text-sm leading-relaxed";
  if (failed) {
    return (
      <p className={cn(base, "border-border bg-secondary text-muted-foreground")}>
        Cart mandate status is unavailable right now.
      </p>
    );
  }
  if (!data) {
    return (
      <p className={cn(base, "border-border text-muted-foreground")} role="status">
        <LoaderCircle
          size={14}
          className="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        Checking cart mandate…
      </p>
    );
  }
  if (data.credentials.length === 0) {
    return (
      <p className={cn(base, "border-border bg-secondary text-muted-foreground")}>
        Cart mandate · signed when this proposal is authorized by AgentGuard or your approval.
      </p>
    );
  }
  if (!data.hashVerified) {
    return (
      <p className={cn(base, "border-destructive/25 bg-destructive/8")} role="alert">
        <ShieldAlert size={16} aria-hidden="true" />
        <span className="font-medium">Cart mandate · hash does not match</span>
        <span className="text-muted-foreground">
          PayPal will not be called for this cart. Hash{" "}
          <code className="break-all font-mono text-xs">{hashPrefix(data.checkoutHash)}…</code>
        </span>
      </p>
    );
  }
  return (
    <p className={cn(base, "border-border bg-card")}>
      <BadgeCheck size={16} aria-hidden="true" />
      <span className="font-medium">
        Cart mandate · hash verified <span aria-hidden="true">✓</span>
      </span>
      <span className="text-muted-foreground">
        <span className="sr-only">Checkout hash begins </span>
        <code className="break-all font-mono text-xs" title={data.checkoutHash ?? undefined}>
          {hashPrefix(data.checkoutHash)}…
        </code>{" "}
        · signed for exactly this item, merchant, quantity and total.
      </span>
    </p>
  );
}
