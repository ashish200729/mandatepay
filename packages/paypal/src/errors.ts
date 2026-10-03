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
  | "INVALID_IDEMPOTENCY_KEY";

export type PayPalResponseErrorCode =
  | "INVALID_ORDER_RESPONSE"
  | "INVALID_CAPTURE_RESPONSE"
  | "INVALID_REFUND_RESPONSE"
  | "INVALID_APPROVAL_URL";

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
    super(code, "PayPal Sandbox configuration is invalid.");
    this.name = "PayPalConfigurationError";
  }
}

export class PayPalProviderError extends PayPalError {
  readonly status: number | undefined;

  constructor(
    code: PayPalProviderErrorCode,
    status?: number,
    options: { retryable?: boolean; unknownOutcome?: boolean } = {},
  ) {
    super(code, "PayPal Sandbox could not complete the request.", options);
    this.name = "PayPalProviderError";
    this.status = status;
  }
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
