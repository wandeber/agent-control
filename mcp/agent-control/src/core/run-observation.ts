import { conversationWaitContract } from "./conversation-wait.js";
import { compactFlowEvent } from "./flow-event-summary.js";
import type { AgentController } from "./controller.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { ObserverCursors } from "../storage/observer-cursors.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { ControllerError } from "./errors.js";
import { resolveAdminKey, verifyAdminKey } from "./identity.js";
import { EVENT_TYPES, type AgentRecord, type EventRecord, type EventType } from "./types.js";

// Match the complete subscription before applying the event batch limit. Owner subscriptions may be source-scoped.
const MATCHING_OBSERVER_SUBSCRIPTION = `exists (
  select 1 from subscriptions s
  where s.enabled = 1 and (s.subscriber_agent_id = ? or s.subscriber_agent_id in (select value from json_each(?)))
    and (? = 1 or exists (
      select 1 from observer_subscriptions os
      where os.subscription_id = s.subscription_id and os.observer_agent_id = s.subscriber_agent_id
    ))
    and s.event_type = e.type
    and (s.run_id is null or s.run_id = e.run_id)
    and (s.source_agent_id is null or s.source_agent_id = e.agent_id)
)`;

export const DEFAULT_OBSERVER_EVENTS: EventType[] = [...EVENT_TYPES];

export interface ObserveRunInput {
  runId: string;
  threadId?: string;
  title?: string;
  eventTypes?: EventType[];
  delivery?: "wait" | "notify";
  adminKey?: string | null;
  agentToken?: string | null;
}

export interface RequesterInput {
  requesterThreadId?: string;
  requesterEventTypes?: EventType[];
  requesterDelivery?: "wait" | "notify";
}

export interface WaitRunInput {
  runId: string;
  observerAgentId: string;
  cursor?: string;
  timeoutMs?: number;
  limit?: number;
  signal?: AbortSignal;
  intervalMs?: number;
}

export interface AcknowledgeRunInput {
  runId: string;
  observerAgentId: string;
  cursor: string;
  adminKey?: string | null;
  agentToken?: string | null;
}

interface ObserverRow {
  observer_agent_id: string;
  run_id: string;
  thread_id: string;
  events_json: string;
  delivery: "wait" | "notify";
  start_sequence: number;
}

export function isPassiveObserver(agent: AgentRecord): boolean {
  return agent.role === "observer" && agent.backend === "codex-thread" && agent.backend_handle?.agent_control_role === "observer";
}

export class RunObservation {
  private cursors: ObserverCursors;
  constructor(private store: SqliteStore, private controller: AgentController, private adapters: AdapterRegistry) {
    this.cursors = new ObserverCursors(store.db);
  }

  /** The first requester remains stable when a worker launches nested work. */
  requesterThread(runId: string, visited = new Set<string>()): string | undefined {
    if (visited.has(runId)) return undefined;
    visited.add(runId);
    const binding = this.store.db.prepare("select thread_id from run_requesters where run_id = ?").get(runId) as { thread_id: string } | undefined;
    if (binding) return binding.thread_id;
    // Existing runs predate the explicit requester binding.
    const first = this.store.db.prepare("select thread_id from run_observers where run_id = ? order by created_at, rowid limit 1").get(runId) as { thread_id: string } | undefined;
    if (first) return first.thread_id;
    const parent = this.store.getRun(runId)?.parent_run_id;
    return parent ? this.requesterThread(parent, visited) : undefined;
  }

  ensure(runId: string, input: RequesterInput & { agentToken?: string | null; adminKey?: string | null } = {}) {
    const caller = input.agentToken ? this.controller.requireAgentToken(input.agentToken) : null;
    const threadId = input.requesterThreadId ?? this.requesterThread(runId) ??
      (caller ? this.requesterThread(caller.run_id) : undefined) ??
      process.env.AGENT_CONTROL_REQUESTER_THREAD_ID ?? process.env.CODEX_THREAD_ID;
    // Headless/non-Codex callers have no conversation to fabricate.
    if (!threadId) return null;
    return this.observe({ runId, threadId, eventTypes: input.requesterEventTypes,
      delivery: input.requesterDelivery, agentToken: input.agentToken,
      adminKey: input.adminKey ?? (caller ? undefined : resolveAdminKey()) });
  }

