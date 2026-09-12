import { PermissionRequests, permissionOwnerMatches } from "./permission-requests.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { AgentRecord, EventRecord } from "./types.js";
import type { FlowRuntimeState } from "./flow-runtime.js";

export function sessionObservationKey(agent: AgentRecord): string {
  return JSON.stringify([agent.work_generation, agent.work_revision, agent.backend_handle]);
}

export type RunWakeOn = "control" | "all";
export interface RunCompletion {
  outcome: "completed" | "failed" | "cancelled";
  run_count: number;
  worker_count: number;
  flow_count: number;
}

const TERMINAL = new Set(["completed", "failed", "stopped"]);
const ROUTING = new Set(["agent.completed", "agent.failed", "agent.blocked", "agent.stopped",
  "agent.delivery_failed", "flow.step_reported", "flow.step_blocked", "flow.completed",
  "goal.confirmation_requested", "goal.completed", "goal.continued", "goal.blocked", "heartbeat.timeout"]);
const INFORMATIONAL = new Set(["package_progress", "package_started", "packages_defined", "acceptance_updated", "evidence_recorded"]);

/** Subscriptions retain full history; this policy decides when the waiting model is needed. */
export class RunWakePolicy {
  constructor(private store: SqliteStore) {}

  private runtime(flowId: string): FlowRuntimeState | null {
    const row = this.store.db.prepare("select state_json from flow_runtime where flow_instance_id = ?")
      .get(flowId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) : null;
  }

  runIds(runId: string): string[] {
    return (this.store.db.prepare(`with recursive tree(run_id) as (
      select run_id from runs where run_id = ? union select r.run_id from runs r join tree t on r.parent_run_id = t.run_id
    ) select run_id from tree`).all(runId) as Array<{ run_id: string }>).map(row => row.run_id);
  }

  completion(runId: string): RunCompletion | null {
    const ids = this.runIds(runId);
    let workers = 0, flows = 0, failed = false, cancelled = false;
    for (const id of ids) {
      const priorWorkers = workers;
      const run = this.store.getRun(id)!;
      if (run.status === "stopping") return null;
      cancelled ||= run.status === "stopped";
      const instances = this.store.listFlowInstances({ runId: id });
      const unusedRoles = new Set<string>();
      const resolvedFlowWorkers = new Set<string>();
      for (const instance of instances) {
        if (instance.status !== "completed" && instance.status !== "cancelled") return null;
        cancelled ||= instance.status === "cancelled";
        for (const owner of Object.values(this.runtime(instance.flow_instance_id)?.owners ?? {})) unusedRoles.add(owner);
        if (instance.status === "completed") {
          for (const owner of Object.values(this.runtime(instance.flow_instance_id)?.owners ?? {})) resolvedFlowWorkers.add(owner);
          for (const step of this.store.listFlowStepInstances(instance.flow_instance_id)) if (step.agent_id) resolvedFlowWorkers.add(step.agent_id);
        }
      }
      flows += instances.length;
      if (this.store.listOrchestratorActions({ runId: id }).some(action => action.status === "pending" || action.status === "claimed")) return null;
      for (const agent of this.store.listAgents({ runId: id })) {
        if (!agent.unregistered_at && this.store.listGoals(agent.agent_id).some(goal => !["complete", "cancelled"].includes(goal.status))) return null;
        // Attached external sessions are real work. Only conversation/coordinator identities are passive.
        if (agent.unregistered_at || agent.role === "observer" || agent.role === "orchestrator") continue;
        const attempt = this.store.getLatestAgentStartAttempt(agent.agent_id);
        if (attempt && ["prepared", "invoking", "ambiguous"].includes(attempt.phase)) return null;
        if (agent.status === "planned" && !agent.backend_handle && agent.work_generation === 0 && unusedRoles.has(agent.agent_id)) continue;
        workers++;
        if (!TERMINAL.has(agent.status)) return null;
        // Recovered attempts remain visible in history; the completed flow owns their final outcome.
        failed ||= agent.status === "failed" && !resolvedFlowWorkers.has(agent.agent_id);
        cancelled ||= agent.status === "stopped" && !resolvedFlowWorkers.has(agent.agent_id);
      }
      if (workers === priorWorkers && !instances.length && run.status !== "stopped" &&
          !ids.some(child => this.store.getRun(child)?.parent_run_id === id)) return null;
    }
    // A freshly created run may still be registering its first workers.
    if (!workers && !flows) return null;
    return { outcome: failed ? "failed" : cancelled ? "cancelled" : "completed",
      run_count: ids.length, worker_count: workers, flow_count: flows };
  }

