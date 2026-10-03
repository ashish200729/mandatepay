export type Channel3ConfigurationErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_BASE_URL"
  | "INVALID_TIMEOUT"
  | "INVALID_RETRY_LIMIT"
  | "INVALID_FALLBACK_MODE";

export type Channel3ProviderErrorCode =
  | "UPSTREAM_ABORTED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REQUEST_FAILED"
  | "INVALID_RESPONSE";

export type Channel3NormalizationErrorCode =
  "INCOMPLETE_PRODUCT" | "UNSUPPORTED_CURRENCY" | "INVALID_PRICE" | "INVALID_PRODUCT_ID";

export type Channel3InputErrorCode = "INVALID_SEARCH_REQUEST" | "INVALID_LOOKUP_REQUEST";

export type Channel3ErrorCode =
  | Channel3ConfigurationErrorCode
  | Channel3ProviderErrorCode
  | Channel3NormalizationErrorCode
  | Channel3InputErrorCode;

export class Channel3Error extends Error {
  readonly code: Channel3ErrorCode;
  readonly retryable: boolean;

  constructor(code: Channel3ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "Channel3Error";
    this.code = code;
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class Channel3ConfigurationError extends Channel3Error {
  constructor(code: Channel3ConfigurationErrorCode) {
    super(code, "Channel3 configuration is invalid.");
    this.name = "Channel3ConfigurationError";
  }
}

export class Channel3ProviderError extends Channel3Error {
  readonly status: number | undefined;

  constructor(code: Channel3ProviderErrorCode, status?: number, retryable = false) {
    super(code, "Channel3 could not provide a usable catalog response.", retryable);
    this.name = "Channel3ProviderError";
    this.status = status;
  }
}

export class Channel3NormalizationError extends Channel3Error {
  constructor(code: Channel3NormalizationErrorCode) {
    super(code, "Channel3 product data is incomplete or unsupported.");
    this.name = "Channel3NormalizationError";
  }
}

export class Channel3InputError extends Channel3Error {
  constructor(code: Channel3InputErrorCode) {
    super(code, "Channel3 request input is invalid.");
    this.name = "Channel3InputError";
  }
}

export function isChannel3Error(error: unknown): error is Channel3Error {
  return error instanceof Channel3Error;
}
