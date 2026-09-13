export class ControllerError extends Error {
    reason;
    details;
    constructor(message, reason = "unknown", details = {}) {
        super(message);
        this.reason = reason;
        this.details = details;
        this.name = "ControllerError";
    }
}
/** Worker logs retain actionable capability identity, never instruction/config payloads. */
export function workerError(error) {
    const details = {};
    if (error instanceof ControllerError) {
        for (const key of ["capability_kind", "capability_id", "expected_enabled", "actual_enabled"]) {
            const value = error.details[key];
            if (typeof value === "string" || typeof value === "boolean")
                details[key] = value;
        }
    }
    return { message: error instanceof Error ? error.message : "Worker execution failed.",
        reason: error instanceof ControllerError ? error.reason : "unknown", details };
}
export function errorToPayload(error) {
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
