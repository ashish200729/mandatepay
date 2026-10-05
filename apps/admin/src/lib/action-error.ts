const messages = {
  conflict: "The record changed. Reload its current state before trying again.",
  unavailable: "The service is unavailable. Try again shortly using the same request.",
  "fresh-auth": "Confirm your password again before continuing.",
  invalid: "Review the action details and try again.",
};
export class AdminActionError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export function safeActionError(error: unknown) {
  return error instanceof AdminActionError
    ? error.message
    : "The outcome could not be confirmed. Check the current state before retrying this request.";
}
