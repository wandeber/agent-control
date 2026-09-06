import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { FlowConfig } from "./types.js";
import { ControllerError } from "./errors.js";

export interface FlowRuntimeState {
  revision: number;
  acceptance_revision: number;
  context: string | null;
  context_history: Array<{ revision: number; text: string; actor_id: string | null }>;
  config_digest: string;
  state: Record<string, unknown>;
  decision_owners?: { requester: string | null; orchestrator: string | null };
  decisions: Record<string, { value: unknown; reason: string; actor_id: string; authority?: "user" | "coordinator"; source?: "user_reply" | "coordinator_review"; acceptance_revision: number; artifact_key?: string; artifact_digest?: string }>;
  evidence: Record<string, string>;
  evidence_summaries?: Record<string, { receipt_id: string; kind: string; status: string; step_instance_id?: string; acceptance_revision?: number; summary: Record<string, unknown> }>;
  owners: Record<string, string>;
  artifacts?: Record<string, { path: string; sha256: string; snapshot_path: string; produced_by_step_instance_id: string }>;
  correction: Record<string, unknown> | null;
  recovery?: { request_digest: string; role: string; previous_agent_id: string; agent_id: string; reason: string; restart_step_id: string; full_review_required: boolean };
}

export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function artifactDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Snapshot resolved prompt bytes with the configuration, not a mutable path read at dispatch. */
export function pinFlowConfig(config: FlowConfig): FlowConfig {
  const pinned = structuredClone(config);
  if (!config.policy?.strict) return pinned;
  for (const prompt of Object.values(pinned.prompts ?? {})) {
    if (prompt.path) { prompt.text = readFileSync(prompt.path, "utf8"); delete prompt.path; }
  }
  for (const source of [...Object.values(pinned.roles ?? {}), ...Object.values(pinned.steps)]) {
    if (source.prompt_path) { source.prompt = readFileSync(source.prompt_path, "utf8"); delete source.prompt_path; }
  }
  return pinned;
}

export class FlowRuntime {
  constructor(private store: SqliteStore) {
    store.db.exec(`create table if not exists flow_runtime (
      flow_instance_id text primary key references flow_instances(flow_instance_id) on delete cascade,
      state_json text not null);
      create table if not exists flow_report_capabilities (
      step_instance_id text primary key references flow_step_instances(step_instance_id) on delete cascade,
      token text not null, request_digest text, response_json text);
      create table if not exists flow_runtime_history (
      flow_instance_id text not null references flow_instances(flow_instance_id) on delete cascade,
      revision integer not null, state_json text not null, primary key(flow_instance_id,revision));`);
  }
  get(id: string): FlowRuntimeState | null {
    const row = this.store.db.prepare("select state_json from flow_runtime where flow_instance_id = ?").get(id) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as FlowRuntimeState : null;
  }
  initialize(id: string, config: FlowConfig, context: string | null = null): FlowRuntimeState {
    const state: FlowRuntimeState = { revision: 0, acceptance_revision: 0, context, context_history: context ? [{ revision: 0, text: context, actor_id: null }] : [],
      config_digest: digest(config), state: structuredClone(config.state ?? {}), decisions: {}, evidence: {}, owners: {}, correction: null };
    this.save(id, state);
    return state;
  }
  save(id: string, state: FlowRuntimeState): void {
    this.store.db.prepare("insert into flow_runtime values (?,?) on conflict(flow_instance_id) do update set state_json=excluded.state_json").run(id, JSON.stringify(state));
    this.store.db.prepare("insert into flow_runtime_history values (?,?,?) on conflict(flow_instance_id,revision) do update set state_json=excluded.state_json").run(id, state.revision, JSON.stringify(state));
  }
  changeContext(id: string, text: string, actorId: string | null, expectedRevision?: number): FlowRuntimeState {
    const state = this.get(id)!;
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new ControllerError("Flow context revision changed; read the current state before retrying.", "tool_error");
    state.revision += 1;
    state.acceptance_revision += 1;
    state.context_history.push({ revision: state.acceptance_revision, text, actor_id: actorId });
    state.context = text;
    // Historical approvals remain auditable; guards exclude approvals from prior acceptance revisions.
    this.save(id, state);
    return state;
  }
  capability(stepId: string): string {
    let row = this.store.db.prepare("select token from flow_report_capabilities where step_instance_id=?").get(stepId) as { token: string } | undefined;
    if (!row) {
      const token = randomBytes(32).toString("hex");
      this.store.db.prepare("insert into flow_report_capabilities(step_instance_id,token) values (?,?)").run(stepId, token);
      row = { token };
    }
    return row.token;
  }
  verifyCapability(stepId: string, token?: string): void {
    if (!token || token !== this.capability(stepId)) throw new ControllerError("This report requires the assigned worker's authenticated local identity.", "auth_required");
  }
  replay<T>(stepId: string, requestDigest: string): T | null {
    const row = this.store.db.prepare("select request_digest,response_json from flow_report_capabilities where step_instance_id=?").get(stepId) as { request_digest: string | null; response_json: string | null } | undefined;
    if (!row?.request_digest) return null;
    if (row.request_digest !== requestDigest) throw new ControllerError("A different report already committed for this step generation.", "tool_error");
    return JSON.parse(row.response_json!) as T;
  }
  recordResponse(stepId: string, requestDigest: string, response: unknown): void {
    this.capability(stepId);
    this.store.db.prepare("update flow_report_capabilities set request_digest=?,response_json=? where step_instance_id=?").run(requestDigest, JSON.stringify(response), stepId);
  }
}
