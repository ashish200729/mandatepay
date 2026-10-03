export const DOMAIN_ERROR_CODES = [
  "INVALID_CURRENCY",
  "INVALID_DATE_RANGE",
  "INVALID_DOMAIN_INPUT",
  "INVALID_MONEY",
  "INVALID_STATE_TRANSITION",
  "INVALID_TOTAL",
  "MONEY_OUT_OF_RANGE",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
