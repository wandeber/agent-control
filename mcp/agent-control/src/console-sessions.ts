import { randomUUID } from "node:crypto";
import { ControllerError } from "./core/errors.js";

export interface FlowConsoleSelection {
  screen?: "console" | "subagents" | "flows";
  flow_id?: string;
  repo_dir?: string;
}

export interface ConsoleCommand extends FlowConsoleSelection {
  requested_run_id: string | null;
  follow_latest: boolean;
  action: "reuse" | "close";
  command_id: string;
}

interface ConsoleSession {
  id: string;
  threadId: string;
  command: ConsoleCommand | null;
  selection: FlowConsoleSelection;
}

/** An app-only panel id preserves the opener when the host omits tool metadata. */
export class ConsoleSessions {
  private sessions = new Map<string, ConsoleSession>();
  private byThread = new Map<string, string>();

  open(threadId: string | undefined, selection: FlowConsoleSelection = {}): ConsoleSession {
    if (!threadId) throw new ControllerError("Open Agent Control from an identified Codex conversation.", "auth_required");
    const previous = this.byThread.get(threadId);
    if (previous) this.sessions.delete(previous);
    const session = { id: randomUUID(), threadId, command: null, selection };
    this.sessions.set(session.id, session);
    this.byThread.set(threadId, session.id);
    return session;
  }

  get(threadId: string | undefined, panelId?: string): ConsoleSession {
    const id = panelId ?? (threadId ? this.byThread.get(threadId) : undefined);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || (threadId && session.threadId !== threadId)) {
      throw new ControllerError("Reopen Agent Control from this Codex conversation.", "auth_required");
    }
    return session;
  }

  forApp(threadId: string | undefined, panelId?: string): ConsoleSession {
    return this.get(panelId ? threadId : undefined, panelId);
  }

  queue(session: ConsoleSession, action: ConsoleCommand["action"], runId?: string, selection: FlowConsoleSelection = {}): ConsoleSession {
    // A concurrent open may have retired the captured panel during a read.
    this.get(session.threadId, session.id);
    session.selection = { ...session.selection, ...selection };
    session.command = { ...session.selection, requested_run_id: runId ?? null, follow_latest: !runId, action, command_id: randomUUID() };
    return session;
  }

  acknowledge(session: ConsoleSession, commandId?: string): void {
    if (commandId && session.command?.command_id === commandId) session.command = null;
  }
}
