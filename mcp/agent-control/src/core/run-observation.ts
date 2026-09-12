import { currentCodexThreadId } from "./caller-context.js";
import { readCodexSession, sessionBaseline } from "../adapters/codex-session.js";
import { RunWakePolicy, sessionObservationKey, type RunWakeOn } from "./run-wake-policy.js";
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
  authorizeOperator?: boolean; // Internal provenance; never an MCP/CLI argument.
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
  wakeOn?: RunWakeOn;
}

export interface AcknowledgeRunInput {
  wakeOn?: RunWakeOn;
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
  private wakePolicy: RunWakePolicy;
  constructor(private store: SqliteStore, private controller: AgentController, private adapters: AdapterRegistry) {
    this.cursors = new ObserverCursors(store.db);
    this.wakePolicy = new RunWakePolicy(store);
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
      process.env.AGENT_CONTROL_REQUESTER_THREAD_ID ?? currentCodexThreadId();
    // Headless/non-Codex callers have no conversation to fabricate.
    if (!threadId) return null;
    // Child runs inherit only the verified operator of their actual parent.
    this.store.db.prepare(`insert or ignore into run_operator_bindings(run_id, thread_id)
      select r.run_id, b.thread_id from runs r join run_operator_bindings b on b.run_id=r.parent_run_id where r.run_id=?`).run(runId);
    const operator = this.store.db.prepare("select thread_id from run_operator_bindings where run_id=?").get(runId) as { thread_id: string } | undefined;
    return this.observe({ runId, threadId: operator?.thread_id ?? threadId, authorizeOperator: false, eventTypes: input.requesterEventTypes,
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
    const threadId = (input.threadId ?? currentCodexThreadId())?.trim();
    if (!threadId || threadId.length > 256 || /[\r\n\0]/.test(threadId)) {
      throw new ControllerError("Run observation requires the actual Codex thread id.", "tool_error");
    }
    // Launch already attached this conversation. Its authenticated local caller
    // identity can reattach its own cursor without exposing an administrator key.
    // Explicit invalid credentials and foreign identities never use this path.
    const ownObservation = !caller && !input.adminKey && threadId === currentCodexThreadId()
      ? this.store.db.prepare(`select 1 from run_observers o join agents a on a.agent_id = o.observer_agent_id
          where o.run_id = ? and o.thread_id = ? and a.unregistered_at is null`).get(input.runId, threadId)
      : null;
    const authorized = caller ? this.controller.canAgentAccessRun(caller, input.runId)
      : input.adminKey ? verifyAdminKey(input.adminKey) : Boolean(ownObservation);
    if (!authorized) throw new ControllerError("Run observation requires an authorized run identity.", "auth_required");
    const run = this.controller.getRun(input.runId);
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
          role: "observer", status: "waiting_for_input", repoDir: run.repo_dir, model: readCodexSession(threadId)?.model ?? null,
          backendHandle: { thread_id: threadId, agent_control_role: "observer", cwd: run.repo_dir } });
      }
      if (!previous && !agent.backend_handle?.usage_baseline) {
        const baseline = sessionBaseline(threadId);
        if (baseline) agent = this.store.updateAgent(agent.agent_id, {
          backendHandle: { ...agent.backend_handle, usage_baseline: baseline }
        });
      }
      this.store.db.prepare("insert or ignore into run_requesters(run_id, thread_id) values (?, ?)").run(run.run_id, threadId);
      // Observation alone never grants permission/canvas authority. Only a local
      // admin-authorized launch or explicit reattachment can pin the operator.
      if (input.authorizeOperator !== false && !caller && input.adminKey && verifyAdminKey(input.adminKey)) {
        this.store.db.prepare(`insert or ignore into run_operator_bindings(run_id, thread_id)
          select run_id, thread_id from run_requesters where run_id=? and thread_id=?`).run(run.run_id, threadId);
      }
      const start = previous?.start_sequence ?? this.wakePolicy.initialSequence(run.run_id, agent,
        this.observationOwners(agent, run.run_id), this.currentSequence());
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
          : currentCodexThreadId() === observer.thread_id;
      if (!authorized) throw new ControllerError("Acknowledgement requires the observing identity or an authorized administrator.", "auth_required");
      const state = this.cursors.state(agent.agent_id, observer.start_sequence);
      const sequence = this.cursors.decode(input.cursor, input.runId, agent.agent_id, state);
      if (sequence < observer.start_sequence) throw new ControllerError("Observation cursor precedes this subscription.", "tool_error");
      const advanced = this.cursors.acknowledge(agent.agent_id, sequence, state);
      const cursor = this.cursors.encode(input.runId, agent.agent_id, Math.max(sequence, state.processed_sequence), state);
      return { run_id: input.runId, observer_agent_id: agent.agent_id, cursor, processed_cursor: cursor, advanced,
        wait_contract: conversationWaitContract(input.runId, agent.agent_id, input.wakeOn) };
    });
  }

  async wait(input: WaitRunInput) {
    let sequence: number | undefined, fromSequence: number | undefined;
    let requestedCursor = input.cursor ?? "";
    const wakeOn = input.wakeOn ?? "control";
    if (wakeOn !== "control" && wakeOn !== "all") throw new ControllerError("Invalid run wait wake policy.", "tool_error");
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
      throw new ControllerError("Observation timeout must be a positive duration.", "tool_error");
    }
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const started = Date.now();
    const refreshedSessions = new Map<string, string>();
    const contract = () => conversationWaitContract(input.runId, input.observerAgentId, wakeOn);
    const empty = (timedOut: boolean, closed: boolean) => ({ run_id: input.runId, observer_agent_id: input.observerAgentId,
      events: [] as ReturnType<typeof publicEvent>[], cursor: requestedCursor, completion: null,
      timed_out: timedOut, closed, wait_contract: closed ? null : contract() });
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
        fromSequence = sequence = this.cursors.decode(requestedCursor, input.runId, agent.agent_id, state, true);
      }
      if (sequence < observer.start_sequence || sequence > this.currentSequence()) {
        throw new ControllerError("Observation cursor is outside this subscription's history.", "tool_error");
      }
      const owners = this.observationOwners(agent, input.runId);
      if (!this.eventTypes(observer.observer_agent_id).length) return empty(false, true);
      const runIds = this.wakePolicy.runIds(input.runId);
      const freshExternalSessions = runIds.every(id => this.store.listAgents({ runId: id }).every(candidate =>
        candidate.unregistered_at || candidate.backend !== "codex-session" || refreshedSessions.get(candidate.agent_id) === sessionObservationKey(candidate)));
      const settled = freshExternalSessions ? this.wakePolicy.completion(input.runId) : null;
      // Nested launches attach the same conversation to their own runs. Consume
      // only those authorized streams, keeping native action visibility per identity.
      const scopes = new Map<string, { agent: AgentRecord; owners: string[]; start: number }>();
      scopes.set(input.runId, { agent, owners, start: observer.start_sequence });
      for (const runId of this.wakePolicy.runIds(input.runId).filter(id => id !== input.runId)) {
        const attached = this.store.db.prepare("select observer_agent_id, start_sequence from run_observers where run_id = ? and thread_id = ?")
          .get(runId, observer.thread_id) as { observer_agent_id: string; start_sequence: number } | undefined;
        const participant = attached ? this.store.getAgent(attached.observer_agent_id) : null;
        if (participant && !participant.unregistered_at) scopes.set(runId, { agent: participant, owners: this.observationOwners(participant, runId), start: attached!.start_sequence });
      }
      const rows = [...scopes].flatMap(([runId, scope]) => this.store.db.prepare(`select e.*, o.sequence from events e join event_order o using(event_id)
        where e.run_id = ? and o.sequence > ? and ${MATCHING_OBSERVER_SUBSCRIPTION}
        order by o.sequence limit 100`).all(runId, Math.max(sequence!, scope.start), scope.agent.agent_id, JSON.stringify(scope.owners), scope.owners.length ? 1 : 0) as Array<Record<string, unknown>>)
        .sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(0, 100);
      const events: ReturnType<typeof publicEvent>[] = [];
      for (const row of rows) {
        sequence = Number(row.sequence);
        const scope = scopes.get(String(row.run_id))!;
        const event: EventRecord = { event_id: String(row.event_id), run_id: String(row.run_id),
          agent_id: row.agent_id === null ? null : String(row.agent_id), type: String(row.type) as EventType,
          created_at: String(row.created_at), payload: JSON.parse(String(row.payload_json)) };
        if (wakeOn === "all" || this.wakePolicy.wakes(event, scope.agent, scope.owners)) {
          events.push(publicEvent(event, scope.owners, this.notificationStatus(scope.agent.agent_id, event.event_id)));
          if (events.length === limit) break;
        }
      }
      // Filter before the effective batch limit. Skipped activity stays in history;
      // only an explicit ACK of this delivered range commits the observer's progress.
      const hasMore = [...scopes].some(([runId, scope]) => Boolean(this.store.db.prepare(`select 1 from events e join event_order o using(event_id)
        where e.run_id = ? and o.sequence > ? and ${MATCHING_OBSERVER_SUBSCRIPTION} limit 1`)
        .get(runId, Math.max(sequence!, scope.start), scope.agent.agent_id, JSON.stringify(scope.owners), scope.owners.length ? 1 : 0)));
      // All requested deliveries must be drained before handing back terminal control.
      const completion = hasMore ? null : settled;
      if (events.length || completion) {
        this.cursors.delivered(agent.agent_id, fromSequence!, sequence);
        const cursor = this.cursors.encode(input.runId, agent.agent_id, sequence, state);
        return { run_id: input.runId, observer_agent_id: input.observerAgentId, events, completion, has_more: hasMore, cursor,
          processed_cursor: this.cursors.encode(input.runId, agent.agent_id, state.processed_sequence, state),
          ack_contract: { tool: "run_ack" as const,
            arguments: { run_id: input.runId, observer_agent_id: agent.agent_id, cursor, wake_on: wakeOn },
            instruction: "After successfully handling this delivery, acknowledge its cursor explicitly. Receiving events never acknowledges processing." },
          timed_out: false, closed: false, wait_contract: contract() };
      }
      if (run.status === "stopped") return empty(false, true);
      const remaining = input.timeoutMs === undefined ? Infinity : input.timeoutMs - (Date.now() - started);
      if (remaining <= 0) return empty(true, false);
      if (rows.length === 100) continue;
      // Status refresh is deterministic code, never a supervisor model invocation.
      void this.controller.refreshObservedRuns(runIds).then(ids => { for (const item of ids) refreshedSessions.set(item.agent_id, item.key); });
      input.signal?.throwIfAborted();
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
  return { event_id: event.event_id, run_id: event.run_id, type: event.type, created_at: event.created_at, agent_id: event.agent_id,
    ...compactFlowEvent(event),
    ...(typeof event.payload.permission_request_id === "string" ? { permission_request_id: event.payload.permission_request_id, permission_state: event.payload.permission_state } : {}),
    ...(event.payload.reason === "coordinator_gate" && event.payload.decision ? {
      decision: Object.fromEntries(Object.entries(event.payload.decision as Record<string, unknown>)
        .filter(([key]) => ["key", "artifact_key", "owner", "authority"].includes(key)))
    } : {}),
    ...(typeof event.payload.step_instance_id === "string" ? { step_instance_id: event.payload.step_instance_id } : {}),
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
