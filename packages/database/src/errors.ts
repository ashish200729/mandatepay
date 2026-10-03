export const DATABASE_ERROR_CODES = [
  "INVALID_CURRENCY",
  "INVALID_MONEY",
  "INVALID_DATE_RANGE",
  "INVALID_QUANTITY",
  "INVALID_TOTAL",
  "INVALID_DOMAIN_INPUT",
  "OWNERSHIP_REQUIRED",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_STATE",
  "LIMIT_EXCEEDED",
  "RESERVATION_EXPIRED",
  "REFUND_EXCEEDS_REMAINING",
] as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: DatabaseErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}
