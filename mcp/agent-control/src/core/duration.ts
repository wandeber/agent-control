import { ControllerError } from "./errors.js";

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

export function parseDurationMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = /^(\d+)(ms|s|m|h|d)$/.exec(trimmed);
  if (!match) {
    throw new ControllerError(
      "Invalid duration. Use raw milliseconds or a suffix such as 30m, 12h, or 7d.",
      "tool_error",
      { value }
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  return amount * UNIT_MS[unit];
}
