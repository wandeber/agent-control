import type { FailureReason } from "./types.js";

export class ControllerError extends Error {
  constructor(
    message: string,
    public readonly reason: FailureReason = "unknown",
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ControllerError";
  }
}

export function errorToPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ControllerError) {
    return {
      error: error.message,
      reason: error.reason,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      error: error.message,
      reason: "unknown"
    };
  }

  return {
    error: String(error),
    reason: "unknown"
  };
}
