export type AuthMode = "sign-in" | "sign-up";

export type AuthInput = {
  name?: string;
  email: string;
  password: string;
  callbackURL?: string;
};

type AuthResponse = {
  token?: string | null;
  user?: {
    id?: unknown;
    name?: unknown;
    email?: unknown;
  };
};

export class AuthClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AuthClientError";
  }
}

async function readResponse(response: Response) {
  const data = (await response.json().catch(() => null)) as
    (AuthResponse & { error?: unknown; message?: unknown; code?: unknown }) | null;

  if (!response.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : typeof data?.error === "string"
          ? data.error
          : "We couldn’t complete that request. Check your details and try again.";

    throw new AuthClientError(
      message.slice(0, 180),
      typeof data?.code === "string" ? data.code : undefined,
    );
  }

  return data;
}

async function post(path: string, input?: object) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input ?? {}),
  });

  return readResponse(response);
}

export function signIn(input: Pick<AuthInput, "email" | "password" | "callbackURL">) {
  return post("/api/auth/sign-in/email", input);
}

export function signUp(input: AuthInput & { name: string }) {
  return post("/api/auth/sign-up/email", input);
}

export function signOut() {
  return post("/api/auth/sign-out");
}

export function sendVerificationEmail(email: string, callbackURL: string) {
  return post("/api/auth/send-verification-email", { email, callbackURL });
}

export function requestPasswordReset(email: string, redirectTo: string) {
  return post("/api/auth/request-password-reset", { email, redirectTo });
}

export function resetPassword(token: string, newPassword: string) {
  return post("/api/auth/reset-password", { token, newPassword });
}
