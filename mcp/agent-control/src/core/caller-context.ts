import { AsyncLocalStorage } from "node:async_hooks";
import { ControllerError } from "./errors.js";

const callers = new AsyncLocalStorage<{ threadId: string | undefined }>();

/** Codex supplies _meta.threadId outside the model-controlled tool arguments.
 * The local stdio host is the trust boundary; this is not remote authentication.
 * A shared MCP process must never use its launching thread as another caller.
 */
export function withMcpCaller<T>(meta: unknown, callback: () => T): T {
  const value = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).threadId : undefined;
  if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value))) {
    throw new ControllerError("Codex tool metadata contains an invalid thread identity.", "auth_required");
  }
  // An absent MCP identity stays absent. Falling back here to process.env
  // would let an unidentified request borrow the long-lived server's owner.
  return callers.run({ threadId: typeof value === "string" ? value.trim() : undefined }, callback);
}

export function currentCodexThreadId(): string | undefined {
  const caller = callers.getStore();
  return caller ? caller.threadId : process.env.CODEX_THREAD_ID?.trim() || undefined;
}

/** Only the host-supplied MCP identity, never a CLI environment claim. */
export function currentMcpThreadId(): string | undefined { return callers.getStore()?.threadId; }
