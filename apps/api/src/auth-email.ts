export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
}

export type AuthEmailSender = (email: AuthEmail) => Promise<void>;

/** Fixed provider endpoint; provider responses and credentials never enter auth errors. */
export function createResendAuthEmailSender({
  apiKey,
  from,
  fetchImpl = fetch,
}: {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}): AuthEmailSender {
  return async (email) => {
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Delivery failed");
      await response.body?.cancel();
    } catch {
      throw new Error("Authentication email delivery failed.");
    }
  };
}
