export type ErrorKind =
  | "config"
  | "invalid_input"
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network";

export interface FreshdeskFieldError {
  field?: string;
  message?: string;
  code?: string;
}

/**
 * Single error type for everything the connector reports. `message` is always
 * safe to show to the agent: it never contains credentials or raw response bodies.
 */
export class ConnectorError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly fieldErrors?: FreshdeskFieldError[];

  constructor(
    kind: ErrorKind,
    message: string,
    options: {
      status?: number;
      code?: string;
      retryAfterSeconds?: number;
      fieldErrors?: FreshdeskFieldError[];
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConnectorError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fieldErrors = options.fieldErrors;
  }
}

export function invalidInput(message: string): ConnectorError {
  return new ConnectorError("invalid_input", message);
}
