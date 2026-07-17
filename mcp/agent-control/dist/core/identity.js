import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultControlHome } from "./paths.js";
export const AGENT_CONTROL_TOKEN_ENV = "AGENT_CONTROL_TOKEN";
export const AGENT_CONTROL_ADMIN_KEY_ENV = "AGENT_CONTROL_ADMIN_KEY";
const ADMIN_KEY_FILE = "admin-key";
export function generateAgentToken() {
    return `act_${randomBytes(32).toString("base64url")}`;
}
export function generateBridgeToken() {
    return `acb_${randomBytes(32).toString("base64url")}`;
}
export function generateActionToken() {
    return `aca_${randomBytes(32).toString("base64url")}`;
}
export function generateAdminKey() {
    return `ack_${randomBytes(32).toString("base64url")}`;
}
export function hashToken(token) {
    return createHash("sha256").update(token, "utf8").digest("base64url");
}
export function resolveAdminKey() {
    const fromEnv = process.env[AGENT_CONTROL_ADMIN_KEY_ENV]?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    const file = adminKeyPath();
    if (existsSync(file)) {
        return readFileSync(file, "utf8").trim();
    }
    const generated = generateAdminKey();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    return generated;
}
export function verifyAdminKey(candidate) {
    const value = candidate?.trim();
    if (!value) {
        return false;
    }
    return timingSafeStringEqual(hashToken(value), hashToken(resolveAdminKey()));
}
function adminKeyPath() {
    return join(defaultControlHome(), ADMIN_KEY_FILE);
}
function timingSafeStringEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.byteLength !== rightBuffer.byteLength) {
        return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
}
