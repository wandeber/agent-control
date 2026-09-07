import { readFileSync } from "node:fs";
import { CodexAppServerClient } from "./codex-thread-adapter.js";
import { ControllerError } from "../core/errors.js";
import type { AgentHandle } from "../core/types.js";

interface ExistingThread {
  id: string; cwd?: string; modelProvider?: string;
  status: { type: string };
  turns?: Array<{ id: string; status: string }>;
}

function clientFor(handle: AgentHandle) {
  const file = handle.data.auth_token_file ?? process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE;
  const token = typeof file === "string" ? readFileSync(file, "utf8").trim() : process.env.CODEX_APP_SERVER_AUTH_TOKEN ?? process.env.CODEX_REMOTE_TOKEN;
  return new CodexAppServerClient(String(handle.data.app_server_url ?? process.env.CODEX_APP_SERVER_URL ?? process.env.CODEX_APP_SERVER ?? "unix://"), token);
}

export async function inspectSessionControl(handle: AgentHandle) {
  const client = clientFor(handle);
  try {
    await client.initialize();
    const result = await client.request("thread/read", { threadId: String(handle.data.thread_id), includeTurns: true }) as { thread: ExistingThread };
    if (result.thread?.id !== String(handle.data.thread_id)) throw new ControllerError("The control endpoint returned a different thread identity.", "backend_unavailable");
    return result.thread;
  } finally { client.close(); }
}

/** Operations go to the owning app-server; an archive is never a competing writer. */
export async function controlExistingSession(handle: AgentHandle, action: "send" | "interrupt", message?: string) {
  if (String(handle.data.app_server_url ?? "").startsWith("stdio")) throw new ControllerError("Control requires the session's persistent app-server endpoint; a temporary stdio process cannot own continued work.", "backend_unavailable");
  const client = clientFor(handle);
  try {
    await client.initialize();
    const result = await client.request("thread/read", { threadId: String(handle.data.thread_id), includeTurns: true }) as { thread: ExistingThread };
    const thread = result.thread;
    if (thread?.id !== String(handle.data.thread_id)) throw new ControllerError("The control endpoint returned a different thread identity.", "backend_unavailable");
    // An unloaded record may belong to a live CLI writer invisible to this endpoint.
    // Resume only when persisted terminal evidence was established by the caller.
    if (thread.status.type === "notLoaded") {
      if (!handle.data.safe_to_resume) throw new ControllerError("This endpoint does not own the active session. Connect worker_attach to its owning app-server; no second writer was started.", "backend_unavailable");
      if (action === "interrupt") return;
      await client.request("thread/resume", { threadId: String(handle.data.thread_id),
        modelProvider: handle.data.model_provider ?? thread.modelProvider,
        model: handle.data.model, cwd: handle.data.cwd });
    }
    const turn = thread.turns?.slice().reverse().find(t => t.status === "inProgress");
    if (thread.status.type === "active" && !turn) throw new ControllerError("The owning session is active but has no addressable turn yet; retry after its next event.", "backend_unavailable");
    if (action === "interrupt") {
      if (turn) await client.request("turn/interrupt", { threadId: String(handle.data.thread_id), turnId: turn.id });
      return;
    }
    const input = [{ type: "text", text: message, text_elements: [] }];
    if (turn) {
      // expectedTurnId prevents a completion race from redirecting a message to a new turn.
      await client.request("turn/steer", { threadId: String(handle.data.thread_id), expectedTurnId: turn.id, input });
    } else {
      await client.request("turn/start", { threadId: String(handle.data.thread_id), input });
    }
  } finally { client.close(); }
}