  listPublic(runId: string) {
    return (this.store.db.prepare("select o.* from run_observers o join agents a on a.agent_id = o.observer_agent_id where o.run_id = ? and a.unregistered_at is null").all(runId) as ObserverRow[])
      .map((observer) => ({ observer_agent_id: observer.observer_agent_id, run_id: observer.run_id,
        event_types: this.eventTypes(observer.observer_agent_id), delivery: observer.delivery }));
  }

  isAttached(agentId: string): boolean {
    return Boolean(this.store.db.prepare("select 1 from run_observers where observer_agent_id = ?").get(agentId));
  }

  coversEvent(agentId: string, event: EventRecord): boolean {
    if (!event.run_id) return false;
    const observers = this.store.db.prepare(`select o.observer_agent_id from run_observers o
      where o.run_id = ? and (o.observer_agent_id = ? or exists (
        select 1 from observer_owners owners where owners.observer_agent_id = o.observer_agent_id and owners.orchestrator_agent_id = ?
      ))`).all(event.run_id, agentId, agentId) as Array<{ observer_agent_id: string }>;
    return observers.some(observer => {
      const agent = this.store.getAgent(observer.observer_agent_id);
      if (!agent || agent.unregistered_at) return false;
      const owners = this.observationOwners(agent, event.run_id!);
      if (agent.agent_id !== agentId && !owners.includes(agentId)) return false;
      return Boolean(this.store.db.prepare(`select 1 from events e where e.event_id = ? and ${MATCHING_OBSERVER_SUBSCRIPTION}`)
        .get(event.event_id, agent.agent_id, JSON.stringify(owners), owners.length ? 1 : 0));
    });
  }

  /** Cross-run cursors retain authenticated ownership without promoting the observer. */
  private observationOwners(agent: AgentRecord, runId: string): string[] {
    const ownIdentity = agent.role === "orchestrator" ? [agent.agent_id] : [];
    const rows = this.store.db.prepare("select orchestrator_agent_id from observer_owners where observer_agent_id = ?")
      .all(agent.agent_id) as Array<{ orchestrator_agent_id: string }>;
    const additionalOwners = rows.filter(row => {
      const owner = this.store.getAgent(row.orchestrator_agent_id);
      return owner && !owner.unregistered_at && owner.role === "orchestrator" && owner.backend === "codex-thread" &&
        owner.backend_handle?.thread_id === agent.backend_handle?.thread_id && this.controller.canAgentAccessRun(owner, runId);
    }).map(row => row.orchestrator_agent_id);
    return [...new Set([...ownIdentity, ...additionalOwners])];
  }

  ownsSubscription(subscriptionId: string): boolean {
    return Boolean(this.store.db.prepare("select 1 from observer_subscriptions where subscription_id = ?").get(subscriptionId));
  }

