import type Database from "better-sqlite3";
import { ControllerError } from "./errors.js";

export interface AccessPolicy {
  sandbox: "read_only" | "workspace" | "full_access";
  approval_policy: "on-request" | "never" | "untrusted";
}
export interface EffectiveAccess {
  approval_policy: unknown;
  sandbox_policy: Record<string, unknown>;
  thread_id: string;
  observed_at: string;
}
export interface AgentAccessSnapshot {
  agent_id: string;
  requested: AccessPolicy | null;
  effective: EffectiveAccess | null;
  revision: number;
  effective_revision: number | null;
  state: "pending" | "applied" | "unverified" | "unsupported";
}

/** Requested settings are intent; only an app-server response confirms effect. */
export class AgentAccessStore {
  constructor(private db: Database.Database) {
    db.exec(`create table if not exists agent_access (
      agent_id text primary key, requested_json text, effective_json text,
      revision integer not null default 0, effective_revision integer)`);
  }
  getAgentAccess(agentId: string): AgentAccessSnapshot {
    const row = this.db.prepare("select * from agent_access where agent_id=?").get(agentId) as any;
    const result = { agent_id: agentId, requested: row?.requested_json ? JSON.parse(row.requested_json) as AccessPolicy : null,
      effective: row?.effective_json ? JSON.parse(row.effective_json) as EffectiveAccess : null,
      revision: row?.revision ?? 0, effective_revision: row?.effective_revision ?? null };
    return { ...result, state: result.requested ? result.effective_revision === result.revision ? "applied" : "pending" : "unverified" };
  }
  requestAgentAccess(agentId: string, policy: AccessPolicy, expectedRevision: number): AgentAccessSnapshot {
    if (!policy || Object.keys(policy).some(key => !["sandbox", "approval_policy"].includes(key)) || !["read_only", "workspace", "full_access"].includes(policy.sandbox) || !["on-request", "never", "untrusted"].includes(policy.approval_policy)) throw new ControllerError("Unsupported access policy.", "unsupported_operation");
    this.db.prepare("insert or ignore into agent_access(agent_id) values (?)").run(agentId);
    const current = this.getAgentAccess(agentId);
    if (current.revision !== expectedRevision) throw new ControllerError("Access settings changed. Refresh before applying another policy.", "tool_error");
    if (JSON.stringify(current.requested) === JSON.stringify(policy)) return current;
    const changed = this.db.prepare("update agent_access set requested_json=?,revision=revision+1 where agent_id=? and revision=?")
      .run(JSON.stringify(policy), agentId, expectedRevision);
    if (!changed.changes) throw new ControllerError("Access settings changed. Refresh before applying another policy.", "tool_error");
    return this.getAgentAccess(agentId);
  }
  confirmAgentAccess(agentId: string, revision: number, effective: Omit<EffectiveAccess, "observed_at">, expected?: { approvalPolicy: unknown; sandboxPolicy: Record<string, unknown>; implicitCwd?: string }): AgentAccessSnapshot {
    if (!effective.thread_id || !effective.sandbox_policy || typeof effective.sandbox_policy.type !== "string" || effective.approval_policy === undefined) return this.getAgentAccess(agentId);
    this.db.prepare("insert or ignore into agent_access(agent_id) values (?)").run(agentId);
    const matches = expected && canonical(effective.approval_policy) === canonical(expected.approvalPolicy)
      && sandboxMatches(effective.sandbox_policy, expected.sandboxPolicy, expected.implicitCwd);
    this.db.prepare("update agent_access set effective_json=?,effective_revision=? where agent_id=? and revision=?")
      .run(JSON.stringify({ ...effective, observed_at: new Date().toISOString() }), matches ? revision : null, agentId, revision);
    return this.getAgentAccess(agentId);
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === "object") return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return JSON.stringify(value);
}
function sandboxMatches(actual: Record<string, unknown>, expected: Record<string, unknown>, implicitCwd?: string): boolean {
  if (implicitCwd && actual.type === "workspaceWrite" && expected.type === "workspaceWrite") {
    actual = { ...actual, writableRoots: (Array.isArray(actual.writableRoots) ? actual.writableRoots : []).filter(path => path !== implicitCwd) };
    expected = { ...expected, writableRoots: (Array.isArray(expected.writableRoots) ? expected.writableRoots : []).filter(path => path !== implicitCwd) };
  }
  // Preserve unrecognized constraints in the effective view and fail closed
  // instead of claiming a custom server policy is the requested preset.
  const defaults: Record<string, unknown> = { networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false, writableRoots: [] };
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every(key => canonical(actual[key] ?? defaults[key]) === canonical(expected[key] ?? defaults[key]));
}
export function accessTurnOverrides(policy: AccessPolicy, cwd?: string | null, writableRoot?: string): { approvalPolicy: string; sandboxPolicy: Record<string, unknown> } {
  return { approvalPolicy: policy.approval_policy, sandboxPolicy: policy.sandbox === "read_only" ? { type: "readOnly" }
    : policy.sandbox === "full_access" ? { type: "dangerFullAccess" }
    : { type: "workspaceWrite", writableRoots: [...new Set([cwd, writableRoot].filter((value): value is string => Boolean(value)))], networkAccess: true } };
}