  wakes(event: EventRecord, observer: AgentRecord, owners: string[]): boolean {
    const payload = event.payload;
    const sameThread = (id: string | null | undefined) => {
      const agent = id ? this.store.getAgent(id) : null;
      return Boolean(agent && !agent.unregistered_at && agent.backend_handle?.thread_id &&
        agent.backend_handle.thread_id === observer.backend_handle?.thread_id);
    };
    const operational = owners.length > 0 || sameThread(this.store.getRun(observer.run_id)?.created_by_agent_id) ||
      this.store.listFlowInstances({ runId: observer.run_id }).some(flow =>
        this.store.listFlowStepInstances(flow.flow_instance_id).some(step => step.status === "active" && sameThread(step.agent_id)));
    const needsInput = event.type === "agent.status_changed" && ["waiting_for_input", "blocked"].includes(String(payload.status)) &&
      Boolean(event.agent_id && !["observer", "orchestrator"].includes(this.store.getAgent(event.agent_id)?.role ?? ""));
    if (event.type === "agent.status_changed" && payload.permission_state === "pending" && typeof payload.permission_request_id === "string") {
      const request = new PermissionRequests(this.store.db).get(payload.permission_request_id);
      const agent = event.agent_id ? this.store.getAgent(event.agent_id) : null;
      if (request?.state !== "pending" || !agent || agent.unregistered_at || request.agent_id !== agent.agent_id || !permissionOwnerMatches(agent, request)) return false;
      const requester = this.store.db.prepare("select thread_id from run_requesters where run_id=?").get(event.run_id ?? observer.run_id) as { thread_id: string } | undefined;
      return operational || requester?.thread_id === observer.backend_handle?.thread_id;
    }
    if (event.type === "flow.notification") {
      if (payload.reason === "coordinator_gate") {
        const flowId = typeof payload.flow_instance_id === "string" ? payload.flow_instance_id : undefined;
        const stepId = typeof payload.step_instance_id === "string" ? payload.step_instance_id : undefined;
        // Do not request an obsolete approval from a previous phase generation.
        if (stepId && this.store.getFlowStepInstance(stepId)?.status !== "active") return false;
        const decision = payload.decision as { owner?: "requester" | "orchestrator" } | undefined;
        const owner = decision?.owner ?? "orchestrator";
        const binding = flowId ? this.runtime(flowId)?.decision_owners?.[owner] : undefined;
        if (binding) {
          const identity = this.store.getAgent(binding);
          return binding === observer.agent_id || owners.includes(binding) || Boolean(identity?.backend_handle?.thread_id &&
            identity.backend_handle.thread_id === observer.backend_handle?.thread_id);
        }
        if (owner === "requester") {
          const requester = this.store.db.prepare("select thread_id from run_requesters where run_id = ?").get(event.run_id ?? observer.run_id) as { thread_id: string } | undefined;
          return requester?.thread_id === observer.backend_handle?.thread_id;
        }
        return operational;
      }
      const action = payload.orchestrator_action as { orchestrator_agent_id?: string } | undefined;
      if (action) return Boolean(action.orchestrator_agent_id && owners.includes(action.orchestrator_agent_id));
      return operational && !INFORMATIONAL.has(String(payload.reason));
    }
    if (operational) return ROUTING.has(event.type) || needsInput;
    if (event.type === "flow.step_blocked") return true;
    if (needsInput || ["agent.failed", "agent.blocked", "agent.delivery_failed", "goal.blocked", "heartbeat.timeout"].includes(event.type)) {
      // A flow's coordinator handles worker failures first; an unresolved flow blocker is delivered separately.
      return !this.store.listFlowInstances({ runId: observer.run_id }).some(flow => flow.status === "active" &&
        (Object.values(this.runtime(flow.flow_instance_id)?.owners ?? {}).includes(event.agent_id ?? "") ||
          this.store.listFlowStepInstances(flow.flow_instance_id).some(step => step.agent_id === event.agent_id)));
    }
    return false;
  }

  /** A conversation attaching at an existing gate must not miss the event that opened it. */
  initialSequence(runId: string, observer: AgentRecord, owners: string[], current: number): number {
    const rows = this.store.db.prepare(`select e.*, o.sequence from events e join event_order o using(event_id)
      left join flow_step_instances s on s.step_instance_id = json_extract(e.payload_json, '$.step_instance_id')
      where e.run_id in (select value from json_each(?)) and ((e.type = 'flow.notification' and s.status = 'active' and json_extract(e.payload_json, '$.reason') = 'coordinator_gate')
        or (e.type = 'agent.status_changed' and json_extract(e.payload_json, '$.permission_state') = 'pending')) order by o.sequence`).all(JSON.stringify(this.runIds(runId))) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (String(row.run_id) !== runId && !this.store.db.prepare("select 1 from run_observers where run_id = ? and thread_id = ?")
        .get(String(row.run_id), String(observer.backend_handle?.thread_id ?? ""))) continue;
      const event: EventRecord = { event_id: String(row.event_id), run_id: String(row.run_id), agent_id: row.agent_id ? String(row.agent_id) : null,
        type: String(row.type) as EventRecord["type"], created_at: String(row.created_at), payload: JSON.parse(String(row.payload_json)) };
      if (this.wakes(event, observer, owners)) return Math.max(0, Number(row.sequence) - 1);
    }
    return current;
  }
}
