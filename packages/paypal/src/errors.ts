export type PayPalConfigurationErrorCode =
  | "INVALID_ENVIRONMENT"
  | "MISSING_CLIENT_ID"
  | "MISSING_CLIENT_SECRET"
  | "INVALID_TIMEOUT"
  | "INVALID_RETRY_LIMIT"
  | "MISSING_WEBHOOK_ID";

export type PayPalProviderErrorCode =
  | "AUTHENTICATION_FAILED"
  | "UPSTREAM_ABORTED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REQUEST_FAILED"
  | "MALFORMED_RESPONSE"
  | "INVALID_WEBHOOK_SIGNATURE_RESPONSE";

export type PayPalInputErrorCode =
  | "INVALID_ORDER_INPUT"
  | "INVALID_CAPTURE_INPUT"
  | "INVALID_REFUND_INPUT"
  | "INVALID_WEBHOOK_INPUT"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INVALID_VAULT_INPUT";

export type PayPalResponseErrorCode =
  | "INVALID_ORDER_RESPONSE"
  | "INVALID_CAPTURE_RESPONSE"
  | "INVALID_REFUND_RESPONSE"
  | "INVALID_APPROVAL_URL"
  | "INVALID_VAULT_RESPONSE";

export type PayPalErrorCode =
  | PayPalConfigurationErrorCode
  | PayPalProviderErrorCode
  | PayPalInputErrorCode
  | PayPalResponseErrorCode;

export class PayPalError extends Error {
  readonly code: PayPalErrorCode;
  readonly retryable: boolean;
  readonly unknownOutcome: boolean;

  constructor(
    code: PayPalErrorCode,
    message: string,
    options: { retryable?: boolean; unknownOutcome?: boolean } = {},
  ) {
    super(message);
    this.name = "PayPalError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.unknownOutcome = options.unknownOutcome ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PayPalConfigurationError extends PayPalError {
  constructor(code: PayPalConfigurationErrorCode) {
    super(code, "PayPal configuration is invalid.");
    this.name = "PayPalConfigurationError";
  }
}

/**
 * Safe, bounded fields copied from a PayPal error body. Free-text messages,
 * descriptions and links are never retained, so these may be stored or logged.
 */
export interface PayPalErrorDetails {
  readonly name: string | null;
  readonly issue: string | null;
  readonly debugId: string | null;
}

/** 4xx statuses that do not prove PayPal refused the operation. */
const UNCERTAIN_CLIENT_STATUSES = new Set([401, 408, 409, 429]);

export class PayPalProviderError extends PayPalError {
  readonly status: number | undefined;
  readonly providerName: string | null;
  readonly issue: string | null;
  readonly debugId: string | null;

  constructor(
    code: PayPalProviderErrorCode,
    status?: number,
    options: {
      retryable?: boolean;
      unknownOutcome?: boolean;
      details?: Partial<PayPalErrorDetails> | null;
    } = {},
  ) {
    super(code, "PayPal could not complete the request.", options);
    this.name = "PayPalProviderError";
    this.status = status;
    this.providerName = options.details?.name ?? null;
    this.issue = options.details?.issue ?? null;
    this.debugId = options.details?.debugId ?? null;
  }

  /** PayPal answered with a final rejection; the operation was not performed. */
  get definitive(): boolean {
    return (
      this.code === "UPSTREAM_REQUEST_FAILED" &&
      this.status !== undefined &&
      this.status >= 400 &&
      this.status < 500 &&
      !UNCERTAIN_CLIENT_STATUSES.has(this.status)
    );
  }
}

export type PayPalOutcomeClass = "definitive" | "uncertain";

/**
 * Network errors, timeouts, 401/408/409/429, 5xx, malformed bodies and
 * anything that is not a provider response are uncertain: the operation may
 * have run. Only a parsed PayPal 4xx rejection is definitive.
 */
export function classifyPayPalError(error: unknown): PayPalOutcomeClass {
  return error instanceof PayPalProviderError && error.definitive ? "definitive" : "uncertain";
}

export function isDefinitivePayPalRejection(error: unknown): error is PayPalProviderError {
  return classifyPayPalError(error) === "definitive";
}

/** Returns only the safe log/storage fields of a provider error, or null. */
export function payPalErrorDetails(error: unknown): PayPalErrorDetails | null {
  if (!(error instanceof PayPalProviderError)) return null;
  return { name: error.providerName, issue: error.issue, debugId: error.debugId };
}

export class PayPalInputError extends PayPalError {
  constructor(code: PayPalInputErrorCode) {
    super(code, "PayPal request input is invalid.");
    this.name = "PayPalInputError";
  }
}

export class PayPalResponseError extends PayPalError {
  constructor(code: PayPalResponseErrorCode) {
    super(code, "PayPal returned an unusable response.");
    this.name = "PayPalResponseError";
  }
}

export class PayPalWebhookError extends PayPalError {
  constructor(code: PayPalErrorCode) {
    super(code, "PayPal webhook verification failed.");
    this.name = "PayPalWebhookError";
  }
}

export function isPayPalError(error: unknown): error is PayPalError {
  return error instanceof PayPalError;
}
