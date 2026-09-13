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

/** Worker logs retain actionable capability identity, never instruction/config payloads. */
export function workerError(error: unknown) {
  const details: Record<string, string | boolean> = {};
  if (error instanceof ControllerError) {
    for (const key of ["capability_kind", "capability_id", "expected_enabled", "actual_enabled"]) {
      const value = error.details[key];
      if (typeof value === "string" || typeof value === "boolean") details[key] = value;
    }
  }
  return { message: error instanceof Error ? error.message : "Worker execution failed.",
    reason: error instanceof ControllerError ? error.reason : "unknown" as const, details };
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
