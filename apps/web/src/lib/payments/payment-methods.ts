import { PaymentApiError, isSafePayPalApprovalUrl } from "./client";

/** Must match the server's VAULT_CONSENT_VERSION; the server refuses any other value. */
export const SAVED_PAYPAL_CONSENT_VERSION = "2026-10-12";

export type SavedPayPalStatus = "NONE" | "SETUP_PENDING" | "ACTIVE" | "REMOVAL_PENDING" | "REVOKED";

export type SavedPayPal = {
  status: SavedPayPalStatus;
  /** Whether the server can save PayPal (Vault-capable client and encryption key). */
  available: boolean;
  /** Masked payer email for display only. */
  payerEmail: string | null;
  activatedAt: string | null;
};

export type AutopayPreview = {
  eligible: boolean;
  reason: string | null;
  payment: { id: string; status: string; paymentSource: "checkout" | "vault" } | null;
};

const STATUSES = new Set<SavedPayPalStatus>([
  "NONE",
  "SETUP_PENDING",
  "ACTIVE",
  "REMOVAL_PENDING",
  "REVOKED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length <= 320 ? value : null;
}

export function readSavedPayPal(value: unknown): SavedPayPal {
  const candidate = isRecord(value) && isRecord(value.paymentMethod) ? value.paymentMethod : value;
  if (
    !isRecord(candidate) ||
    typeof candidate.status !== "string" ||
    !STATUSES.has(candidate.status as SavedPayPalStatus) ||
    typeof candidate.available !== "boolean"
  ) {
    throw new Error("The saved PayPal response was not valid.");
  }
  return {
    status: candidate.status as SavedPayPalStatus,
    available: candidate.available,
    payerEmail: optionalString(candidate.payerEmail),
    activatedAt: optionalString(candidate.activatedAt),
  };
}

const SAFE_CODE = /^[A-Z0-9_:]{1,128}$/u;

export function readAutopayPreview(value: unknown): AutopayPreview {
  const candidate = isRecord(value) && isRecord(value.autopay) ? value.autopay : value;
  if (!isRecord(candidate) || typeof candidate.eligible !== "boolean") {
    throw new Error("The autopay response was not valid.");
  }
  const payment = isRecord(candidate.payment) ? candidate.payment : null;
  return {
    eligible: candidate.eligible,
    reason:
      typeof candidate.reason === "string" && SAFE_CODE.test(candidate.reason)
        ? candidate.reason
        : null,
    payment:
      payment &&
      typeof payment.id === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/u.test(payment.id) &&
      typeof payment.status === "string"
        ? {
            id: payment.id,
            status: payment.status,
            paymentSource: payment.paymentSource === "vault" ? "vault" : "checkout",
          }
        : null,
  };
}

async function request(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch {
    throw new PaymentApiError(
      "We couldn’t reach MandatePay. Refresh Settings to check your saved PayPal.",
      503,
    );
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "We couldn’t update your saved PayPal. Try again.";
    throw new PaymentApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

export async function getSavedPayPal() {
  return readSavedPayPal(await request("/api/payment-methods/paypal"));
}

/**
 * Records consent and returns the PayPal approval link. Only the exact Sandbox
 * or live PayPal buyer hosts are accepted before the browser is sent there.
 */
export async function startSavedPayPal() {
  const payload = await request("/api/payment-methods/paypal/setup", {
    method: "POST",
    body: JSON.stringify({ consent: true, consentVersion: SAVED_PAYPAL_CONSENT_VERSION }),
  });
  const approvalUrl = isRecord(payload) ? payload.approvalUrl : null;
  if (approvalUrl !== null && !isSafePayPalApprovalUrl(approvalUrl)) {
    throw new Error("PayPal returned an unsafe approval link.");
  }
  return { paymentMethod: readSavedPayPal(payload), approvalUrl: approvalUrl as string | null };
}

export async function completeSavedPayPal() {
  return readSavedPayPal(
    await request("/api/payment-methods/paypal/complete", { method: "POST", body: "{}" }),
  );
}

export async function cancelSavedPayPal() {
  return readSavedPayPal(
    await request("/api/payment-methods/paypal/cancel", { method: "POST", body: "{}" }),
  );
}

export async function removeSavedPayPal() {
  return readSavedPayPal(
    await request("/api/payment-methods/paypal/remove", { method: "POST", body: "{}" }),
  );
}

export async function getAutopayPreview(proposalId: string) {
  return readAutopayPreview(
    await request(`/api/proposals/${encodeURIComponent(proposalId)}/autopay`),
  );
}
