import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultControlHome } from "./paths.js";

export const AGENT_CONTROL_TOKEN_ENV = "AGENT_CONTROL_TOKEN";
export const AGENT_CONTROL_ADMIN_KEY_ENV = "AGENT_CONTROL_ADMIN_KEY";

const ADMIN_KEY_FILE = "admin-key";

export function generateAgentToken(): string {
  return `act_${randomBytes(32).toString("base64url")}`;
}

export function generateBridgeToken(): string {
  return `acb_${randomBytes(32).toString("base64url")}`;
}

export function generateActionToken(): string {
  return `aca_${randomBytes(32).toString("base64url")}`;
}

export function generateAdminKey(): string {
  return `ack_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function resolveAdminKey(): string {
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

export function verifyAdminKey(candidate: string | null | undefined): boolean {
  const value = candidate?.trim();
  if (!value) {
    return false;
  }
  return timingSafeStringEqual(hashToken(value), hashToken(resolveAdminKey()));
}

function adminKeyPath(): string {
  return join(defaultControlHome(), ADMIN_KEY_FILE);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
