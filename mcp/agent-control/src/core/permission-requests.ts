import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ControllerError } from "./errors.js";

export type PermissionDecision = "approve" | "reject";
export interface PermissionRequest {
  request_id: string;
  agent_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  kind: "command" | "files" | "permissions";
  title: string;
  reason: string | null;
  scope: Record<string, unknown>;
  reject_interrupts_turn?: boolean;
  scope_complete: boolean;
  choices: PermissionDecision[];
  state: "pending" | "submitting" | "sent" | "resolved" | "unavailable";
  decision: PermissionDecision | null;
  created_at: string;
}
export interface StoredPermission extends PermissionRequest {
  connection_id: string;
  rpc_id: string;
  response_json: string | null;
  lease_until: number;
}

/** CLI identities come only from the registered worker's private runtime path. */
export function permissionOwnerMatches(agent: { backend: string; backend_handle?: Record<string, unknown> | null }, request: Pick<PermissionRequest, "thread_id" | "turn_id">): boolean {
  const handle = agent.backend_handle;
  if (agent.backend !== "codex-cli") return handle?.thread_id === request.thread_id;
  if (typeof handle?.dir !== "string") return false;
  try {
    const state = JSON.parse(readFileSync(join(handle.dir, "state.json"), "utf8"));
    return state.transport === "app-server" && state.status === "running" && state.thread_id === request.thread_id && state.runtime_turn_id === request.turn_id;
  } catch { return false; }
}

