import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAVED_PAYPAL_CONSENT_VERSION,
  readAutopayPreview,
  readSavedPayPal,
  startSavedPayPal,
} from "./payment-methods";

afterEach(() => vi.unstubAllGlobals());

describe("saved PayPal readers", () => {
  it("keeps only display-safe fields and never a token", () => {
    const method = readSavedPayPal({
      paymentMethod: {
        provider: "paypal",
        status: "ACTIVE",
        available: true,
        payerEmail: "b***@example.com",
        activatedAt: "2026-10-12T10:00:00Z",
        paypalVaultId: "secret-token",
      },
    });
    expect(method).toEqual({
      status: "ACTIVE",
      available: true,
      payerEmail: "b***@example.com",
      activatedAt: "2026-10-12T10:00:00Z",
    });
    expect(JSON.stringify(method)).not.toContain("secret-token");
  });

  it("rejects unknown statuses", () => {
    expect(() =>
      readSavedPayPal({ paymentMethod: { status: "MAYBE", available: true } }),
    ).toThrow();
    expect(() => readSavedPayPal(null)).toThrow();
  });

  it("reads an autopay preview and drops unsafe ids", () => {
    expect(
      readAutopayPreview({
        autopay: {
          eligible: false,
          reason: "NO_SAVED_PAYMENT_METHOD",
          payment: null,
        },
      }),
    ).toEqual({ eligible: false, reason: "NO_SAVED_PAYMENT_METHOD", payment: null });
    expect(
      readAutopayPreview({
        autopay: {
          eligible: false,
          reason: "<script>",
          payment: { id: "../x", status: "COMPLETED", paymentSource: "vault" },
        },
      }),
    ).toEqual({ eligible: false, reason: null, payment: null });
    expect(
      readAutopayPreview({
        autopay: {
          eligible: false,
          reason: null,
          payment: { id: "payment_1", status: "COMPLETED", paymentSource: "vault" },
        },
      }).payment,
    ).toEqual({ id: "payment_1", status: "COMPLETED", paymentSource: "vault" });
  });
});

describe("starting saved PayPal consent", () => {
  it("sends explicit consent and accepts only a PayPal approval host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          paymentMethod: { status: "SETUP_PENDING", available: true },
          approvalUrl: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=S1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await startSavedPayPal();
    expect(result.approvalUrl).toContain("www.sandbox.paypal.com");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      consent: true,
      consentVersion: SAVED_PAYPAL_CONSENT_VERSION,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            paymentMethod: { status: "SETUP_PENDING", available: true },
            approvalUrl: "https://evil.example/agreements/approve",
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(startSavedPayPal()).rejects.toThrow("unsafe");
  });

  it("surfaces the server error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Saving PayPal is not available." }), {
          status: 503,
        }),
      ),
    );
    await expect(startSavedPayPal()).rejects.toThrow("Saving PayPal is not available.");
  });
});
