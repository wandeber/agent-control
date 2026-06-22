import { randomUUID } from "node:crypto";
export function newId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
export function nowIso() {
    return new Date().toISOString();
}