  observe(input: ObserveRunInput) {
    const caller = input.agentToken ? this.controller.requireAgentToken(input.agentToken) : null;
    if (caller ? !this.controller.canAgentAccessRun(caller, input.runId) : !input.adminKey || !verifyAdminKey(input.adminKey)) {
      throw new ControllerError("Run observation requires an authorized run identity.", "auth_required");
    }
    const run = this.controller.getRun(input.runId);
    const threadId = (input.threadId ?? process.env.CODEX_THREAD_ID)?.trim();
    if (!threadId || threadId.length > 256 || /[\r\n\0]/.test(threadId)) {
      throw new ControllerError("Run observation requires the actual Codex thread id.", "tool_error");
    }
    const previousObservation = this.store.db.prepare("select * from run_observers where run_id = ? and thread_id = ?").get(run.run_id, threadId) as ObserverRow | undefined;
    const events = [...new Set(input.eventTypes ?? (previousObservation ? JSON.parse(previousObservation.events_json) as EventType[] : DEFAULT_OBSERVER_EVENTS))];
    if (!events.length || events.some((type) => !(EVENT_TYPES as readonly string[]).includes(type))) {
      throw new ControllerError("Select at least one supported observation event.", "tool_error");
    }
    const delivery = input.delivery ?? previousObservation?.delivery ?? "wait";
    if (delivery !== "wait" && delivery !== "notify") throw new ControllerError("Invalid observation delivery mode.", "tool_error");
    this.adapters.get("codex-thread");
    return this.store.immediateTransaction(() => {
      const previous = this.store.db.prepare("select * from run_observers where run_id = ? and thread_id = ?").get(run.run_id, threadId) as ObserverRow | undefined;
      let agent = previous ? this.controller.getAgent(previous.observer_agent_id) : this.controller.listAgents({ runId: run.run_id }).find((candidate) =>
        !candidate.unregistered_at && candidate.backend === "codex-thread" &&
        candidate.backend_handle?.thread_id === threadId && (candidate.role === "orchestrator" || isPassiveObserver(candidate))
      );
      if (agent?.unregistered_at) throw new ControllerError("The observing participant has been detached.", "tool_error");
      if (!agent) {
        agent = this.store.createAgent({ runId: run.run_id, backend: "codex-thread", title: input.title ?? "User conversation",
          role: "observer", status: "waiting_for_input", repoDir: run.repo_dir,
          backendHandle: { thread_id: threadId, agent_control_role: "observer", cwd: run.repo_dir } });
      }
      this.store.db.prepare("insert or ignore into run_requesters(run_id, thread_id) values (?, ?)").run(run.run_id, threadId);
      const start = previous?.start_sequence ?? this.currentSequence();
      this.store.db.prepare(`insert into run_observers(observer_agent_id, run_id, thread_id, events_json, delivery, start_sequence, created_at)
        values (?, ?, ?, ?, ?, ?, ?) on conflict(observer_agent_id) do update set events_json = excluded.events_json, delivery = excluded.delivery`)
        .run(agent.agent_id, run.run_id, threadId, JSON.stringify(events), delivery, start, new Date().toISOString());
      // This private binding comes only from the authenticated owner, never public backend metadata.
      if (caller?.role === "orchestrator" && caller.backend === "codex-thread" &&
          caller.backend_handle?.thread_id === threadId && caller.agent_id !== agent.agent_id) {
        this.store.db.prepare("insert or ignore into observer_owners values (?, ?)").run(agent.agent_id, caller.agent_id);
      }
      const existing = this.store.db.prepare(`select s.* from subscriptions s join observer_subscriptions o using(subscription_id)
        where o.observer_agent_id = ?`).all(agent.agent_id) as Array<{ subscription_id: string; event_type: EventType }>;
      for (const sub of existing) if (!events.includes(sub.event_type)) this.store.deleteSubscription(sub.subscription_id);
      for (const eventType of events) {
        if (existing.some((sub) => sub.event_type === eventType)) continue;
        const sub = this.store.createSubscription({ runId: run.run_id, subscriberAgentId: agent.agent_id, eventType });
        this.store.db.prepare("insert into observer_subscriptions values (?, ?)").run(sub.subscription_id, agent.agent_id);
      }
      const state = this.cursors.state(agent.agent_id, start);
      const cursor = this.cursors.encode(run.run_id, agent.agent_id, state.processed_sequence, state);
      return { run_id: run.run_id, observer_agent_id: agent.agent_id, thread_id: threadId, event_types: events,
        delivery, cursor, processed_cursor: cursor,
        delivered_cursor: this.cursors.encode(run.run_id, agent.agent_id, state.delivered_sequence, state),
        reused: Boolean(previous), wait_contract: conversationWaitContract(run.run_id, agent.agent_id) };
    });
  }

  acknowledge(input: AcknowledgeRunInput) {
    return this.store.immediateTransaction(() => {
      const observer = this.store.db.prepare("select * from run_observers where observer_agent_id = ? and run_id = ?")
        .get(input.observerAgentId, input.runId) as ObserverRow | undefined;
      const agent = this.store.getAgent(input.observerAgentId);
      if (!observer || !agent || agent.unregistered_at) throw new ControllerError("The observing participant is not attached to this run.", "tool_error");
      const caller = input.agentToken ? this.controller.requireAgentToken(input.agentToken) : null;
      const authorized = caller
        ? this.controller.canAgentAccessRun(caller, input.runId) && (caller.agent_id === agent.agent_id || this.observationOwners(agent, input.runId).includes(caller.agent_id))
        : input.adminKey ? verifyAdminKey(input.adminKey)
          // The local MCP/CLI host supplies this identity; explicit credentials never fall back to it.
          : process.env.CODEX_THREAD_ID === observer.thread_id;
      if (!authorized) throw new ControllerError("Acknowledgement requires the observing identity or an authorized administrator.", "auth_required");
      const state = this.cursors.state(agent.agent_id, observer.start_sequence);
      const sequence = this.cursors.decode(input.cursor, input.runId, agent.agent_id, state);
      if (sequence < observer.start_sequence) throw new ControllerError("Observation cursor precedes this subscription.", "tool_error");
      const advanced = this.cursors.acknowledge(agent.agent_id, sequence, state);
      const cursor = this.cursors.encode(input.runId, agent.agent_id, Math.max(sequence, state.processed_sequence), state);
      return { run_id: input.runId, observer_agent_id: agent.agent_id, cursor, processed_cursor: cursor, advanced,
        wait_contract: conversationWaitContract(input.runId, agent.agent_id) };
    });
  }

