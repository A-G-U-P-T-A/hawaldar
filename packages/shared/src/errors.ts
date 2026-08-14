export const ErrorCode = {
  CONFIG_INVALID: "CONFIG_INVALID",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  SCOPE_VIOLATION: "SCOPE_VIOLATION",
  POLICY_DENIED: "POLICY_DENIED",
  SANDBOX_FAILURE: "SANDBOX_FAILURE",
  TOOL_FAILURE: "TOOL_FAILURE",
  PERSISTENCE_FAILURE: "PERSISTENCE_FAILURE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class HawaldarError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HawaldarError";
    this.code = code;
    this.details = details;
  }
}
