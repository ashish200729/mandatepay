export type AuthMode = "sign-in" | "sign-up";

export type AuthInput = {
  name?: string;
  email: string;
  password: string;
};

type AuthResponse = {
  user?: {
    id?: unknown;
    name?: unknown;
    email?: unknown;
  };
};

export class AuthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthClientError";
  }
}

async function readResponse(response: Response) {
  const data = (await response.json().catch(() => null)) as
    (AuthResponse & { error?: unknown; message?: unknown }) | null;

  if (!response.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : typeof data?.error === "string"
          ? data.error
          : "We couldn’t complete that request. Check your details and try again.";

    throw new AuthClientError(message.slice(0, 180));
  }

  return data;
}

async function post(path: string, input?: AuthInput) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input ?? {}),
  });

  return readResponse(response);
}

export function signIn(input: Required<Pick<AuthInput, "email" | "password">>) {
  return post("/api/auth/sign-in/email", input);
}

export function signUp(input: Required<AuthInput>) {
  return post("/api/auth/sign-up/email", input);
}

export function signOut() {
  return post("/api/auth/sign-out");
}