  async wait(input: WaitRunInput) {
    let sequence: number | undefined;
    let requestedCursor = input.cursor ?? "";
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
      throw new ControllerError("Observation timeout must be a positive duration.", "tool_error");
    }
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const started = Date.now();
    const empty = (timedOut: boolean, closed: boolean) => ({ run_id: input.runId, observer_agent_id: input.observerAgentId,
      events: [] as ReturnType<typeof publicEvent>[], cursor: requestedCursor, timed_out: timedOut, closed,
      wait_contract: closed ? null : conversationWaitContract(input.runId, input.observerAgentId) });
    while (true) {
      input.signal?.throwIfAborted();
      const observer = this.store.db.prepare("select * from run_observers where observer_agent_id = ? and run_id = ?")
        .get(input.observerAgentId, input.runId) as ObserverRow | undefined;
      const run = this.store.getRun(input.runId);
      const agent = this.store.getAgent(input.observerAgentId);
      if (!observer || !run || !agent || agent.unregistered_at) return empty(false, true);
      const state = this.cursors.state(agent.agent_id, observer.start_sequence);
      if (sequence === undefined) {
        requestedCursor = input.cursor ?? this.cursors.encode(input.runId, agent.agent_id, state.processed_sequence, state);
        sequence = this.cursors.decode(requestedCursor, input.runId, agent.agent_id, state, true);
      }
      if (sequence < observer.start_sequence || sequence > this.currentSequence()) {
        throw new ControllerError("Observation cursor is outside this subscription's history.", "tool_error");
      }
      const owners = this.observationOwners(agent, input.runId);
      const types = this.eventTypes(observer.observer_agent_id);
      if (!types.length) return empty(false, true);
      const rows = this.store.db.prepare(`select e.*, o.sequence from events e join event_order o using(event_id)
        where e.run_id = ? and o.sequence > ? and ${MATCHING_OBSERVER_SUBSCRIPTION}
        order by o.sequence limit ?`).all(input.runId, sequence, agent.agent_id, JSON.stringify(owners), owners.length ? 1 : 0, limit) as Array<Record<string, unknown>>;
      if (rows.length) {
        const deliveredSequence = Number(rows.at(-1)!.sequence);
        this.cursors.delivered(agent.agent_id, sequence, deliveredSequence);
        const cursor = this.cursors.encode(input.runId, agent.agent_id, deliveredSequence, state);
        return { run_id: input.runId, observer_agent_id: input.observerAgentId,
          events: rows.map((row) => publicEvent({ event_id: String(row.event_id), run_id: input.runId,
            agent_id: row.agent_id === null ? null : String(row.agent_id), type: String(row.type) as EventType,
            created_at: String(row.created_at), payload: JSON.parse(String(row.payload_json)) }, owners, this.notificationStatus(agent.agent_id, String(row.event_id)))),
          cursor, processed_cursor: this.cursors.encode(input.runId, agent.agent_id, state.processed_sequence, state),
          ack_contract: { tool: "run_ack" as const, arguments: { run_id: input.runId, observer_agent_id: agent.agent_id, cursor },
            instruction: "After successfully handling all events through this cursor, acknowledge them explicitly. Fetching or receiving a notification does not acknowledge processing." },
          timed_out: false, closed: false, wait_contract: conversationWaitContract(input.runId, input.observerAgentId) };
      }
      if (run.status === "stopped") return empty(false, true);
      const remaining = input.timeoutMs === undefined ? Infinity : input.timeoutMs - (Date.now() - started);
      if (remaining <= 0) return empty(true, false);
      // Refresh workers in deterministic code; the observing conversation itself is never polled or restarted.
      await this.controller.pollActiveAgents(input.runId);
      await cancellableDelay(Math.min(input.intervalMs ?? 1000, remaining), input.signal);
    }
  }

  async notify(event: EventRecord): Promise<void> {
    if (!event.run_id) return;
    const observers = this.store.db.prepare("select * from run_observers where run_id = ? and delivery = 'notify' and start_sequence < (select sequence from event_order where event_id = ?)").all(event.run_id, event.event_id) as ObserverRow[];
    for (const observer of observers) {
      const agent = this.store.getAgent(observer.observer_agent_id);
      if (!agent || agent.unregistered_at) continue;
      const owners = this.observationOwners(agent, event.run_id);
      const matches = this.store.db.prepare(`select 1 from events e where e.event_id = ? and ${MATCHING_OBSERVER_SUBSCRIPTION}`)
        .get(event.event_id, agent.agent_id, JSON.stringify(owners), owners.length ? 1 : 0);
      if (!matches) continue;
      const claim = this.store.db.prepare("insert or ignore into observer_notifications values (?, ?, 'invoking')").run(agent.agent_id, event.event_id);
      if (!claim.changes) continue;
      try {
        const adapter = this.adapters.get(agent.backend);
        if (!adapter.stageNotification || !agent.backend_handle) throw new Error("Notification staging unavailable");
        const item = publicEvent(event, owners);
        await adapter.stageNotification({ backend: agent.backend, id: observer.thread_id, data: agent.backend_handle }, {
          message: `Agent Control observation\nRun: ${event.run_id}\nObserver: ${agent.agent_id}\nEvent ID: ${event.event_id}\n${item.summary}\n` +
            (owners.length
              ? `You remain the workflow owner. React to configured notifications using the existing run and flow. Safe action reference: ${JSON.stringify(item.orchestrator_action ?? null)}. Never restart the flow.`
              : "This is an observation for the user's conversation. Give a concise update when useful. The workflow owner retains routing and native-action authority; do not claim or execute its actions.")
        });
        this.store.db.prepare("update observer_notifications set status = 'injected' where observer_agent_id = ? and event_id = ?").run(agent.agent_id, event.event_id);
      } catch {
        // An uncertain injection is never retried automatically: the durable event remains available to run_wait.
        this.store.db.prepare("update observer_notifications set status = 'failed' where observer_agent_id = ? and event_id = ?").run(agent.agent_id, event.event_id);
      }
    }
  }

  private notificationStatus(agentId: string, eventId: string): string | undefined {
    return (this.store.db.prepare("select status from observer_notifications where observer_agent_id = ? and event_id = ?").get(agentId, eventId) as { status: string } | undefined)?.status;
  }

  private eventTypes(agentId: string): EventType[] {
    const agent = this.store.getAgent(agentId);
    if (!agent) return [];
    const owners = this.observationOwners(agent, agent.run_id);
    // Include operational owner subscriptions even when the conversation requests fewer updates.
    const rows = this.store.db.prepare(`select s.event_type from subscriptions s where s.enabled = 1
      and (s.run_id is null or s.run_id = ?) and (
        s.subscriber_agent_id in (select value from json_each(?)) or exists (
          select 1 from observer_subscriptions o where o.subscription_id = s.subscription_id and o.observer_agent_id = ?
        )
      )`).all(agent.run_id, JSON.stringify(owners), agentId);
    return [...new Set((rows as Array<{ event_type: EventType }>).map((row) => row.event_type))];
  }

  private currentSequence(): number {
    const row = this.store.db.prepare("select seq from sqlite_sequence where name = 'event_order'").get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }
}

