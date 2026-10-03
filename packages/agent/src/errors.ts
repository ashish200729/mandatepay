export type ConfigurationErrorCode =
  | "MISSING_API_KEY"
  | "MISSING_MODEL"
  | "INVALID_BASE_URL"
  | "INVALID_RESPONSE_MODE"
  | "INVALID_TIMEOUT"
  | "INVALID_RETRY_LIMIT"
  | "INVALID_OUTPUT_TOKEN_BUDGET"
  | "INVALID_REASONING_EFFORT";

export type ProviderErrorCode =
  "UPSTREAM_ABORTED" | "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_REQUEST_FAILED";

export type CapabilityErrorCode = "STRUCTURED_OUTPUT_UNSUPPORTED" | "JSON_MODE_UNSUPPORTED";

export type OutputErrorCode =
  | "MODEL_REFUSAL"
  | "MODEL_TRUNCATED"
  | "MISSING_STRUCTURED_OUTPUT"
  | "MALFORMED_OUTPUT"
  | "UNSUPPORTED_OUTPUT"
  | "CANONICAL_VALIDATION_FAILED"
  | "RANKING_OUTPUT_INVALID";

export type InputErrorCode = "INVALID_PROMPT" | "INVALID_TRUSTED_TIME" | "INVALID_RANKING_INPUT";

export type MandateParserErrorCode =
  | ConfigurationErrorCode
  | ProviderErrorCode
  | CapabilityErrorCode
  | OutputErrorCode
  | InputErrorCode;

export class MandateParserError extends Error {
  readonly code: MandateParserErrorCode;
  readonly retryable: boolean;

  constructor(code: MandateParserErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "MandateParserError";
    this.code = code;
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OpenAIConfigurationError extends MandateParserError {
  constructor(code: ConfigurationErrorCode, message = "OpenAI parser configuration is invalid.") {
    super(code, message, false);
    this.name = "OpenAIConfigurationError";
  }
}

export class OpenAICapabilityError extends MandateParserError {
  constructor(
    code: CapabilityErrorCode,
    message = "The configured provider does not support the requested response mode.",
  ) {
    super(code, message, false);
    this.name = "OpenAICapabilityError";
  }
}

export class OpenAIProviderError extends MandateParserError {
  readonly status: number | undefined;

  constructor(
    code: ProviderErrorCode,
    status?: number,
    message = "The configured language-model provider could not complete the request.",
    retryable = false,
  ) {
    super(code, message, retryable);
    this.name = "OpenAIProviderError";
    this.status = status;
  }
}

export class OpenAIOutputError extends MandateParserError {
  constructor(
    code: OutputErrorCode,
    message = "The language-model response could not be accepted.",
  ) {
    super(code, message, false);
    this.name = "OpenAIOutputError";
  }
}

export class MandateInputError extends MandateParserError {
  constructor(code: InputErrorCode, message = "Mandate parser input is invalid.") {
    super(code, message, false);
    this.name = "MandateInputError";
  }
}

export class RankingInputError extends MandateParserError {
  constructor() {
    super("INVALID_RANKING_INPUT", "Ranking input is invalid.");
    this.name = "RankingInputError";
  }
}

export class RankingOutputError extends MandateParserError {
  constructor() {
    super("RANKING_OUTPUT_INVALID", "The product-ranking response could not be accepted.");
    this.name = "RankingOutputError";
  }
}

export function isMandateParserError(error: unknown): error is MandateParserError {
  return error instanceof MandateParserError;
}
