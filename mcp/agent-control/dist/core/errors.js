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