function publicEvent(event: EventRecord, owners: string[] = [], notificationStatus?: string) {
  const action = event.payload.orchestrator_action as Record<string, unknown> | undefined;
  const ownerAction = typeof action?.orchestrator_agent_id === "string" && owners.includes(action.orchestrator_agent_id)
    ? Object.fromEntries(["action_id", "run_id", "orchestrator_agent_id", "agent_id", "operation", "status", "flow_instance_id", "step_instance_id"].filter((key) => action[key] !== undefined).map((key) => [key, action[key]]))
    : undefined;
  const phase = typeof event.payload.step_id === "string" ? event.payload.step_id : typeof event.payload.target_step_id === "string" ? event.payload.target_step_id : undefined;
  const flow = typeof event.payload.flow_instance_id === "string" ? event.payload.flow_instance_id : undefined;
  return { event_id: event.event_id, type: event.type, created_at: event.created_at, agent_id: event.agent_id,
    ...compactFlowEvent(event),
    summary: `${event.type.replace(/[._]/g, " ")}${phase ? `: ${phase}` : ""}`,
    ...(flow ? { flow_instance_id: flow } : {}), ...(phase ? { step_id: phase } : {}),
    ...(ownerAction ? { orchestrator_action: ownerAction } : {}), ...(notificationStatus ? { notification_status: notificationStatus } : {}) };
}

function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Observation cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
