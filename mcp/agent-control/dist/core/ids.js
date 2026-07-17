import { randomUUID } from "node:crypto";
export const BRIDGE_GRANT_ID_RE = /^bridge_[0-9a-f]{20}$/;
export const ORCHESTRATOR_ACTION_ID_RE = /^action_[0-9a-f]{20}$/;
export function newId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
export function nowIso() {
    return new Date().toISOString();
}
export function isBridgeGrantId(value) {
    return BRIDGE_GRANT_ID_RE.test(value);
}
export function isOrchestratorActionId(value) {
    return ORCHESTRATOR_ACTION_ID_RE.test(value);
}