/** Shared by the MCP owner and browser API; only the live owner writes wire responses. */
export class PermissionRequests {
  constructor(private db: Database.Database) {
    db.exec(`create table if not exists permission_requests (
      request_id text primary key, agent_id text not null, connection_id text not null,
      rpc_id text not null, record_json text not null, state text not null,
      decision text, response_json text, lease_until integer not null,
      unique(connection_id, rpc_id));
      create table if not exists permission_observations (request_id text not null, state text not null, primary key(request_id,state))`);
  }
  create(connectionId: string, rpcId: string | number, request: Omit<PermissionRequest, "request_id" | "state" | "decision" | "created_at">) {
    const record: PermissionRequest = { ...request, request_id: randomUUID(), state: "pending", decision: null, created_at: new Date().toISOString() };
    this.db.prepare("insert or ignore into permission_requests values (?, ?, ?, ?, ?, 'pending', null, null, ?)")
      .run(record.request_id, request.agent_id, connectionId, JSON.stringify(rpcId), JSON.stringify(record), Date.now() + 5000);
  }
  private expire() {
    this.db.prepare("update permission_requests set state = 'unavailable' where state in ('pending','submitting','sent') and lease_until < ?").run(Date.now());
  }
  private decode(row: any): StoredPermission {
    return { ...JSON.parse(row.record_json), connection_id: row.connection_id, rpc_id: row.rpc_id,
      response_json: row.response_json, lease_until: row.lease_until, state: row.state, decision: row.decision };
  }
  get(id: string): StoredPermission | null {
    this.expire();
    const row = this.db.prepare("select * from permission_requests where request_id = ?").get(id);
    return row ? this.decode(row) : null;
  }
  list(agentIds: string[]): PermissionRequest[] {
    this.expire();
    return (this.db.prepare("select * from permission_requests where agent_id in (select value from json_each(?)) order by rowid").all(JSON.stringify(agentIds)) as any[])
      .map(row => { const { connection_id, rpc_id, response_json, lease_until, ...record } = this.decode(row); return record; });
  }
  decide(id: string, agentId: string, decision: PermissionDecision): PermissionRequest {
    if (!["approve", "reject"].includes(decision)) throw new ControllerError("Invalid permission decision.", "tool_error");
    const record = this.get(id);
    if (!record || record.agent_id !== agentId) throw new ControllerError("Permission request not found for this agent.", "auth_required");
    if (record.state !== "pending") {
      if (record.decision === decision && ["submitting", "sent", "resolved"].includes(record.state)) return this.public(record);
      throw new ControllerError("This permission request is no longer pending. Refresh its current state.", "tool_error");
    }
    if (!record.choices.includes(decision) || (decision === "approve" && !record.scope_complete)) throw new ControllerError("This decision is not supported for the visible request scope.", "unsupported_operation");
    const response = record.kind === "permissions"
      ? { permissions: decision === "approve" ? record.scope.permissions : {}, scope: "turn" }
      : { decision: decision === "approve" ? "accept" : record.reject_interrupts_turn ? "cancel" : "decline" };
    // The predicate serializes decisions from different panels/processes. Losing
    // callers cannot replace the first decision or dispatch a second response.
    const updated = this.db.prepare("update permission_requests set state='submitting', decision=?, response_json=? where request_id=? and state='pending' and lease_until>=?")
      .run(decision, JSON.stringify(response), id, Date.now());
    const current = this.get(id)!;
    if (!updated.changes && (current.decision !== decision || !["submitting", "sent", "resolved"].includes(current.state))) throw new ControllerError("A different decision already owns this request.", "tool_error");
    return this.public(current);
  }
  private public(record: StoredPermission): PermissionRequest {
    const { connection_id, rpc_id, response_json, lease_until, ...result } = record;
    return result;
  }
  heartbeat(connectionId: string) {
    this.expire();
    this.db.prepare("update permission_requests set lease_until=? where connection_id=? and state in ('pending','submitting','sent')").run(Date.now() + 5000, connectionId);
  }
  takeDecisions(connectionId: string): StoredPermission[] {
    return this.dispatchDecisions(connectionId, () => {});
  }
  dispatchDecisions(connectionId: string, send: (response: StoredPermission) => void): StoredPermission[] {
    return this.db.transaction(() => {
      this.expire();
      const rows = this.db.prepare("select * from permission_requests where connection_id=? and state in ('pending','submitting','sent')").all(connectionId) as any[];
      const result: StoredPermission[] = [];
      for (const row of rows) {
        const request = this.decode(row);
        const owner = this.db.prepare("select a.*, r.status as run_status from agents a join runs r on a.run_id=r.run_id where a.agent_id=?").get(request.agent_id) as any;
        const handle = owner?.backend_handle_json ? JSON.parse(owner.backend_handle_json) : null;
        const active = owner && !owner.unregistered_at && !["stopping", "stopped"].includes(owner.status) && !["stopping", "stopped"].includes(owner.run_status) && !handle?.cancel_requested;
        if (active && owner.status === "starting" && !handle) continue;
        if (!active || !permissionOwnerMatches({ backend: owner.backend, backend_handle: handle }, request)) {
          this.db.prepare("update permission_requests set state='unavailable' where request_id=?").run(request.request_id); continue;
        }
        if (row.state !== "submitting") continue;
        const claimed = this.db.prepare("update permission_requests set state='sent' where request_id=? and state='submitting' and lease_until>=?").run(request.request_id, Date.now());
        if (claimed.changes) {
          // Keep the controller write reservation until the owning socket has
          // enqueued the response, so a concurrent cancellation cannot overtake it.
          send(request); result.push(request);
        }
      }
      return result;
    }).immediate();
  }
  takeObservations(agentId: string): PermissionRequest[] {
    return this.list([agentId]).filter(request => ["pending", "resolved", "unavailable"].includes(request.state)
      && this.db.prepare("insert or ignore into permission_observations values (?,?)").run(request.request_id, request.state).changes);
  }
  resolve(connectionId: string, rpcId: string | number, threadId: string) {
    this.db.prepare("update permission_requests set state='resolved' where connection_id=? and rpc_id=? and json_extract(record_json,'$.thread_id')=? and state in ('pending','submitting','sent')")
      .run(connectionId, JSON.stringify(rpcId), threadId);
  }
  disconnect(connectionId: string) {
    this.db.prepare("update permission_requests set state='unavailable' where connection_id=? and state in ('pending','submitting','sent')").run(connectionId);
  }
}
