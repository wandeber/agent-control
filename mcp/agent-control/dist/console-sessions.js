import { randomUUID } from "node:crypto";
import { ControllerError } from "./core/errors.js";
/** An app-only panel id preserves the opener when the host omits tool metadata. */
export class ConsoleSessions {
    sessions = new Map();
    byThread = new Map();
    open(threadId) {
        if (!threadId)
            throw new ControllerError("Open Agent Control from an identified Codex conversation.", "auth_required");
        const previous = this.byThread.get(threadId);
        if (previous)
            this.sessions.delete(previous);
        const session = { id: randomUUID(), threadId, command: null };
        this.sessions.set(session.id, session);
        this.byThread.set(threadId, session.id);
        return session;
    }
    get(threadId, panelId) {
        const id = panelId ?? (threadId ? this.byThread.get(threadId) : undefined);
        const session = id ? this.sessions.get(id) : undefined;
        if (!session || (threadId && session.threadId !== threadId)) {
            throw new ControllerError("Reopen Agent Control from this Codex conversation.", "auth_required");
        }
        return session;
    }
    forApp(threadId, panelId) {
        return this.get(panelId ? threadId : undefined, panelId);
    }
    queue(session, action, runId) {
        // A concurrent open may have retired the captured panel during a read.
        this.get(session.threadId, session.id);
        session.command = { requested_run_id: runId ?? null, follow_latest: !runId, action, command_id: randomUUID() };
        return session;
    }
    acknowledge(session, commandId) {
        if (commandId && session.command?.command_id === commandId)
            session.command = null;
    }
}
