import { randomUUID } from "node:crypto";

export const BRIDGE_GRANT_ID_RE = /^bridge_[0-9a-f]{20}$/;
export const ORCHESTRATOR_ACTION_ID_RE = /^action_[0-9a-f]{20}$/;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isBridgeGrantId(value: string): boolean {
  return BRIDGE_GRANT_ID_RE.test(value);
}

export function isOrchestratorActionId(value: string): boolean {
  return ORCHESTRATOR_ACTION_ID_RE.test(value);
}
