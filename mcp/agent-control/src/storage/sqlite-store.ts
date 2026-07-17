import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isBridgeGrantId, isOrchestratorActionId, newId, nowIso } from "../core/ids.js";
import { defaultStatePath } from "../core/paths.js";
import type {
  AgentLinkRecord,
  AgentLinkType,
  AgentRecord,
  AgentStartAttemptRecord,
  AgentStatus,
  AgentTokenRecord,
  ArtifactRecord,
  BridgeGrantRecord,
  EventRecord,
  EventType,
  FailureReason,
  FlowArtifactBindingRecord,
  FlowConfig,
  FlowInstanceRecord,
  FlowInstanceStatus,
  FlowRecord,
  FlowStepInstanceRecord,
  FlowStepInstanceStatus,
  FlowStepReportRecord,
  FlowTransitionRecord,
  GoalRecord,
  GoalStatus,
  HeartbeatRecord,
  OrchestratorActionOperation,
  OrchestratorActionRecord,
  OrchestratorActionStatus,
  RunRecord,
  SubscriptionDeliveryRecord,
  SubscriptionRecord,
  UsageSnapshotRecord
} from "../core/types.js";

type Row = Record<string, unknown>;

const NATIVE_ORIGIN_GRANT_MIGRATION_ID =
  "2026-07-16-native-origin-grant-fk-v5";

export type AgentStartAttemptClaimResult =
  | { type: "stop_intent"; attempt: null }
  | { type: "claimed"; attempt: AgentStartAttemptRecord }
  | { type: "in_progress"; attempt: AgentStartAttemptRecord }
  | { type: "ambiguous"; attempt: AgentStartAttemptRecord }
  | { type: "terminal"; attempt: AgentStartAttemptRecord };

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function booleanFromSqlite(value: unknown): boolean {
  return value === 1 || value === true;
}

function acceptedWorkLeaseIsLive(row: Row, observedAt: string): boolean {
  if (typeof row.claim_owner_id !== "string" || row.claim_owner_id.length === 0) {
    return false;
  }
  if (typeof row.lease_expires_at !== "string") {
    return false;
  }
  const leaseExpiresAt = Date.parse(row.lease_expires_at);
  const observedAtMs = Date.parse(observedAt);
  return Number.isFinite(leaseExpiresAt) &&
    Number.isFinite(observedAtMs) &&
    leaseExpiresAt > observedAtMs;
}

export class SqliteStore {
  readonly db: Database.Database;
  private readonly afterCommitCallbacks: Array<() => void> = [];

  constructor(path = defaultStatePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    try {
      this.migrate();
    } catch (error) {
      // A failed transactional migration has already rolled its data changes
      // back. Close this constructor-owned connection as well so a caller can
      // repair/reopen the database without a leaked WAL reader or file handle.
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Run a synchronous controller initialization as one SQLite transaction. */
  transaction<T>(operation: () => T): T {
    return this.runTransaction(operation, false);
  }

  /**
   * Acquire SQLite's write reservation before the first read in a state
   * transition. This is required when a read decides whether new work exists:
   * a concurrent writer must commit entirely before this operation inspects
   * it, or wait until this operation has recorded its blocking state.
   */
  immediateTransaction<T>(operation: () => T): T {
    return this.runTransaction(operation, true);
  }

  /**
   * Defer a side effect until the outer managed transaction commits. Event
   * rows may be inserted transactionally, but subscriber delivery must never
   * observe a row or state transition that is still able to roll back.
   */
  afterCommit(callback: () => void): void {
    if (this.db.inTransaction) {
      this.afterCommitCallbacks.push(callback);
      return;
    }
    callback();
  }

  private runTransaction<T>(operation: () => T, immediate: boolean): T {
    const callbackStart = this.afterCommitCallbacks.length;
    if (this.db.inTransaction) {
      try {
        return operation();
      } catch (error) {
        this.afterCommitCallbacks.splice(callbackStart);
        throw error;
      }
    }

    try {
      const transaction = this.db.transaction(operation);
      const result = immediate ? transaction.immediate() : transaction();
      const committedCallbacks = this.afterCommitCallbacks.splice(callbackStart);
      for (const callback of committedCallbacks) {
        callback();
      }
      return result;
    } catch (error) {
      this.afterCommitCallbacks.splice(callbackStart);
      throw error;
    }
  }

  createRun(input: {
    title: string;
    repoDir?: string | null;
    parentRunId?: string | null;
    createdByAgentId?: string | null;
  }): RunRecord {
    const now = nowIso();
    const run: RunRecord = {
      run_id: newId("run"),
      title: input.title,
      repo_dir: input.repoDir ?? null,
      parent_run_id: input.parentRunId ?? null,
      created_by_agent_id: input.createdByAgentId ?? null,
      status: "active",
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into runs (
          run_id, title, repo_dir, parent_run_id, created_by_agent_id, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.run_id,
        run.title,
        run.repo_dir,
        run.parent_run_id,
        run.created_by_agent_id,
        run.status,
        run.created_at,
        run.updated_at
      );
    return run;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("select * from runs where run_id = ?").get(runId) as Row | undefined;
    return row ? this.runFromRow(row) : null;
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare("select * from runs order by created_at desc limit ?")
      .all(limit) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  listRunsByStatus(status: string): RunRecord[] {
    const rows = this.db
      .prepare("select * from runs where status = ? order by created_at asc")
      .all(status) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  listStoppedRunsOlderThan(cutoffIso: string): RunRecord[] {
    const rows = this.db
      .prepare("select * from runs where status = 'stopped' and updated_at < ? order by updated_at asc")
      .all(cutoffIso) as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  updateRunStatus(runId: string, status: string): RunRecord {
    this.db
      .prepare("update runs set status = ?, updated_at = ? where run_id = ?")
      .run(status, nowIso(), runId);
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run not found after update: ${runId}`);
    }
    return run;
  }

  createAgent(input: {
    runId: string;
    backend: string;
    title: string;
    role?: string | null;
    objective?: string | null;
    repoDir?: string | null;
    model?: string | null;
    backendHandle?: Record<string, unknown> | null;
    status?: AgentStatus;
  }): AgentRecord {
    const now = nowIso();
    const agent: AgentRecord = {
      agent_id: newId("agent"),
      run_id: input.runId,
      backend: input.backend,
      title: input.title,
      role: input.role ?? null,
      objective: input.objective ?? null,
      repo_dir: input.repoDir ?? null,
      model: input.model ?? null,
      backend_handle: input.backendHandle ?? null,
      work_generation: 0,
      work_revision: 0,
      status: input.status ?? "queued",
      failure_reason: null,
      unregistered_at: null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into agents (
          agent_id, run_id, backend, title, role, objective, repo_dir, model,
          backend_handle_json, work_generation, work_revision, status, failure_reason,
          unregistered_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        agent.agent_id,
        agent.run_id,
        agent.backend,
        agent.title,
        agent.role,
        agent.objective,
        agent.repo_dir,
        agent.model,
        agent.backend_handle ? JSON.stringify(agent.backend_handle) : null,
        agent.work_generation,
        agent.work_revision,
        agent.status,
        agent.failure_reason,
        agent.unregistered_at,
        agent.created_at,
        agent.updated_at
      );
    return agent;
  }

  getAgent(agentId: string): AgentRecord | null {
    const row = this.db.prepare("select * from agents where agent_id = ?").get(agentId) as
      | Row
      | undefined;
    return row ? this.agentFromRow(row) : null;
  }

  listAgents(input: { runId?: string; includeUnregistered?: boolean } = {}): AgentRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    if (!input.includeUnregistered) {
      clauses.push("unregistered_at is null");
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from agents ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.agentFromRow(row));
  }

  listUnregisteredAgentsOlderThan(cutoffIso: string, excludeRunIds: string[] = []): AgentRecord[] {
    const rows = this.db
      .prepare(
        "select * from agents where unregistered_at is not null and unregistered_at < ? order by unregistered_at asc"
      )
      .all(cutoffIso) as Row[];
    const excluded = new Set(excludeRunIds);
    return rows.map((row) => this.agentFromRow(row)).filter((agent) => !excluded.has(agent.run_id));
  }

  updateAgent(
    agentId: string,
    patch: Partial<{
      backendHandle: Record<string, unknown> | null;
      status: AgentStatus;
      failureReason: FailureReason | null;
      unregisteredAt: string | null;
    }>
  ): AgentRecord {
    const assignments: string[] = ["updated_at = ?"];
    const values: unknown[] = [nowIso()];
    if ("backendHandle" in patch) {
      assignments.push("backend_handle_json = ?");
      values.push(patch.backendHandle ? JSON.stringify(patch.backendHandle) : null);
    }
    if (patch.status) {
      assignments.push("status = ?");
      values.push(patch.status);
    }
    if ("failureReason" in patch) {
      assignments.push("failure_reason = ?");
      values.push(patch.failureReason ?? null);
    }
    if ("unregisteredAt" in patch) {
      assignments.push("unregistered_at = ?");
      values.push(patch.unregisteredAt ?? null);
    }
    values.push(agentId);
    this.db.prepare(`update agents set ${assignments.join(", ")} where agent_id = ?`).run(...values);
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found after update: ${agentId}`);
    }
    return agent;
  }

  updateAgentForNewWork(
    agentId: string,
    patch: {
      backendHandle?: Record<string, unknown> | null;
      status: AgentStatus;
      failureReason: FailureReason | null;
    },
    options: {
      advanceWorkGeneration?: boolean;
      expectedWorkGeneration?: number;
      expectedWorkRevision?: number;
    } = {}
  ): { agent: AgentRecord; changed: boolean } {
    const assignments = ["status = ?", "failure_reason = ?", "updated_at = ?"];
    const values: unknown[] = [patch.status, patch.failureReason, nowIso()];
    if (options.advanceWorkGeneration) {
      // The same conditional write that accepts new work advances the refresh
      // fence. A stop that wins the predicate race prevents both changes.
      assignments.push("work_generation = work_generation + 1");
    }
    if ("backendHandle" in patch) {
      assignments.unshift("backend_handle_json = ?");
      values.unshift(patch.backendHandle ? JSON.stringify(patch.backendHandle) : null);
    }
    values.push(agentId);
    const workGenerationPredicate = options.expectedWorkGeneration === undefined
      ? ""
      : " and work_generation = ?";
    if (options.expectedWorkGeneration !== undefined) {
      values.push(options.expectedWorkGeneration);
    }
    const workRevisionPredicate = options.expectedWorkRevision === undefined
      ? ""
      : " and work_revision = ?";
    if (options.expectedWorkRevision !== undefined) {
      values.push(options.expectedWorkRevision);
    }
    // The predicate prevents another process from projecting new work over a
    // stop that committed after its controller-side re-read.
    const update = this.db
      .prepare(
        `update agents
         set ${assignments.join(", ")}
           where agent_id = ?
             ${workGenerationPredicate}
             ${workRevisionPredicate}
             and status not in ('stopping', 'stopped')
           and exists (
             select 1 from runs
             where runs.run_id = agents.run_id
               and runs.status not in ('stopping', 'stopped')
           )`
      )
      .run(...values);
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found after conditional new-work update: ${agentId}`);
    }
    return { agent, changed: update.changes === 1 };
  }

  /**
   * Advance the status-observation fence for work that has crossed an external
   * invocation boundary, optionally making that attempt inspectable in the
   * same transaction. The durable acceptance key makes re-processing one
   * physical attempt idempotent; every independent attempt receives a new key
   * and therefore a new monotonic generation.
   */
  advanceAgentWorkGenerationForAcceptedWork(
    agentId: string,
    acceptanceKey: string,
    options: {
      /** Durable controller identity that owns this physical adapter call. */
      claimOwnerId: string;
      /** Renewable lease used to distinguish live I/O from a crashed owner. */
      leaseExpiresAt: string;
      /** Exact logical delivery, when this acceptance belongs to a subscription. */
      deliveryEventId?: string | null;
      deliveryClaimAttempt?: number | null;
      /** Make possibly accepted work inspectable without overriding durable stop. */
      projectStatus?: AgentStatus;
      failureReason?: FailureReason | null;
    }
  ):
    | { type: "accepted"; agent: AgentRecord; advanced: boolean }
    | { type: "already_accepted"; agent: AgentRecord; advanced: false }
    | { type: "stop_intent"; agent: AgentRecord; advanced: false } {
    return this.immediateTransaction(() => {
      const existing = this.db
        .prepare(
          `select agent_id, work_generation
           from agent_work_acceptances
           where acceptance_key = ?`
        )
        .get(acceptanceKey) as Row | undefined;
      if (existing) {
        if (String(existing.agent_id) !== agentId) {
          throw new Error(
            `Accepted-work key belongs to another agent: ${acceptanceKey}`
          );
        }
      }

      const current = this.getAgent(agentId);
      if (!current) {
        throw new Error(`Agent not found while accepting work: ${agentId}`);
      }
      const run = this.getRun(current.run_id);
      if (!run) {
        throw new Error(`Run not found while accepting work: ${current.run_id}`);
      }
      if (
        current.status === "stopping" ||
        current.status === "stopped" ||
        run.status === "stopping" ||
        run.status === "stopped"
      ) {
        // This check runs after BEGIN IMMEDIATE has acquired SQLite's write
        // reservation. Therefore a stop that committed first is authoritative
        // and no acceptance row is created, while a stop that arrives later
        // waits behind the durable invocation boundary recorded below.
        return { type: "stop_intent", agent: current, advanced: false };
      }
      if (existing) {
        return { type: "already_accepted", agent: current, advanced: false };
      }
      const acceptedAt = nowIso();
      const workGeneration = current.work_generation + 1;
      const workRevision = current.work_revision + 1;
      this.db
        .prepare(
          `insert into agent_work_acceptances (
             acceptance_key, agent_id, work_generation, attempt_revision,
             phase, completion_revision, claim_owner_id, lease_expires_at,
             delivery_event_id, delivery_claim_attempt,
             created_at, updated_at, completed_at
           ) values (?, ?, ?, ?, 'invoking', null, ?, ?, ?, ?, ?, ?, null)`
        )
        .run(
          acceptanceKey,
          agentId,
          workGeneration,
          workRevision,
          options.claimOwnerId,
          options.leaseExpiresAt,
          options.deliveryEventId ?? null,
          options.deliveryClaimAttempt ?? null,
          acceptedAt,
          acceptedAt
        );
      const advanced = this.db
        .prepare(
          `update agents
           set work_generation = ?, work_revision = ?, updated_at = ?
           where agent_id = ? and work_generation = ? and work_revision = ?`
        )
        .run(
          workGeneration,
          workRevision,
          acceptedAt,
          agentId,
          current.work_generation,
          current.work_revision
        );
      if (advanced.changes !== 1) {
        throw new Error(`Agent work generation changed while accepting work: ${agentId}`);
      }
      if (options.projectStatus) {
        // This second write shares the same BEGIN IMMEDIATE reservation. The
        // generation always advances for the physical attempt, while a stop
        // that already won keeps its stopping/stopped projection intact.
        this.updateAgentForNewWork(
          agentId,
          {
            status: options.projectStatus,
            failureReason: options.failureReason ?? null
          },
          {
            expectedWorkGeneration: workGeneration,
            expectedWorkRevision: workRevision
          }
        );
      }
      return { type: "accepted", agent: this.getAgent(agentId)!, advanced: true };
    });
  }

  /**
   * Close one physical adapter invocation and advance only its observation
   * revision. This invalidates a refresh that began after the generation fence
   * but before the adapter accepted/rejected, without counting another logical
   * work generation.
   */
  completeAgentAcceptedWorkAttempt(input: {
    agentId: string;
    acceptanceKey: string;
    claimOwnerId: string;
    outcome: "succeeded" | "ambiguous";
    status: AgentStatus;
    failureReason: FailureReason | null;
  }): { agent: AgentRecord; completed: boolean; attemptOwnedAgent: boolean } {
    return this.immediateTransaction(() => {
      const row = this.db
        .prepare(
          `select agent_id, work_generation, attempt_revision, phase,
                  completion_revision, claim_owner_id
           from agent_work_acceptances
           where acceptance_key = ?`
        )
        .get(input.acceptanceKey) as Row | undefined;
      if (!row || String(row.agent_id) !== input.agentId) {
        throw new Error(`Accepted work attempt not found: ${input.acceptanceKey}`);
      }
      const current = this.getAgent(input.agentId);
      if (!current) {
        throw new Error(`Agent not found while completing accepted work: ${input.agentId}`);
      }
      const phase = String(row.phase);
      if (String(row.claim_owner_id ?? "") !== input.claimOwnerId) {
        throw new Error(
          `Accepted work attempt belongs to another controller: ${input.acceptanceKey}`
        );
      }
      if (phase !== "invoking") {
        if (phase !== input.outcome) {
          throw new Error(
            `Accepted work attempt has conflicting completion: ${input.acceptanceKey}`
          );
        }
        return { agent: current, completed: false, attemptOwnedAgent: false };
      }

      const workGeneration = Number(row.work_generation);
      const attemptRevision = Number(row.attempt_revision);
      const attemptOwnedAgent =
        current.work_generation === workGeneration &&
        current.work_revision === attemptRevision;
      const completedAt = nowIso();
      let completionRevision: number | null = null;
      if (attemptOwnedAgent) {
        completionRevision = attemptRevision + 1;
        const revision = this.db
          .prepare(
            `update agents
             set work_revision = ?, updated_at = ?
             where agent_id = ? and work_generation = ? and work_revision = ?`
          )
          .run(
            completionRevision,
            completedAt,
            input.agentId,
            workGeneration,
            attemptRevision
          );
        if (revision.changes !== 1) {
          throw new Error(
            `Agent work revision changed while completing accepted work: ${input.agentId}`
          );
        }
        this.updateAgentForNewWork(
          input.agentId,
          { status: input.status, failureReason: input.failureReason },
          {
            expectedWorkGeneration: workGeneration,
            expectedWorkRevision: completionRevision
          }
        );
      }
      const completion = this.db
        .prepare(
          `update agent_work_acceptances
           set phase = ?, completion_revision = ?, updated_at = ?, completed_at = ?
           where acceptance_key = ? and phase = 'invoking'`
        )
        .run(
          input.outcome,
          completionRevision,
          completedAt,
          completedAt,
          input.acceptanceKey
        );
      if (completion.changes !== 1) {
        throw new Error(`Accepted work completion lost its phase: ${input.acceptanceKey}`);
      }
      return {
        agent: this.getAgent(input.agentId)!,
        completed: true,
        attemptOwnedAgent
      };
    });
  }

  agentHasAmbiguousAcceptedWork(agentId: string, workGeneration: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `select 1
           from agent_work_acceptances
           where agent_id = ? and work_generation = ? and phase = 'ambiguous'
           limit 1`
        )
        .get(agentId, workGeneration)
    );
  }

  renewAgentAcceptedWorkLease(input: {
    agentId: string;
    acceptanceKey: string;
    claimOwnerId: string;
    leaseExpiresAt: string;
  }): boolean {
    return this.db
      .prepare(
        `update agent_work_acceptances
         set lease_expires_at = ?, updated_at = ?
         where acceptance_key = ? and agent_id = ? and phase = 'invoking'
           and claim_owner_id = ?`
      )
      .run(
        input.leaseExpiresAt,
        nowIso(),
        input.acceptanceKey,
        input.agentId,
        input.claimOwnerId
      ).changes === 1;
  }

  /**
   * Resolve the exact acceptance revision observed by a refresh. A live lease
   * protects in-process adapter I/O from false terminal projection. An expired
   * or legacy owner is never replayed: it becomes durable ambiguity, advances
   * the revision fence, and releases any linked delivery into an inspectable
   * non-retryable state before backend status reconciliation may continue.
   */
  resolveInvokingAgentAcceptedWork(
    agentId: string,
    workGeneration: number,
    workRevision: number,
    observedAt = nowIso()
  ):
    | { type: "none"; agent: AgentRecord }
    | { type: "live"; agent: AgentRecord }
    | { type: "recovered_ambiguous"; agent: AgentRecord } {
    return this.immediateTransaction(() => {
      const agent = this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent not found while resolving accepted work: ${agentId}`);
      }
      const row = this.db
        .prepare(
          `select * from agent_work_acceptances
           where agent_id = ? and work_generation = ?
             and attempt_revision = ? and phase = 'invoking'
           limit 1`
        )
        .get(agentId, workGeneration, workRevision) as Row | undefined;
      if (!row) {
        return { type: "none", agent };
      }
      if (acceptedWorkLeaseIsLive(row, observedAt)) {
        return { type: "live", agent };
      }
      return {
        type: "recovered_ambiguous",
        agent: this.recoverAbandonedAgentAcceptedWork(row, observedAt)
      };
    });
  }

  /** Recover every lease-expired invocation during controller startup. */
  recoverExpiredAgentAcceptedWork(observedAt = nowIso()): AgentRecord[] {
    return this.immediateTransaction(() => {
      const rows = this.db
        .prepare("select * from agent_work_acceptances where phase = 'invoking'")
        .all() as Row[];
      const recovered: AgentRecord[] = [];
      for (const row of rows) {
        if (!acceptedWorkLeaseIsLive(row, observedAt)) {
          recovered.push(this.recoverAbandonedAgentAcceptedWork(row, observedAt));
        }
      }
      return recovered;
    });
  }

  private recoverAbandonedAgentAcceptedWork(row: Row, recoveredAt: string): AgentRecord {
    const acceptanceKey = String(row.acceptance_key);
    const agentId = String(row.agent_id);
    const current = this.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent not found for abandoned accepted work: ${agentId}`);
    }
    const workGeneration = Number(row.work_generation);
    const attemptRevision = Number(row.attempt_revision);
    const attemptOwnsAgent =
      current.work_generation === workGeneration &&
      current.work_revision === attemptRevision;
    let completionRevision: number | null = null;
    if (attemptOwnsAgent) {
      const run = this.getRun(current.run_id);
      if (!run) {
        throw new Error(`Run not found for abandoned accepted work: ${current.run_id}`);
      }
      completionRevision = attemptRevision + 1;
      const stopIntent =
        current.status === "stopping" ||
        current.status === "stopped" ||
        run.status === "stopping" ||
        run.status === "stopped";
      const revision = this.db
        .prepare(
          `update agents
           set work_revision = ?, status = ?, failure_reason = ?, updated_at = ?
           where agent_id = ? and work_generation = ? and work_revision = ?`
        )
        .run(
          completionRevision,
          stopIntent ? current.status : "unknown",
          stopIntent ? current.failure_reason : "unknown",
          recoveredAt,
          agentId,
          workGeneration,
          attemptRevision
        );
      if (revision.changes !== 1) {
        throw new Error(
          `Agent work revision changed while recovering accepted work: ${agentId}`
        );
      }
    }

    const recovered = this.db
      .prepare(
        `update agent_work_acceptances
         set phase = 'ambiguous', completion_revision = ?, lease_expires_at = null,
             updated_at = ?, completed_at = ?
         where acceptance_key = ? and phase = 'invoking'`
      )
      .run(completionRevision, recoveredAt, recoveredAt, acceptanceKey);
    if (recovered.changes !== 1) {
      throw new Error(`Accepted work recovery lost its phase: ${acceptanceKey}`);
    }

    const deliveryEventId =
      row.delivery_event_id === null || row.delivery_event_id === undefined
        ? null
        : String(row.delivery_event_id);
    const deliveryClaimAttempt =
      row.delivery_claim_attempt === null || row.delivery_claim_attempt === undefined
        ? null
        : Number(row.delivery_claim_attempt);
    if (deliveryEventId && deliveryClaimAttempt !== null) {
      // The original adapter call may have delivered the notification. Release
      // process ownership but deliberately do not return the row to `pending`:
      // an automatic retry could duplicate possibly accepted external work.
      const deliveryRecovery = this.db
        .prepare(
          `update subscription_deliveries
           set status = 'ambiguous', claim_owner_id = null, claimed_at = null,
               last_error_json = ?, updated_at = ?
           where event_id = ? and subscriber_agent_id = ? and status = 'invoking'
             and claim_attempt = ?`
        )
        .run(
          JSON.stringify({
            reason: "delivery_outcome_ambiguous_after_owner_lease_expired",
            acceptance_key: acceptanceKey
          }),
          recoveredAt,
          deliveryEventId,
          agentId,
          deliveryClaimAttempt
        );
      if (deliveryRecovery.changes === 1) {
        // Recovery is intentionally non-retryable because the original adapter
        // call may have succeeded. Publish a durable, public diagnostic next to
        // the delivery row so operators do not need direct SQLite access to
        // discover why the subscriber stopped progressing. The payload carries
        // only stable identifiers and the ambiguity reason, never credentials
        // or the original delivered message.
        this.createEvent({
          runId: current.run_id,
          agentId,
          type: "agent.delivery_failed",
          payload: {
            source_event_id: deliveryEventId,
            subscriber_agent_id: agentId,
            delivery_claim_attempt: deliveryClaimAttempt,
            status: "ambiguous",
            reason: "delivery_outcome_ambiguous_after_owner_lease_expired"
          }
        });
      }
    }
    return this.getAgent(agentId)!;
  }

  /**
   * Claim the single start attempt associated with a fresh flow worker. The
   * BEGIN IMMEDIATE reservation serializes every process that can decide to
   * invoke the adapter. Only an expired `prepared` attempt is reclaimable;
   * expiry after `invoking` is conservatively persisted as ambiguity.
   */
  claimAgentStartAttempt(input: {
    agentId: string;
    flowInstanceId: string;
    stepInstanceId: string;
    generation: number;
    leaseExpiresAt: string;
  }): AgentStartAttemptClaimResult {
    return this.immediateTransaction(() => {
      const observedAt = nowIso();
      const agent = this.getAgent(input.agentId);
      const run = agent ? this.getRun(agent.run_id) : null;
      if (
        !agent ||
        !run ||
        agent.status === "stopping" ||
        agent.status === "stopped" ||
        run.status === "stopping" ||
        run.status === "stopped"
      ) {
        return { type: "stop_intent" as const, attempt: null };
      }
      const step = this.getFlowStepInstance(input.stepInstanceId);
      const instance = this.getFlowInstance(input.flowInstanceId);
      if (
        !step ||
        !instance ||
        step.agent_id !== input.agentId ||
        step.flow_instance_id !== input.flowInstanceId ||
        instance.run_id !== agent.run_id
      ) {
        throw new Error(
          "Agent start attempt metadata does not match its durable flow assignment."
        );
      }
      const existing = this.getAgentStartAttemptForStep(
        input.agentId,
        input.stepInstanceId,
        input.generation
      );
      if (existing) {
        if (existing.phase === "prepared") {
          if (Date.parse(existing.lease_expires_at) > Date.parse(observedAt)) {
            return { type: "in_progress" as const, attempt: existing };
          }
          const claimOwnerId = newId("startclaim");
          this.db
            .prepare(
              `update agent_start_attempts
               set claim_owner_id = ?, lease_expires_at = ?, updated_at = ?
               where start_attempt_id = ? and phase = 'prepared'
                 and lease_expires_at <= ?`
            )
            .run(
              claimOwnerId,
              input.leaseExpiresAt,
              observedAt,
              existing.start_attempt_id,
              observedAt
            );
          return {
            type: "claimed" as const,
            attempt: this.requireAgentStartAttempt(existing.start_attempt_id)
          };
        }
        if (existing.phase === "invoking") {
          if (Date.parse(existing.lease_expires_at) > Date.parse(observedAt)) {
            return { type: "in_progress" as const, attempt: existing };
          }
          const error = {
            reason: "backend_start_invocation_lease_expired",
            message:
              "The backend start invocation lease expired after the adapter call boundary; automatic retry is disabled."
          };
          this.db
            .prepare(
              `update agent_start_attempts
               set phase = 'ambiguous', error_json = ?, updated_at = ?, completed_at = ?
               where start_attempt_id = ? and phase = 'invoking'
                 and lease_expires_at <= ?`
            )
            .run(
              JSON.stringify(error),
              observedAt,
              observedAt,
              existing.start_attempt_id,
              observedAt
            );
          return {
            type: "ambiguous" as const,
            attempt: this.requireAgentStartAttempt(existing.start_attempt_id)
          };
        }
        return {
          type: existing.phase === "ambiguous" ? ("ambiguous" as const) : ("terminal" as const),
          attempt: existing
        };
      }

      const attempt: AgentStartAttemptRecord = {
        start_attempt_id: newId("startattempt"),
        agent_id: input.agentId,
        flow_instance_id: input.flowInstanceId,
        step_instance_id: input.stepInstanceId,
        generation: input.generation,
        phase: "prepared",
        claim_owner_id: newId("startclaim"),
        lease_expires_at: input.leaseExpiresAt,
        invocation_started_at: null,
        handle_json: null,
        error_json: null,
        created_at: observedAt,
        updated_at: observedAt,
        completed_at: null
      };
      this.db
        .prepare(
          `insert into agent_start_attempts (
            start_attempt_id, agent_id, flow_instance_id, step_instance_id,
            generation, phase, claim_owner_id, lease_expires_at,
            invocation_started_at, handle_json, error_json, created_at,
            updated_at, completed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attempt.start_attempt_id,
          attempt.agent_id,
          attempt.flow_instance_id,
          attempt.step_instance_id,
          attempt.generation,
          attempt.phase,
          attempt.claim_owner_id,
          attempt.lease_expires_at,
          null,
          null,
          null,
          attempt.created_at,
          attempt.updated_at,
          null
        );
      return { type: "claimed" as const, attempt };
    });
  }

  /**
   * Persist the invocation boundary immediately before the adapter call. A
   * process that loses this CAS must not invoke: its prepared lease was either
   * reclaimed or cancelled by durable stop intent.
   */
  beginAgentStartAttempt(input: {
    startAttemptId: string;
    claimOwnerId: string;
    leaseExpiresAt: string;
  }): { began: boolean; attempt: AgentStartAttemptRecord } {
    return this.immediateTransaction(() => {
      const startedAt = nowIso();
      const update = this.db
        .prepare(
          `update agent_start_attempts
           set phase = 'invoking', invocation_started_at = ?,
               lease_expires_at = ?, updated_at = ?
           where start_attempt_id = ? and phase = 'prepared'
             and claim_owner_id = ? and lease_expires_at > ?
             and exists (
               select 1 from agents
               join runs on runs.run_id = agents.run_id
               where agents.agent_id = agent_start_attempts.agent_id
                 and agents.status not in ('stopping', 'stopped')
                 and runs.status not in ('stopping', 'stopped')
             )`
        )
        .run(
          startedAt,
          input.leaseExpiresAt,
          startedAt,
          input.startAttemptId,
          input.claimOwnerId,
          startedAt
        );
      return {
        began: update.changes === 1,
        attempt: this.requireAgentStartAttempt(input.startAttemptId)
      };
    });
  }

  /** Make a proved pre-invocation failure immediately reclaimable. */
  releasePreparedAgentStartAttempt(input: {
    startAttemptId: string;
    claimOwnerId: string;
    error: Record<string, unknown>;
  }): AgentStartAttemptRecord {
    const releasedAt = nowIso();
    this.db
      .prepare(
        `update agent_start_attempts
         set lease_expires_at = ?, error_json = ?, updated_at = ?
         where start_attempt_id = ? and claim_owner_id = ? and phase = 'prepared'`
      )
      .run(
        releasedAt,
        JSON.stringify(input.error),
        releasedAt,
        input.startAttemptId,
        input.claimOwnerId
      );
    return this.requireAgentStartAttempt(input.startAttemptId);
  }

  /** Complete a start while retaining its claimant identity for late-response reconciliation. */
  completeAgentStartAttemptSuccess(input: {
    startAttemptId: string;
    claimOwnerId: string;
    handle: Record<string, unknown>;
  }): {
    completed: boolean;
    attempt: AgentStartAttemptRecord;
    previousPhase: AgentStartAttemptRecord["phase"];
  } {
    const previous = this.requireAgentStartAttempt(input.startAttemptId);
    const completedAt = nowIso();
    const update = this.db
      .prepare(
        `update agent_start_attempts
         set phase = 'succeeded', handle_json = ?, error_json = null,
             updated_at = ?, completed_at = ?
         where start_attempt_id = ? and claim_owner_id = ?
           and phase in ('invoking', 'ambiguous')`
      )
      .run(
        JSON.stringify(input.handle),
        completedAt,
        completedAt,
        input.startAttemptId,
        input.claimOwnerId
      );
    return {
      completed: update.changes === 1,
      attempt: this.requireAgentStartAttempt(input.startAttemptId),
      previousPhase: previous.phase
    };
  }

  markAgentStartAttemptAmbiguous(input: {
    startAttemptId: string;
    claimOwnerId: string;
    error: Record<string, unknown>;
  }): AgentStartAttemptRecord {
    const completedAt = nowIso();
    this.db
      .prepare(
        `update agent_start_attempts
         set phase = 'ambiguous', error_json = ?, updated_at = ?, completed_at = ?
         where start_attempt_id = ? and claim_owner_id = ? and phase = 'invoking'`
      )
      .run(
        JSON.stringify(input.error),
        completedAt,
        completedAt,
        input.startAttemptId,
        input.claimOwnerId
      );
    return this.requireAgentStartAttempt(input.startAttemptId);
  }

  /** Persist that a real returned session no longer owns its original route. */
  markAgentStartAttemptSuperseded(input: {
    startAttemptId: string;
    claimOwnerId: string;
    handle: Record<string, unknown>;
    reason: string;
  }): { changed: boolean; attempt: AgentStartAttemptRecord } {
    const completedAt = nowIso();
    const update = this.db
      .prepare(
        `update agent_start_attempts
         set phase = 'superseded', handle_json = ?, error_json = ?,
             updated_at = ?, completed_at = ?
         where start_attempt_id = ? and claim_owner_id = ?
           and phase in ('succeeded', 'cancelled', 'failed')`
      )
      .run(
        JSON.stringify(input.handle),
        JSON.stringify({ reason: input.reason }),
        completedAt,
        completedAt,
        input.startAttemptId,
        input.claimOwnerId
      );
    return {
      changed: update.changes === 1,
      attempt: this.requireAgentStartAttempt(input.startAttemptId)
    };
  }

  cancelPreparedAgentStartAttempts(
    agentId: string,
    error: Record<string, unknown>
  ): AgentStartAttemptRecord[] {
    const completedAt = nowIso();
    this.db
      .prepare(
        `update agent_start_attempts
         set phase = 'cancelled', error_json = ?, updated_at = ?, completed_at = ?
         where agent_id = ? and phase = 'prepared'`
      )
      .run(JSON.stringify(error), completedAt, completedAt, agentId);
    return this.listAgentStartAttempts(agentId);
  }

  getAgentStartAttemptForStep(
    agentId: string,
    stepInstanceId: string,
    generation = 1
  ): AgentStartAttemptRecord | null {
    const row = this.db
      .prepare(
        `select * from agent_start_attempts
         where agent_id = ? and step_instance_id = ? and generation = ?`
      )
      .get(agentId, stepInstanceId, generation) as Row | undefined;
    return row ? this.agentStartAttemptFromRow(row) : null;
  }

  getLatestAgentStartAttempt(agentId: string): AgentStartAttemptRecord | null {
    const row = this.db
      .prepare(
        `select * from agent_start_attempts
         where agent_id = ? order by created_at desc, start_attempt_id desc limit 1`
      )
      .get(agentId) as Row | undefined;
    return row ? this.agentStartAttemptFromRow(row) : null;
  }

  listAgentStartAttempts(agentId: string): AgentStartAttemptRecord[] {
    const rows = this.db
      .prepare(
        `select * from agent_start_attempts
         where agent_id = ? order by created_at asc, start_attempt_id asc`
      )
      .all(agentId) as Row[];
    return rows.map((row) => this.agentStartAttemptFromRow(row));
  }

  getLatestCompletedAgentStartAttemptWithHandle(
    agentId: string
  ): AgentStartAttemptRecord | null {
    const row = this.db
      .prepare(
        `select * from agent_start_attempts
         where agent_id = ? and phase in ('succeeded', 'superseded')
           and handle_json is not null
         order by completed_at desc, created_at desc, start_attempt_id desc
         limit 1`
      )
      .get(agentId) as Row | undefined;
    return row ? this.agentStartAttemptFromRow(row) : null;
  }

  /** SQLite rowid provides an insertion order even when ISO timestamps tie. */
  hasFlowStepInstanceAfter(stepInstanceId: string): boolean {
    const row = this.db
      .prepare(
        `select exists(
           select 1
           from flow_step_instances later
           where later.flow_instance_id = (
             select current.flow_instance_id
             from flow_step_instances current
             where current.step_instance_id = ?
           )
             and later.rowid > (
               select current.rowid
               from flow_step_instances current
               where current.step_instance_id = ?
             )
         ) as found`
      )
      .get(stepInstanceId, stepInstanceId) as { found?: unknown } | undefined;
    return booleanFromSqlite(row?.found);
  }

  /** Resolve an expired invoking lease without creating or reclaiming an attempt. */
  resolveAgentStartAttempt(
    agentId: string,
    stepInstanceId: string,
    generation = 1
  ): AgentStartAttemptRecord | null {
    return this.immediateTransaction(() => {
      const attempt = this.getAgentStartAttemptForStep(agentId, stepInstanceId, generation);
      if (
        attempt?.phase === "invoking" &&
        Date.parse(attempt.lease_expires_at) <= Date.now()
      ) {
        const completedAt = nowIso();
        const error = {
          reason: "backend_start_invocation_lease_expired",
          message:
            "The backend start invocation lease expired after the adapter call boundary; automatic retry is disabled."
        };
        this.db
          .prepare(
            `update agent_start_attempts
             set phase = 'ambiguous', error_json = ?, updated_at = ?, completed_at = ?
             where start_attempt_id = ? and phase = 'invoking'
               and lease_expires_at <= ?`
          )
          .run(
            JSON.stringify(error),
            completedAt,
            completedAt,
            attempt.start_attempt_id,
            completedAt
          );
        return this.requireAgentStartAttempt(attempt.start_attempt_id);
      }
      return attempt;
    });
  }

  private requireAgentStartAttempt(startAttemptId: string): AgentStartAttemptRecord {
    const row = this.db
      .prepare("select * from agent_start_attempts where start_attempt_id = ?")
      .get(startAttemptId) as Row | undefined;
    if (!row) {
      throw new Error(`Agent start attempt not found: ${startAttemptId}`);
    }
    return this.agentStartAttemptFromRow(row);
  }

  updateAgentForOpenOrchestratorAction(
    actionId: string,
    agentId: string,
    patch: {
      status: AgentStatus;
      failureReason: FailureReason | null;
    }
  ): {
    agent: AgentRecord;
    action: OrchestratorActionRecord | null;
    changed: boolean;
  } {
    // This predicate is deliberately repeated at the write boundary even when
    // the controller already holds BEGIN IMMEDIATE. It makes the transition
    // safe under same-connection re-entry in tests and future composed store
    // operations: a terminal ACK can never be followed by a stale projection.
    const update = this.db
      .prepare(
        `update agents
         set status = ?, failure_reason = ?, updated_at = ?
         where agent_id = ?
           and status not in ('stopping', 'stopped')
           and exists (
             select 1 from runs
             where runs.run_id = agents.run_id
               and runs.status not in ('stopping', 'stopped')
           )
           and exists (
             select 1 from orchestrator_actions
             where orchestrator_actions.action_id = ?
               and orchestrator_actions.agent_id = agents.agent_id
               and orchestrator_actions.run_id = agents.run_id
               and orchestrator_actions.status in ('pending', 'claimed')
           )`
      )
      .run(patch.status, patch.failureReason, nowIso(), agentId, actionId);
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found after orchestrator action projection: ${agentId}`);
    }
    return {
      agent,
      action: this.getOrchestratorAction(actionId),
      changed: update.changes === 1
    };
  }

  createAgentToken(input: { agentId: string; tokenHash: string }): AgentTokenRecord {
    const token: AgentTokenRecord = {
      token_id: newId("token"),
      agent_id: input.agentId,
      token_hash: input.tokenHash,
      created_at: nowIso(),
      revoked_at: null
    };
    this.db
      .prepare(
        "insert into agent_tokens (token_id, agent_id, token_hash, created_at, revoked_at) values (?, ?, ?, ?, ?)"
      )
      .run(token.token_id, token.agent_id, token.token_hash, token.created_at, token.revoked_at);
    return token;
  }

  getAgentByTokenHash(tokenHash: string): AgentRecord | null {
    const row = this.db
      .prepare(
        `select agents.*
         from agent_tokens
         join agents on agents.agent_id = agent_tokens.agent_id
         where agent_tokens.token_hash = ? and agent_tokens.revoked_at is null
         limit 1`
      )
      .get(tokenHash) as Row | undefined;
    return row ? this.agentFromRow(row) : null;
  }

  revokeAgentToken(tokenId: string): void {
    this.db.prepare("update agent_tokens set revoked_at = ? where token_id = ?").run(nowIso(), tokenId);
  }

  createBridgeGrant(input: {
    runId: string;
    orchestratorAgentId: string;
    ownerTaskIdentity?: string | null;
    ownerTaskPath: string;
    tokenHash: string;
    expiresAt?: string | null;
  }): BridgeGrantRecord {
    const grant: BridgeGrantRecord = {
      bridge_grant_id: newId("bridge"),
      run_id: input.runId,
      orchestrator_agent_id: input.orchestratorAgentId,
      owner_task_identity: input.ownerTaskIdentity ?? null,
      owner_task_path: input.ownerTaskPath,
      token_hash: input.tokenHash,
      created_at: nowIso(),
      last_used_at: null,
      expires_at: input.expiresAt ?? null,
      revoked_at: null
    };
    this.db
      .prepare(
        `insert into bridge_grants (
          bridge_grant_id, run_id, orchestrator_agent_id, owner_task_identity,
          owner_task_path, token_hash, created_at, last_used_at, expires_at, revoked_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        grant.bridge_grant_id,
        grant.run_id,
        grant.orchestrator_agent_id,
        grant.owner_task_identity,
        grant.owner_task_path,
        grant.token_hash,
        grant.created_at,
        grant.last_used_at,
        grant.expires_at,
        grant.revoked_at
      );
    return grant;
  }

  getBridgeGrantByTokenHash(tokenHash: string): BridgeGrantRecord | null {
    const row = this.db
      .prepare("select * from bridge_grants where token_hash = ? limit 1")
      .get(tokenHash) as Row | undefined;
    return row ? this.bridgeGrantFromRow(row) : null;
  }

  getBridgeGrant(bridgeGrantId: string): BridgeGrantRecord | null {
    if (!isBridgeGrantId(bridgeGrantId)) {
      return null;
    }
    const row = this.db
      .prepare("select * from bridge_grants where bridge_grant_id = ?")
      .get(bridgeGrantId) as Row | undefined;
    return row ? this.bridgeGrantFromRow(row) : null;
  }

  listBridgeGrants(input: {
    runId?: string;
    orchestratorAgentId?: string;
  } = {}): BridgeGrantRecord[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (input.runId) {
      conditions.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.orchestratorAgentId) {
      conditions.push("orchestrator_agent_id = ?");
      values.push(input.orchestratorAgentId);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from bridge_grants ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.bridgeGrantFromRow(row));
  }

  revokeBridgeGrant(bridgeGrantId: string, revokedAt = nowIso()): BridgeGrantRecord | null {
    if (!isBridgeGrantId(bridgeGrantId)) {
      return null;
    }
    this.db
      .prepare("update bridge_grants set revoked_at = coalesce(revoked_at, ?) where bridge_grant_id = ?")
      .run(revokedAt, bridgeGrantId);
    return this.getBridgeGrant(bridgeGrantId);
  }

  getLatestActiveBridgeGrant(runId: string, orchestratorAgentId: string): BridgeGrantRecord | null {
    const now = nowIso();
    const row = this.db
      .prepare(
        `select * from bridge_grants
         where run_id = ? and orchestrator_agent_id = ? and revoked_at is null
           and (expires_at is null or expires_at > ?)
         order by created_at desc
         limit 1`
      )
      .get(runId, orchestratorAgentId, now) as Row | undefined;
    return row ? this.bridgeGrantFromRow(row) : null;
  }

  touchBridgeGrant(bridgeGrantId: string, usedAt = nowIso()): void {
    this.db
      .prepare("update bridge_grants set last_used_at = ? where bridge_grant_id = ?")
      .run(usedAt, bridgeGrantId);
  }

  createOrGetOrchestratorAction(input: {
    idempotencyKey: string;
    runId: string;
    orchestratorAgentId: string;
    originatingBridgeGrantId: string;
    agentId: string;
    flowInstanceId?: string | null;
    stepInstanceId?: string | null;
    operation: OrchestratorActionOperation;
    payloadJson: Record<string, unknown>;
  }): OrchestratorActionRecord | null {
    const create = () => {
      const grant = this.getBridgeGrant(input.originatingBridgeGrantId);
      const grantExpired = grant?.expires_at
        ? Date.parse(grant.expires_at) <= Date.now()
        : false;
      if (
        !grant ||
        grant.revoked_at ||
        grantExpired ||
        grant.run_id !== input.runId ||
        grant.orchestrator_agent_id !== input.orchestratorAgentId
      ) {
        // Action creation and grant validation share the caller's immediate
        // transaction. A controller-side lookup may choose a grant, but a
        // concurrent revocation or ownership change must still fail closed
        // before an executable action is persisted.
        return null;
      }
      if (input.flowInstanceId) {
        const flowInstance = this.getFlowInstance(input.flowInstanceId);
        if (
          !flowInstance ||
          flowInstance.run_id !== input.runId ||
          flowInstance.orchestrator_agent_id !== input.orchestratorAgentId ||
          flowInstance.originating_bridge_grant_id !== grant.bridge_grant_id
        ) {
          // The flow is the causal authority for every native action derived
          // from it. Keep this check beside the INSERT under BEGIN IMMEDIATE so
          // controller bugs or concurrent legacy repair cannot persist an
          // action under a sibling task grant.
          return null;
        }
      }
      if (input.operation === "interrupt_agent") {
        const openInterrupt = this.findOpenOrchestratorAction(input.agentId, ["interrupt_agent"]);
        if (openInterrupt) {
          if (openInterrupt.originating_bridge_grant_id !== grant.bridge_grant_id) {
            throw new Error(
              `Open interrupt action belongs to another bridge grant: ${openInterrupt.action_id}`
            );
          }
          return openInterrupt;
        }
      }
      const existing = this.getOrchestratorActionByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.originating_bridge_grant_id !== grant.bridge_grant_id) {
          // Idempotency never transfers execution authority. A rotated owner
          // must finish/cancel the old action and create a new generation.
          throw new Error(
            `Orchestrator action idempotency key belongs to another bridge grant: ${existing.action_id}`
          );
        }
        return existing;
      }
      const now = nowIso();
      const action: OrchestratorActionRecord = {
        action_id: newId("action"),
        idempotency_key: input.idempotencyKey,
        run_id: input.runId,
        orchestrator_agent_id: input.orchestratorAgentId,
        agent_id: input.agentId,
        flow_instance_id: input.flowInstanceId ?? null,
        step_instance_id: input.stepInstanceId ?? null,
        operation: input.operation,
        status: "pending",
        payload_json: input.payloadJson,
        result_json: null,
        error_json: null,
        originating_bridge_grant_id: grant.bridge_grant_id,
        claimed_by_bridge_grant_id: null,
        claim_owner_identity: null,
        claim_attempt: 0,
        claimed_at: null,
        claim_lease_expires_at: null,
        action_token_hash: null,
        created_at: now,
        updated_at: now,
        completed_at: null
      };
      try {
        // BEGIN IMMEDIATE serializes this predicate with shutdown's first
        // run-status write. Whichever transaction commits first becomes the
        // durable authority: shutdown either sees and cancels the inserted
        // action, or this INSERT observes stop intent and inserts nothing.
        const insert = this.db
          .prepare(
            `insert into orchestrator_actions (
              action_id, idempotency_key, run_id, orchestrator_agent_id, agent_id,
              flow_instance_id, step_instance_id, operation, status, payload_json,
              result_json, error_json, originating_bridge_grant_id,
              claimed_by_bridge_grant_id, claim_owner_identity,
              claim_attempt, claimed_at, claim_lease_expires_at, action_token_hash,
              created_at, updated_at, completed_at
            )
            select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            where ? = 'interrupt_agent'
               or (
                 ? in ('spawn_agent', 'send_message', 'followup_task')
                 and exists (
                   select 1 from runs
                   where runs.run_id = ? and runs.status not in ('stopping', 'stopped')
                 )
                 and exists (
                   select 1 from agents
                   where agents.agent_id = ? and agents.status not in ('stopping', 'stopped')
                 )
               )`
          )
          .run(
            action.action_id,
            action.idempotency_key,
            action.run_id,
            action.orchestrator_agent_id,
            action.agent_id,
            action.flow_instance_id,
            action.step_instance_id,
            action.operation,
            action.status,
            JSON.stringify(action.payload_json),
            null,
            null,
            action.originating_bridge_grant_id,
            null,
            null,
            0,
            null,
            null,
            null,
            action.created_at,
            action.updated_at,
            null,
            action.operation,
            action.operation,
            action.run_id,
            action.agent_id
          );
        if (insert.changes !== 1) {
          return null;
        }
      } catch (error) {
        // A concurrent dispatcher may win the unique idempotency key. Returning
        // that durable row makes spawn:<step_instance_id> safe across retries.
        const raced = this.getOrchestratorActionByIdempotencyKey(input.idempotencyKey);
        if (raced) {
          return raced;
        }
        throw error;
      }
      if (
        action.operation === "spawn_agent" ||
        action.operation === "send_message" ||
        action.operation === "followup_task"
      ) {
        // The action row is the durable acceptance boundary for native work.
        // Advance the agent fence in this same transaction only for a newly
        // inserted action; idempotent create-or-get replays return above and
        // therefore cannot consume another generation.
        const generation = this.db
          .prepare(
            `update agents
             set work_generation = work_generation + 1, updated_at = ?
             where agent_id = ?`
          )
          .run(now, action.agent_id);
        if (generation.changes !== 1) {
          throw new Error(
            `Agent not found while advancing native work generation: ${action.agent_id}`
          );
        }
      }
      return action;
    };
    // ACK and native-sync reconciliation can create a cleanup interrupt while
    // already holding a BEGIN IMMEDIATE reservation. Reuse that transaction
    // directly instead of opening a nested savepoint with ambiguous locking
    // semantics. Standalone callers still acquire the reservation before the
    // first read so action creation remains serialized with durable stop.
    return this.db.inTransaction
      ? create()
      : this.db.transaction(create).immediate();
  }

  getOrchestratorAction(actionId: string): OrchestratorActionRecord | null {
    if (!isOrchestratorActionId(actionId)) {
      return null;
    }
    const row = this.db
      .prepare("select * from orchestrator_actions where action_id = ?")
      .get(actionId) as Row | undefined;
    return row ? this.orchestratorActionFromRow(row) : null;
  }

  listOrchestratorActions(input: {
    runId?: string;
    agentId?: string;
    orchestratorAgentId?: string;
  } = {}): OrchestratorActionRecord[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (input.runId) {
      conditions.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.agentId) {
      conditions.push("(agent_id = ? or orchestrator_agent_id = ?)");
      values.push(input.agentId, input.agentId);
    }
    if (input.orchestratorAgentId) {
      conditions.push("orchestrator_agent_id = ?");
      values.push(input.orchestratorAgentId);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from orchestrator_actions ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.orchestratorActionFromRow(row));
  }

  getOrchestratorActionByIdempotencyKey(idempotencyKey: string): OrchestratorActionRecord | null {
    const row = this.db
      .prepare("select * from orchestrator_actions where idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return row ? this.orchestratorActionFromRow(row) : null;
  }

  findOpenOrchestratorAction(
    agentId: string,
    operations: OrchestratorActionOperation[]
  ): OrchestratorActionRecord | null {
    if (operations.length === 0) {
      return null;
    }
    const placeholders = operations.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `select * from orchestrator_actions
         where agent_id = ? and operation in (${placeholders}) and status in ('pending', 'claimed')
         order by created_at desc
         limit 1`
      )
      .get(agentId, ...operations) as Row | undefined;
    return row ? this.orchestratorActionFromRow(row) : null;
  }

  claimOrchestratorAction(input: {
    actionId: string;
    bridgeTokenHash: string;
    actionTokenHash: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }):
    | { type: "claimed"; action: OrchestratorActionRecord }
    | { type: "already_claimed"; action: OrchestratorActionRecord; retryAfterMs: number }
    | {
        type: "authorization_failed";
        action: OrchestratorActionRecord | null;
        reason:
          | "invalid_grant"
          | "revoked_grant"
          | "expired_grant"
          | "scope_mismatch"
          | "unbound_action"
          | "action_grant_mismatch";
      }
    | {
        type: "unavailable";
        action: OrchestratorActionRecord | null;
        reason: "missing" | "status" | "stop_intent";
      } {
    return this.immediateTransaction(() => {
      const current = this.getOrchestratorAction(input.actionId);
      if (!current) {
        return { type: "unavailable" as const, action: null, reason: "missing" as const };
      }
      const grant = this.getBridgeGrantByTokenHash(input.bridgeTokenHash);
      if (!grant) {
        return {
          type: "authorization_failed" as const,
          action: current,
          reason: "invalid_grant" as const
        };
      }
      if (grant.revoked_at) {
        return {
          type: "authorization_failed" as const,
          action: current,
          reason: "revoked_grant" as const
        };
      }
      if (grant.expires_at && Date.parse(grant.expires_at) <= Date.parse(input.claimedAt)) {
        return {
          type: "authorization_failed" as const,
          action: current,
          reason: "expired_grant" as const
        };
      }
      if (
        grant.run_id !== current.run_id ||
        grant.orchestrator_agent_id !== current.orchestrator_agent_id
      ) {
        return {
          type: "authorization_failed" as const,
          action: current,
          reason: "scope_mismatch" as const
        };
      }
      if (!current.originating_bridge_grant_id) {
        return {
          type: "authorization_failed" as const,
          action: current,
          reason: "unbound_action" as const
        };
      }
      if (current.originating_bridge_grant_id !== grant.bridge_grant_id) {
        return {
          type: "authorization_failed" as const,
          action: current,
          reason: "action_grant_mismatch" as const
        };
      }

      // Grant authorization, lease ownership, and token rotation share this
      // BEGIN IMMEDIATE point of linearization. A revocation or scope mutation
      // that commits first is observed above; one that starts later waits until
      // this claim has durably recorded its owner and one-time action token.
      this.touchBridgeGrant(grant.bridge_grant_id, input.claimedAt);
      if (current.status === "claimed" && current.claim_lease_expires_at) {
        const remaining = Date.parse(current.claim_lease_expires_at) - Date.parse(input.claimedAt);
        if (remaining > 0) {
          return {
            type: "already_claimed" as const,
            action: current,
            retryAfterMs: remaining
          };
        }
      } else if (current.status !== "pending") {
        return {
          type: "unavailable" as const,
          action: current,
          reason: "status" as const
        };
      }

      // Reclaiming an expired lease rotates the action token in the same write
      // that increments the attempt. The SQL predicate is the authority for
      // both lease ownership and durable stop intent: a controller-side check
      // alone would leave a cross-process window where shutdown and reclaim
      // could race. Interrupts bypass the stop predicate because they are the
      // cleanup operation; spawn/message/follow-up actions never do.
      const update = this.db
        .prepare(
          `update orchestrator_actions
           set status = 'claimed', claimed_by_bridge_grant_id = ?, claim_owner_identity = ?,
               claim_attempt = claim_attempt + 1, claimed_at = ?, claim_lease_expires_at = ?,
               action_token_hash = ?, updated_at = ?
           where action_id = ?
             and (
               status = 'pending'
               or (
                 status = 'claimed'
                 and claim_lease_expires_at is not null
                 and claim_lease_expires_at <= ?
               )
             )
             and (
               operation = 'interrupt_agent'
               or (
                 operation in ('spawn_agent', 'send_message', 'followup_task')
                 and exists (
                   select 1 from runs
                   where runs.run_id = orchestrator_actions.run_id
                     and runs.status not in ('stopping', 'stopped')
                 )
                 and exists (
                   select 1 from agents
                   where agents.agent_id = orchestrator_actions.agent_id
                     and agents.status not in ('stopping', 'stopped')
                 )
               )
             )`
        )
        .run(
          grant.bridge_grant_id,
          grant.owner_task_identity ?? grant.owner_task_path,
          input.claimedAt,
          input.leaseExpiresAt,
          input.actionTokenHash,
          input.claimedAt,
          input.actionId,
          input.claimedAt
        );
      if (update.changes !== 1) {
        const latest = this.getOrchestratorAction(input.actionId);
        if (latest?.status === "claimed" && latest.claim_lease_expires_at) {
          const remaining =
            Date.parse(latest.claim_lease_expires_at) - Date.parse(input.claimedAt);
          if (remaining > 0) {
            return {
              type: "already_claimed" as const,
              action: latest,
              retryAfterMs: remaining
            };
          }
        }
        const latestRun = latest ? this.getRun(latest.run_id) : null;
        const latestAgent = latest ? this.getAgent(latest.agent_id) : null;
        const blockedByStopIntent = Boolean(
          latest &&
            (latest.status === "pending" || latest.status === "claimed") &&
            latest.operation !== "interrupt_agent" &&
            (latestRun?.status === "stopping" ||
              latestRun?.status === "stopped" ||
              latestAgent?.status === "stopping" ||
              latestAgent?.status === "stopped")
        );
        return {
          type: "unavailable" as const,
          action: latest,
          reason: blockedByStopIntent ? ("stop_intent" as const) : ("status" as const)
        };
      }
      return { type: "claimed" as const, action: this.getOrchestratorAction(input.actionId)! };
    });
  }

  completeOrchestratorAction(input: {
    actionId: string;
    actionTokenHash: string;
    status: Extract<OrchestratorActionStatus, "succeeded" | "failed">;
    resultJson?: Record<string, unknown> | null;
    errorJson?: Record<string, unknown> | null;
    completedAt?: string;
  }): { action: OrchestratorActionRecord; changed: boolean } {
    const completedAt = input.completedAt ?? nowIso();
    // Token validation and the claimed -> terminal transition must be one
    // atomic write. Otherwise an expired claim could be reclaimed (rotating
    // its token) between a controller-side read and this update, allowing the
    // previous owner to acknowledge an action it no longer owns.
    const update = this.db
      .prepare(
        `update orchestrator_actions
         set status = ?, result_json = ?, error_json = ?, completed_at = ?, updated_at = ?
         where action_id = ? and status = 'claimed' and action_token_hash = ?`
      )
      .run(
        input.status,
        input.resultJson ? JSON.stringify(input.resultJson) : null,
        input.errorJson ? JSON.stringify(input.errorJson) : null,
        completedAt,
        completedAt,
        input.actionId,
        input.actionTokenHash
      );
    const action = this.getOrchestratorAction(input.actionId);
    if (!action) {
      throw new Error(`Orchestrator action not found after completion: ${input.actionId}`);
    }
    return { action, changed: update.changes === 1 };
  }

  cancelUnclaimedOrchestratorAction(input: {
    actionId: string;
    errorJson: Record<string, unknown>;
    cancelledAt?: string;
  }): { action: OrchestratorActionRecord; changed: boolean } {
    const cancelledAt = input.cancelledAt ?? nowIso();
    // The claim and cancellation predicates compete in SQLite, so a root that
    // has already claimed (or is claiming) any native action always wins over
    // a cancellation that can no longer prove the operation did not execute.
    const update = this.db
      .prepare(
        `update orchestrator_actions
         set status = 'cancelled', error_json = ?, completed_at = ?, updated_at = ?
         where action_id = ? and status = 'pending' and claim_attempt = 0
           and claimed_by_bridge_grant_id is null and action_token_hash is null`
      )
      .run(
        JSON.stringify(input.errorJson),
        cancelledAt,
        cancelledAt,
        input.actionId
      );
    const action = this.getOrchestratorAction(input.actionId);
    if (!action) {
      throw new Error(`Orchestrator action not found after cancellation: ${input.actionId}`);
    }
    return { action, changed: update.changes === 1 };
  }

  getCodexSubagentExternalState(agentId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("select * from codex_subagent_external_states where agent_id = ?")
      .get(agentId) as Row | undefined;
    return row ?? null;
  }

  upsertCodexSubagentExternalState(input: {
    agentId: string;
    nativeAgentId?: string | null;
    nativeTaskName?: string | null;
    nativeTaskPath?: string | null;
    nativeStatus: string;
    latestMessage?: string | null;
    observedAt: string;
    missingSince?: string | null;
    missingObservationCount: number;
  }): void {
    this.db
      .prepare(
        `insert into codex_subagent_external_states (
          agent_id, native_agent_id, native_task_name, native_task_path, native_status,
          latest_message, observed_at, missing_since, missing_observation_count, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(agent_id) do update set
          native_agent_id = excluded.native_agent_id,
          native_task_name = excluded.native_task_name,
          native_task_path = excluded.native_task_path,
          native_status = excluded.native_status,
          latest_message = excluded.latest_message,
          observed_at = excluded.observed_at,
          missing_since = excluded.missing_since,
          missing_observation_count = excluded.missing_observation_count,
          updated_at = excluded.updated_at`
      )
      .run(
        input.agentId,
        input.nativeAgentId ?? null,
        input.nativeTaskName ?? null,
        input.nativeTaskPath ?? null,
        input.nativeStatus,
        input.latestMessage ?? null,
        input.observedAt,
        input.missingSince ?? null,
        input.missingObservationCount,
        input.observedAt
      );
  }

  createEvent(input: {
    eventId?: string;
    runId?: string | null;
    agentId?: string | null;
    type: EventType;
    payload?: Record<string, unknown>;
  }): EventRecord {
    const event: EventRecord = {
      event_id: input.eventId ?? newId("event"),
      run_id: input.runId ?? null,
      agent_id: input.agentId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      created_at: nowIso()
    };
    const insert = (): void => {
      this.db
        .prepare(
          "insert into events (event_id, run_id, agent_id, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?)"
        )
        .run(
          event.event_id,
          event.run_id,
          event.agent_id,
          event.type,
          JSON.stringify(event.payload),
          event.created_at
        );
    };
    try {
      insert();
      return event;
    } catch (error) {
      if (!input.eventId) {
        throw error;
      }
      const row = this.db
        .prepare("select * from events where event_id = ?")
        .get(input.eventId) as Row | undefined;
      const existing = row ? this.eventFromRow(row) : null;
      if (
        !existing ||
        existing.run_id !== event.run_id ||
        existing.agent_id !== event.agent_id ||
        existing.type !== event.type ||
        JSON.stringify(existing.payload) !== JSON.stringify(event.payload)
      ) {
        throw error;
      }
      // Deterministic controller events use their primary key as a durable
      // idempotency boundary. Returning the exact existing row also lets the
      // subscription delivery claim suppress a concurrent/retried wakeup.
      return existing;
    }
  }

  listEvents(input: {
    runId?: string;
    agentId?: string;
    type?: EventType;
    limit?: number;
  } = {}): EventRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.agentId) {
      clauses.push("agent_id = ?");
      values.push(input.agentId);
    }
    if (input.type) {
      clauses.push("type = ?");
      values.push(input.type);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    values.push(input.limit ?? 50);
    const rows = this.db
      .prepare(`select * from events ${where} order by created_at desc limit ?`)
      .all(...values) as Row[];
    return rows.map((row) => this.eventFromRow(row));
  }

  getEvent(eventId: string): EventRecord | null {
    const row = this.db
      .prepare("select * from events where event_id = ?")
      .get(eventId) as Row | undefined;
    return row ? this.eventFromRow(row) : null;
  }

  createSubscription(input: {
    runId?: string | null;
    sourceAgentId?: string | null;
    subscriberAgentId: string;
    eventType: EventType;
  }): SubscriptionRecord {
    const now = nowIso();
    const subscription: SubscriptionRecord = {
      subscription_id: newId("sub"),
      run_id: input.runId ?? null,
      source_agent_id: input.sourceAgentId ?? null,
      subscriber_agent_id: input.subscriberAgentId,
      event_type: input.eventType,
      enabled: true,
      last_delivered_event_id: null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into subscriptions (
          subscription_id, run_id, source_agent_id, subscriber_agent_id, event_type,
          enabled, last_delivered_event_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        subscription.subscription_id,
        subscription.run_id,
        subscription.source_agent_id,
        subscription.subscriber_agent_id,
        subscription.event_type,
        1,
        null,
        subscription.created_at,
        subscription.updated_at
      );
    return subscription;
  }

  listSubscriptions(input: { runId?: string; enabledOnly?: boolean } = {}): SubscriptionRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.enabledOnly) {
      clauses.push("enabled = 1");
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from subscriptions ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.subscriptionFromRow(row));
  }

  /**
   * Claim one logical event/subscriber delivery across every matching
   * subscription row and controller process. The durable attempt ordinal is
   * also the idempotency identity for the physical adapter invocation. Only a
   * stale pre-invocation claim is reclaimable; `beginSubscriptionDeliveryAttempt`
   * changes it to a non-stealable phase before external I/O. Observed adapter
   * failures explicitly release that phase for a safe retry.
   */
  claimSubscriptionDelivery(input: {
    eventId: string;
    subscriberAgentId: string;
    claimOwnerId: string;
    claimTtlMs?: number;
  }): { claimed: boolean; delivery: SubscriptionDeliveryRecord } {
    return this.immediateTransaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          `insert into subscription_deliveries (
             event_id, subscriber_agent_id, status, claim_attempt,
             claim_owner_id, claimed_at, last_error_json, delivered_at,
             created_at, updated_at
           ) values (?, ?, 'pending', 0, null, null, null, null, ?, ?)
           on conflict(event_id, subscriber_agent_id) do nothing`
        )
        .run(input.eventId, input.subscriberAgentId, now, now);
      const stalePreparedClaimBefore = new Date(
        Date.now() - (input.claimTtlMs ?? 1_000)
      ).toISOString();
      const claim = this.db
        .prepare(
          `update subscription_deliveries
           set status = 'claimed', claim_attempt = claim_attempt + 1,
               claim_owner_id = ?, claimed_at = ?, updated_at = ?
           where event_id = ? and subscriber_agent_id = ?
             and (
               status = 'pending'
               or (
                 status = 'claimed'
                 and (claimed_at is null or claimed_at < ?)
               )
             )`
        )
        .run(
          input.claimOwnerId,
          now,
          now,
          input.eventId,
          input.subscriberAgentId,
          stalePreparedClaimBefore
        );
      return {
        claimed: claim.changes === 1,
        delivery: this.requireSubscriptionDelivery(
          input.eventId,
          input.subscriberAgentId
        )
      };
    });
  }

  /**
   * Atomically cross the adapter-call boundary for a claimed delivery. A
   * stale prepared claim may be reclaimed, but an `invoking` delivery is never
   * stolen because its external acceptance outcome is already uncertain.
   */
  beginSubscriptionDeliveryAttempt(input: {
    eventId: string;
    subscriberAgentId: string;
    claimOwnerId: string;
    claimAttempt: number;
    acceptanceKey: string;
    acceptanceLeaseExpiresAt: string;
  }):
    | { type: "began"; began: true; agent: AgentRecord }
    | { type: "claim_lost"; began: false; agent: AgentRecord }
    | { type: "already_accepted"; began: false; agent: AgentRecord }
    | { type: "stop_intent"; began: false; agent: AgentRecord } {
    return this.immediateTransaction(() => {
      const delivery = this.requireSubscriptionDelivery(
        input.eventId,
        input.subscriberAgentId
      );
      const agent = this.getAgent(input.subscriberAgentId);
      if (!agent) {
        throw new Error(
          `Subscription subscriber not found: ${input.subscriberAgentId}`
        );
      }
      if (
        delivery.status !== "claimed" ||
        delivery.claim_owner_id !== input.claimOwnerId ||
        delivery.claim_attempt !== input.claimAttempt
      ) {
        return { type: "claim_lost", began: false, agent };
      }

      const accepted = this.advanceAgentWorkGenerationForAcceptedWork(
        input.subscriberAgentId,
        input.acceptanceKey,
        {
          claimOwnerId: input.claimOwnerId,
          leaseExpiresAt: input.acceptanceLeaseExpiresAt,
          deliveryEventId: input.eventId,
          deliveryClaimAttempt: input.claimAttempt,
          projectStatus: "running",
          failureReason: null
        }
      );
      if (accepted.type === "stop_intent") {
        // Stop won before this delivery crossed the durable invocation
        // boundary. Close the logical claim so another controller cannot
        // repeatedly reclaim it and attempt physical I/O during cleanup.
        this.db
          .prepare(
            `update subscription_deliveries
             set status = 'failed', claim_owner_id = null, claimed_at = null,
                 last_error_json = ?, updated_at = ?
             where event_id = ? and subscriber_agent_id = ? and status = 'claimed'
               and claim_owner_id = ? and claim_attempt = ?`
          )
          .run(
            JSON.stringify({ reason: "durable_stop_intent" }),
            nowIso(),
            input.eventId,
            input.subscriberAgentId,
            input.claimOwnerId,
            input.claimAttempt
          );
        return { type: "stop_intent", began: false, agent: accepted.agent };
      }
      if (accepted.type === "already_accepted") {
        // This key may represent I/O performed by a process that died before
        // updating the delivery row. Close it as ambiguity; reclaiming it as a
        // fresh attempt would duplicate possibly accepted notification work.
        this.db
          .prepare(
            `update subscription_deliveries
             set status = 'ambiguous', claim_owner_id = null, claimed_at = null,
                 last_error_json = ?, updated_at = ?
             where event_id = ? and subscriber_agent_id = ? and status = 'claimed'
               and claim_owner_id = ? and claim_attempt = ?`
          )
          .run(
            JSON.stringify({
              reason: "delivery_acceptance_already_recorded",
              acceptance_key: input.acceptanceKey
            }),
            nowIso(),
            input.eventId,
            input.subscriberAgentId,
            input.claimOwnerId,
            input.claimAttempt
          );
        return { type: "already_accepted", began: false, agent: accepted.agent };
      }
      const invocation = this.db
        .prepare(
          `update subscription_deliveries
           set status = 'invoking', updated_at = ?
           where event_id = ? and subscriber_agent_id = ? and status = 'claimed'
             and claim_owner_id = ? and claim_attempt = ?`
        )
        .run(
          nowIso(),
          input.eventId,
          input.subscriberAgentId,
          input.claimOwnerId,
          input.claimAttempt
        );
      if (invocation.changes !== 1) {
        throw new Error(
          `Subscription delivery claim changed before invocation: ${input.eventId}:${input.subscriberAgentId}`
        );
      }
      return { type: "began", began: true, agent: accepted.agent };
    });
  }

  releaseSubscriptionDelivery(input: {
    eventId: string;
    subscriberAgentId: string;
    claimOwnerId: string;
    claimAttempt: number;
    error: Record<string, unknown>;
  }): SubscriptionDeliveryRecord {
    const releasedAt = nowIso();
    this.db
      .prepare(
        `update subscription_deliveries
         set status = 'pending', claim_owner_id = null, claimed_at = null,
             last_error_json = ?, updated_at = ?
         where event_id = ? and subscriber_agent_id = ?
           and status in ('claimed', 'invoking')
           and claim_owner_id = ? and claim_attempt = ?`
      )
      .run(
        JSON.stringify(input.error),
        releasedAt,
        input.eventId,
        input.subscriberAgentId,
        input.claimOwnerId,
        input.claimAttempt
      );
    return this.requireSubscriptionDelivery(input.eventId, input.subscriberAgentId);
  }

  failSubscriptionDelivery(input: {
    eventId: string;
    subscriberAgentId: string;
    claimOwnerId: string;
    claimAttempt: number;
    error: Record<string, unknown>;
  }): SubscriptionDeliveryRecord {
    const failedAt = nowIso();
    this.db
      .prepare(
        `update subscription_deliveries
         set status = 'failed', claim_owner_id = null, claimed_at = null,
             last_error_json = ?, updated_at = ?
         where event_id = ? and subscriber_agent_id = ? and status = 'claimed'
           and claim_owner_id = ? and claim_attempt = ?`
      )
      .run(
        JSON.stringify(input.error),
        failedAt,
        input.eventId,
        input.subscriberAgentId,
        input.claimOwnerId,
        input.claimAttempt
      );
    return this.requireSubscriptionDelivery(input.eventId, input.subscriberAgentId);
  }

  completeSubscriptionDelivery(input: {
    event: EventRecord;
    subscriberAgentId: string;
    claimOwnerId: string;
    claimAttempt: number;
  }): { completed: boolean; delivery: SubscriptionDeliveryRecord } {
    return this.immediateTransaction(() => {
      const deliveredAt = nowIso();
      const completion = this.db
        .prepare(
          `update subscription_deliveries
           set status = 'delivered', claim_owner_id = null, claimed_at = null,
               last_error_json = null, delivered_at = ?, updated_at = ?
           where event_id = ? and subscriber_agent_id = ? and status = 'invoking'
             and claim_owner_id = ? and claim_attempt = ?`
        )
        .run(
          deliveredAt,
          deliveredAt,
          input.event.event_id,
          input.subscriberAgentId,
          input.claimOwnerId,
          input.claimAttempt
        );
      if (completion.changes === 1) {
        // Update every row matching the same logical event/subscriber predicate,
        // including duplicates inserted by another controller during the send.
        this.db
          .prepare(
            `update subscriptions
             set last_delivered_event_id = ?, delivery_claim_event_id = null,
                 delivery_claimed_at = null, updated_at = ?
             where subscriber_agent_id = ? and event_type = ?
               and (run_id is null or run_id is ?)
               and (source_agent_id is null or source_agent_id is ?)`
          )
          .run(
            input.event.event_id,
            deliveredAt,
            input.subscriberAgentId,
            input.event.type,
            input.event.run_id,
            input.event.agent_id
          );
      }
      return {
        completed: completion.changes === 1,
        delivery: this.requireSubscriptionDelivery(
          input.event.event_id,
          input.subscriberAgentId
        )
      };
    });
  }

  getSubscriptionDelivery(
    eventId: string,
    subscriberAgentId: string
  ): SubscriptionDeliveryRecord | null {
    const row = this.db
      .prepare(
        `select * from subscription_deliveries
         where event_id = ? and subscriber_agent_id = ?`
      )
      .get(eventId, subscriberAgentId) as Row | undefined;
    return row ? this.subscriptionDeliveryFromRow(row) : null;
  }

  private requireSubscriptionDelivery(
    eventId: string,
    subscriberAgentId: string
  ): SubscriptionDeliveryRecord {
    const delivery = this.getSubscriptionDelivery(eventId, subscriberAgentId);
    if (!delivery) {
      throw new Error(
        `Subscription delivery not found: ${eventId}:${subscriberAgentId}`
      );
    }
    return delivery;
  }

  updateSubscriptionDelivery(subscriptionId: string, eventId: string): void {
    this.db
      .prepare(
        "update subscriptions set last_delivered_event_id = ?, delivery_claim_event_id = null, delivery_claimed_at = null, updated_at = ? where subscription_id = ?"
      )
      .run(eventId, nowIso(), subscriptionId);
  }

  tryClaimSubscriptionDelivery(subscriptionId: string, eventId: string, claimTtlMs = 300_000): boolean {
    const now = nowIso();
    const staleBefore = new Date(Date.now() - claimTtlMs).toISOString();
    const result = this.db
      .prepare(
        `update subscriptions
         set delivery_claim_event_id = ?, delivery_claimed_at = ?, updated_at = ?
         where subscription_id = ?
           and enabled = 1
           and (last_delivered_event_id is null or last_delivered_event_id != ?)
           and (delivery_claim_event_id is null or delivery_claimed_at is null or delivery_claimed_at < ?)`
      )
      .run(eventId, now, now, subscriptionId, eventId, staleBefore);
    return result.changes > 0;
  }

  clearSubscriptionDeliveryClaim(subscriptionId: string, eventId: string): void {
    this.db
      .prepare(
        `update subscriptions
         set delivery_claim_event_id = null, delivery_claimed_at = null, updated_at = ?
         where subscription_id = ? and delivery_claim_event_id = ?`
      )
      .run(nowIso(), subscriptionId, eventId);
  }

  deleteSubscription(subscriptionId: string): void {
    this.db.prepare("delete from subscriptions where subscription_id = ?").run(subscriptionId);
  }

  createHeartbeat(input: {
    agentId: string;
    idleTimeoutMs: number;
    reminderIntervalMs?: number | null;
  }): HeartbeatRecord {
    const now = nowIso();
    const heartbeat: HeartbeatRecord = {
      heartbeat_id: newId("heartbeat"),
      agent_id: input.agentId,
      idle_timeout_ms: input.idleTimeoutMs,
      reminder_interval_ms: input.reminderIntervalMs ?? null,
      last_event_at: now,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into heartbeats (
          heartbeat_id, agent_id, idle_timeout_ms, reminder_interval_ms,
          last_event_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        heartbeat.heartbeat_id,
        heartbeat.agent_id,
        heartbeat.idle_timeout_ms,
        heartbeat.reminder_interval_ms,
        heartbeat.last_event_at,
        heartbeat.created_at,
        heartbeat.updated_at
      );
    return heartbeat;
  }

  listHeartbeats(agentId?: string): HeartbeatRecord[] {
    const rows = agentId
      ? (this.db
          .prepare("select * from heartbeats where agent_id = ? order by created_at asc")
          .all(agentId) as Row[])
      : (this.db.prepare("select * from heartbeats order by created_at asc").all() as Row[]);
    return rows.map((row) => this.heartbeatFromRow(row));
  }

  touchHeartbeat(agentId: string, at = nowIso()): void {
    this.db
      .prepare("update heartbeats set last_event_at = ?, updated_at = ? where agent_id = ?")
      .run(at, nowIso(), agentId);
  }

  deleteHeartbeat(heartbeatId: string): void {
    this.db.prepare("delete from heartbeats where heartbeat_id = ?").run(heartbeatId);
  }

  createGoal(input: { agentId: string; objective: string }): GoalRecord {
    const now = nowIso();
    const goal: GoalRecord = {
      goal_id: newId("goal"),
      agent_id: input.agentId,
      objective: input.objective,
      status: "active",
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        "insert into goals (goal_id, agent_id, objective, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(goal.goal_id, goal.agent_id, goal.objective, goal.status, goal.created_at, goal.updated_at);
    return goal;
  }

  getGoal(goalId: string): GoalRecord | null {
    const row = this.db.prepare("select * from goals where goal_id = ?").get(goalId) as Row | undefined;
    return row ? this.goalFromRow(row) : null;
  }

  listGoals(agentId?: string): GoalRecord[] {
    const rows = agentId
      ? (this.db.prepare("select * from goals where agent_id = ? order by created_at asc").all(agentId) as Row[])
      : (this.db.prepare("select * from goals order by created_at asc").all() as Row[]);
    return rows.map((row) => this.goalFromRow(row));
  }

  updateGoal(goalId: string, status: GoalStatus): GoalRecord {
    this.db
      .prepare("update goals set status = ?, updated_at = ? where goal_id = ?")
      .run(status, nowIso(), goalId);
    const goal = this.getGoal(goalId);
    if (!goal) {
      throw new Error(`Goal not found after update: ${goalId}`);
    }
    return goal;
  }

  deleteGoal(goalId: string): void {
    this.db.prepare("delete from goals where goal_id = ?").run(goalId);
  }

  createArtifact(input: {
    runId?: string | null;
    agentId?: string | null;
    label: string;
    path: string;
    expected?: boolean;
  }): ArtifactRecord {
    const now = nowIso();
    const artifact: ArtifactRecord = {
      artifact_id: newId("artifact"),
      run_id: input.runId ?? null,
      agent_id: input.agentId ?? null,
      label: input.label,
      path: input.path,
      expected: input.expected ?? false,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        "insert into artifacts (artifact_id, run_id, agent_id, label, path, expected, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        artifact.artifact_id,
        artifact.run_id,
        artifact.agent_id,
        artifact.label,
        artifact.path,
        artifact.expected ? 1 : 0,
        artifact.created_at,
        artifact.updated_at
      );
    return artifact;
  }

  listArtifacts(input: { runId?: string; agentId?: string } = {}): ArtifactRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.agentId) {
      clauses.push("agent_id = ?");
      values.push(input.agentId);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from artifacts ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.artifactFromRow(row));
  }

  createAgentLink(input: {
    runId: string;
    sourceAgentId: string;
    targetAgentId: string;
    type: AgentLinkType;
    label?: string | null;
  }): AgentLinkRecord {
    const now = nowIso();
    const link: AgentLinkRecord = {
      link_id: newId("link"),
      run_id: input.runId,
      source_agent_id: input.sourceAgentId,
      target_agent_id: input.targetAgentId,
      type: input.type,
      label: input.label ?? null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into agent_links (
          link_id, run_id, source_agent_id, target_agent_id, type, label, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        link.link_id,
        link.run_id,
        link.source_agent_id,
        link.target_agent_id,
        link.type,
        link.label,
        link.created_at,
        link.updated_at
      );
    return link;
  }

  listAgentLinks(input: { runId?: string; agentId?: string } = {}): AgentLinkRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.agentId) {
      clauses.push("(source_agent_id = ? or target_agent_id = ?)");
      values.push(input.agentId, input.agentId);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from agent_links ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.agentLinkFromRow(row));
  }

  deleteAgentLink(linkId: string): void {
    this.db.prepare("delete from agent_links where link_id = ?").run(linkId);
  }

  createUsageSnapshot(input: {
    runId: string;
    agentId: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    contextUsed?: number | null;
    contextLimit?: number | null;
    source?: string | null;
    model?: string | null;
    capturedAt?: string | null;
  }): UsageSnapshotRecord {
    const snapshot: UsageSnapshotRecord = {
      usage_id: newId("usage"),
      run_id: input.runId,
      agent_id: input.agentId,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      context_used: input.contextUsed ?? null,
      context_limit: input.contextLimit ?? null,
      source: input.source ?? null,
      model: input.model ?? null,
      captured_at: input.capturedAt ?? nowIso()
    };
    this.db
      .prepare(
        `insert into usage_snapshots (
          usage_id, run_id, agent_id, input_tokens, output_tokens, total_tokens,
          context_used, context_limit, source, model, captured_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.usage_id,
        snapshot.run_id,
        snapshot.agent_id,
        snapshot.input_tokens,
        snapshot.output_tokens,
        snapshot.total_tokens,
        snapshot.context_used,
        snapshot.context_limit,
        snapshot.source,
        snapshot.model,
        snapshot.captured_at
      );
    return snapshot;
  }

  listUsageSnapshots(input: { runId?: string; agentId?: string; limit?: number } = {}): UsageSnapshotRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.agentId) {
      clauses.push("agent_id = ?");
      values.push(input.agentId);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    values.push(input.limit ?? 500);
    const rows = this.db
      .prepare(`select * from usage_snapshots ${where} order by captured_at desc limit ?`)
      .all(...values) as Row[];
    return rows.map((row) => this.usageSnapshotFromRow(row));
  }

  createFlow(config: FlowConfig): FlowRecord {
    const now = nowIso();
    const flow: FlowRecord = {
      flow_record_id: newId("flow"),
      flow_id: config.id,
      version: config.version ?? null,
      description: config.description ?? null,
      config,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into flows (
          flow_record_id, flow_id, version, description, config_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        flow.flow_record_id,
        flow.flow_id,
        flow.version,
        flow.description,
        JSON.stringify(flow.config),
        flow.created_at,
        flow.updated_at
      );
    return flow;
  }

  getFlow(flowRecordId: string): FlowRecord | null {
    const row = this.db.prepare("select * from flows where flow_record_id = ?").get(flowRecordId) as
      | Row
      | undefined;
    return row ? this.flowFromRow(row) : null;
  }

  createFlowInstance(input: {
    flowRecordId: string;
    runId: string;
    orchestratorAgentId?: string | null;
    originatingBridgeGrantId?: string | null;
    currentStepId?: string | null;
  }): FlowInstanceRecord {
    const now = nowIso();
    const instance: FlowInstanceRecord = {
      flow_instance_id: newId("flowinst"),
      flow_record_id: input.flowRecordId,
      run_id: input.runId,
      orchestrator_agent_id: input.orchestratorAgentId ?? null,
      originating_bridge_grant_id: input.originatingBridgeGrantId ?? null,
      status: "active",
      current_step_id: input.currentStepId ?? null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into flow_instances (
          flow_instance_id, flow_record_id, run_id, orchestrator_agent_id,
          originating_bridge_grant_id, status, current_step_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        instance.flow_instance_id,
        instance.flow_record_id,
        instance.run_id,
        instance.orchestrator_agent_id,
        instance.originating_bridge_grant_id,
        instance.status,
        instance.current_step_id,
        instance.created_at,
        instance.updated_at
      );
    return instance;
  }

  getFlowInstance(flowInstanceId: string): FlowInstanceRecord | null {
    const row = this.db
      .prepare("select * from flow_instances where flow_instance_id = ?")
      .get(flowInstanceId) as Row | undefined;
    return row ? this.flowInstanceFromRow(row) : null;
  }

  listFlowInstances(input: { runId?: string } = {}): FlowInstanceRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from flow_instances ${where} order by created_at asc`)
      .all(...values) as Row[];
    return rows.map((row) => this.flowInstanceFromRow(row));
  }

  updateFlowInstance(
    flowInstanceId: string,
    patch: Partial<{ status: FlowInstanceStatus; currentStepId: string | null }>
  ): FlowInstanceRecord {
    const assignments = ["updated_at = ?"];
    const values: unknown[] = [nowIso()];
    if (patch.status) {
      assignments.push("status = ?");
      values.push(patch.status);
    }
    if ("currentStepId" in patch) {
      assignments.push("current_step_id = ?");
      values.push(patch.currentStepId ?? null);
    }
    values.push(flowInstanceId);
    this.db
      .prepare(`update flow_instances set ${assignments.join(", ")} where flow_instance_id = ?`)
      .run(...values);
    const instance = this.getFlowInstance(flowInstanceId);
    if (!instance) {
      throw new Error(`Flow instance not found after update: ${flowInstanceId}`);
    }
    return instance;
  }

  createFlowStepInstance(input: {
    stepInstanceId?: string | null;
    flowInstanceId: string;
    stepId: string;
    agentId?: string | null;
    inputJson?: Record<string, unknown>;
  }): FlowStepInstanceRecord {
    const now = nowIso();
    const step: FlowStepInstanceRecord = {
      step_instance_id: input.stepInstanceId ?? newId("flowstep"),
      flow_instance_id: input.flowInstanceId,
      step_id: input.stepId,
      agent_id: input.agentId ?? null,
      status: "active",
      input_json: input.inputJson ?? {},
      output_json: {},
      result_json: {},
      transition_id: null,
      summary: null,
      created_at: now,
      updated_at: now,
      completed_at: null
    };
    this.db
      .prepare(
        `insert into flow_step_instances (
          step_instance_id, flow_instance_id, step_id, agent_id, status, input_json,
          output_json, result_json, transition_id, summary, created_at, updated_at,
          completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        step.step_instance_id,
        step.flow_instance_id,
        step.step_id,
        step.agent_id,
        step.status,
        JSON.stringify(step.input_json),
        JSON.stringify(step.output_json),
        JSON.stringify(step.result_json),
        step.transition_id,
        step.summary,
        step.created_at,
        step.updated_at,
        step.completed_at
      );
    return step;
  }

  getFlowStepInstance(stepInstanceId: string): FlowStepInstanceRecord | null {
    const row = this.db
      .prepare("select * from flow_step_instances where step_instance_id = ?")
      .get(stepInstanceId) as Row | undefined;
    return row ? this.flowStepInstanceFromRow(row) : null;
  }

  listFlowStepInstances(flowInstanceId: string): FlowStepInstanceRecord[] {
    const rows = this.db
      .prepare("select * from flow_step_instances where flow_instance_id = ? order by created_at asc")
      .all(flowInstanceId) as Row[];
    return rows.map((row) => this.flowStepInstanceFromRow(row));
  }

  updateFlowStepInstance(
    stepInstanceId: string,
    patch: Partial<{
      status: FlowStepInstanceStatus;
      inputJson: Record<string, unknown>;
      outputJson: Record<string, unknown>;
      resultJson: Record<string, unknown>;
      agentId: string | null;
      transitionId: string | null;
      summary: string | null;
      completedAt: string | null;
    }>
  ): FlowStepInstanceRecord {
    const assignments = ["updated_at = ?"];
    const values: unknown[] = [nowIso()];
    if (patch.status) {
      assignments.push("status = ?");
      values.push(patch.status);
    }
    if (patch.inputJson) {
      assignments.push("input_json = ?");
      values.push(JSON.stringify(patch.inputJson));
    }
    if (patch.outputJson) {
      assignments.push("output_json = ?");
      values.push(JSON.stringify(patch.outputJson));
    }
    if (patch.resultJson) {
      assignments.push("result_json = ?");
      values.push(JSON.stringify(patch.resultJson));
    }
    if ("agentId" in patch) {
      assignments.push("agent_id = ?");
      values.push(patch.agentId ?? null);
    }
    if ("transitionId" in patch) {
      assignments.push("transition_id = ?");
      values.push(patch.transitionId ?? null);
    }
    if ("summary" in patch) {
      assignments.push("summary = ?");
      values.push(patch.summary ?? null);
    }
    if ("completedAt" in patch) {
      assignments.push("completed_at = ?");
      values.push(patch.completedAt ?? null);
    }
    values.push(stepInstanceId);
    this.db
      .prepare(`update flow_step_instances set ${assignments.join(", ")} where step_instance_id = ?`)
      .run(...values);
    const step = this.getFlowStepInstance(stepInstanceId);
    if (!step) {
      throw new Error(`Flow step instance not found after update: ${stepInstanceId}`);
    }
    return step;
  }

  createFlowStepReport(input: {
    stepInstanceId: string;
    status: FlowStepInstanceStatus;
    resultJson?: Record<string, unknown>;
    artifactsJson?: Record<string, unknown>;
    summary?: string | null;
  }): FlowStepReportRecord {
    const report: FlowStepReportRecord = {
      report_id: newId("flowreport"),
      step_instance_id: input.stepInstanceId,
      status: input.status,
      result_json: input.resultJson ?? {},
      artifacts_json: input.artifactsJson ?? {},
      summary: input.summary ?? null,
      created_at: nowIso()
    };
    this.db
      .prepare(
        `insert into flow_step_reports (
          report_id, step_instance_id, status, result_json, artifacts_json, summary, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        report.report_id,
        report.step_instance_id,
        report.status,
        JSON.stringify(report.result_json),
        JSON.stringify(report.artifacts_json),
        report.summary,
        report.created_at
      );
    return report;
  }

  listFlowStepReports(flowInstanceId: string): FlowStepReportRecord[] {
    const rows = this.db
      .prepare(
        `select flow_step_reports.*
         from flow_step_reports
         join flow_step_instances on flow_step_instances.step_instance_id = flow_step_reports.step_instance_id
         where flow_step_instances.flow_instance_id = ?
         order by flow_step_reports.created_at asc`
      )
      .all(flowInstanceId) as Row[];
    return rows.map((row) => this.flowStepReportFromRow(row));
  }

  createFlowTransition(input: {
    flowInstanceId: string;
    fromStepInstanceId: string;
    transitionId: string;
    targetStepId?: string | null;
    actionJson?: Record<string, unknown>;
  }): FlowTransitionRecord {
    const transition: FlowTransitionRecord = {
      flow_transition_id: newId("flowtrans"),
      flow_instance_id: input.flowInstanceId,
      from_step_instance_id: input.fromStepInstanceId,
      transition_id: input.transitionId,
      target_step_id: input.targetStepId ?? null,
      action_json: input.actionJson ?? {},
      created_at: nowIso()
    };
    this.db
      .prepare(
        `insert into flow_transitions (
          flow_transition_id, flow_instance_id, from_step_instance_id,
          transition_id, target_step_id, action_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        transition.flow_transition_id,
        transition.flow_instance_id,
        transition.from_step_instance_id,
        transition.transition_id,
        transition.target_step_id,
        JSON.stringify(transition.action_json),
        transition.created_at
      );
    return transition;
  }

  listFlowTransitions(flowInstanceId: string): FlowTransitionRecord[] {
    const rows = this.db
      .prepare("select * from flow_transitions where flow_instance_id = ? order by created_at asc")
      .all(flowInstanceId) as Row[];
    return rows.map((row) => this.flowTransitionFromRow(row));
  }

  upsertFlowArtifactBinding(input: {
    flowInstanceId: string;
    artifactKey: string;
    artifactId?: string | null;
    path: string;
    producedByStepInstanceId?: string | null;
  }): FlowArtifactBindingRecord {
    const existing = this.db
      .prepare("select * from flow_artifact_bindings where flow_instance_id = ? and artifact_key = ?")
      .get(input.flowInstanceId, input.artifactKey) as Row | undefined;
    const now = nowIso();
    if (existing) {
      this.db
        .prepare(
          `update flow_artifact_bindings
           set artifact_id = ?, path = ?, produced_by_step_instance_id = ?, updated_at = ?
           where flow_instance_id = ? and artifact_key = ?`
        )
        .run(
          input.artifactId ?? null,
          input.path,
          input.producedByStepInstanceId ?? null,
          now,
          input.flowInstanceId,
          input.artifactKey
        );
      return this.flowArtifactBindingFromRow({
        ...existing,
        artifact_id: input.artifactId ?? null,
        path: input.path,
        produced_by_step_instance_id: input.producedByStepInstanceId ?? null,
        updated_at: now
      });
    }
    const binding: FlowArtifactBindingRecord = {
      binding_id: newId("flowartifact"),
      flow_instance_id: input.flowInstanceId,
      artifact_key: input.artifactKey,
      artifact_id: input.artifactId ?? null,
      path: input.path,
      produced_by_step_instance_id: input.producedByStepInstanceId ?? null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        `insert into flow_artifact_bindings (
          binding_id, flow_instance_id, artifact_key, artifact_id, path,
          produced_by_step_instance_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        binding.binding_id,
        binding.flow_instance_id,
        binding.artifact_key,
        binding.artifact_id,
        binding.path,
        binding.produced_by_step_instance_id,
        binding.created_at,
        binding.updated_at
      );
    return binding;
  }

  listFlowArtifactBindings(flowInstanceId: string): FlowArtifactBindingRecord[] {
    const rows = this.db
      .prepare("select * from flow_artifact_bindings where flow_instance_id = ? order by created_at asc")
      .all(flowInstanceId) as Row[];
    return rows.map((row) => this.flowArtifactBindingFromRow(row));
  }

  countAgentPurgeRows(agentId: string): Record<string, number> {
    return this.agentPurgeRowCounts(agentId);
  }

  purgeAgentRows(agentId: string, dryRun: boolean): Record<string, number> {
    const counts = this.agentPurgeRowCounts(agentId);
    if (dryRun) {
      return counts;
    }

    const flowStepIds = this.flowStepInstanceIdsForAgent(agentId);
    const flowStepReports = inCondition("step_instance_id", flowStepIds);
    const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);
    const flowStepBindings = inCondition("produced_by_step_instance_id", flowStepIds);

    const purge = this.db.transaction(() => {
      this.db.prepare("delete from agent_work_acceptances where agent_id = ?").run(agentId);
      this.db
        .prepare(
          `delete from subscription_deliveries
           where subscriber_agent_id = ?
              or event_id in (select event_id from events where agent_id = ?)`
        )
        .run(agentId, agentId);
      this.db
        .prepare("delete from orchestrator_actions where agent_id = ? or orchestrator_agent_id = ?")
        .run(agentId, agentId);
      this.db.prepare("delete from bridge_grants where orchestrator_agent_id = ?").run(agentId);
      this.db.prepare("delete from codex_subagent_external_states where agent_id = ?").run(agentId);
      this.db.prepare(`delete from flow_step_reports where ${flowStepReports.sql}`).run(...flowStepReports.values);
      this.db.prepare(`delete from flow_transitions where ${flowStepTransitions.sql}`).run(...flowStepTransitions.values);
      this.db
        .prepare(`delete from flow_artifact_bindings where ${flowStepBindings.sql}`)
        .run(...flowStepBindings.values);
      this.db.prepare("delete from agent_start_attempts where agent_id = ?").run(agentId);
      this.db.prepare("delete from flow_step_instances where agent_id = ?").run(agentId);
      this.db
        .prepare("delete from subscriptions where source_agent_id = ? or subscriber_agent_id = ?")
        .run(agentId, agentId);
      this.db
        .prepare("delete from agent_links where source_agent_id = ? or target_agent_id = ?")
        .run(agentId, agentId);
      this.db.prepare("delete from heartbeats where agent_id = ?").run(agentId);
      this.db.prepare("delete from goals where agent_id = ?").run(agentId);
      this.db.prepare("delete from artifacts where agent_id = ?").run(agentId);
      this.db.prepare("delete from usage_snapshots where agent_id = ?").run(agentId);
      this.db.prepare("delete from agent_tokens where agent_id = ?").run(agentId);
      this.db.prepare("delete from adapter_handles where agent_id = ?").run(agentId);
      this.db.prepare("delete from events where agent_id = ?").run(agentId);
      this.db.prepare("delete from agents where agent_id = ?").run(agentId);
    });
    purge();
    return counts;
  }

  countRunPurgeRows(runId: string): Record<string, number> {
    return this.runPurgeRowCounts(runId);
  }

  purgeRunRows(runId: string, dryRun: boolean): Record<string, number> {
    const counts = this.runPurgeRowCounts(runId);
    if (dryRun) {
      return counts;
    }

    const agentIds = this.agentIdsForRun(runId);
    const agentEvents = inCondition("agent_id", agentIds);
    const sourceSubs = inCondition("source_agent_id", agentIds);
    const subscriberSubs = inCondition("subscriber_agent_id", agentIds);
    const sourceLinks = inCondition("source_agent_id", agentIds);
    const targetLinks = inCondition("target_agent_id", agentIds);
    const agentScoped = inCondition("agent_id", agentIds);
    const deliverySubscribers = inCondition("subscriber_agent_id", agentIds);
    const flowInstanceIds = this.flowInstanceIdsForRun(runId);
    const flowRecordIds = this.flowRecordIdsForRun(runId);
    const flowStepIds = this.flowStepInstanceIdsForRun(runId);
    const flowInstances = inCondition("flow_instance_id", flowInstanceIds);
    const flowRecords = inCondition("flow_record_id", flowRecordIds);
    const flowStepReports = inCondition("step_instance_id", flowStepIds);
    const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);

    const purge = this.db.transaction(() => {
      this.db
        .prepare(`delete from agent_work_acceptances where ${agentScoped.sql}`)
        .run(...agentScoped.values);
      this.db
        .prepare(
          `delete from subscription_deliveries
           where ${deliverySubscribers.sql}
              or event_id in (
                select event_id from events
                where run_id = ? or ${agentEvents.sql}
              )`
        )
        .run(
          ...deliverySubscribers.values,
          runId,
          ...agentEvents.values
        );
      this.db.prepare("delete from orchestrator_actions where run_id = ?").run(runId);
      this.db
        .prepare(`delete from agent_start_attempts where ${agentScoped.sql}`)
        .run(...agentScoped.values);
      this.db
        .prepare(`delete from codex_subagent_external_states where ${agentScoped.sql}`)
        .run(...agentScoped.values);
      this.db.prepare(`delete from flow_step_reports where ${flowStepReports.sql}`).run(...flowStepReports.values);
      this.db.prepare(`delete from flow_transitions where ${flowStepTransitions.sql}`).run(...flowStepTransitions.values);
      this.db.prepare(`delete from flow_artifact_bindings where ${flowInstances.sql}`).run(...flowInstances.values);
      this.db.prepare(`delete from flow_step_instances where ${flowInstances.sql}`).run(...flowInstances.values);
      this.db.prepare("delete from flow_instances where run_id = ?").run(runId);
      this.db.prepare(`delete from flows where ${flowRecords.sql}`).run(...flowRecords.values);
      // Flow instances hold the immutable causal bridge binding, so grants can
      // only be deleted after their referencing instances are gone.
      this.db.prepare("delete from bridge_grants where run_id = ?").run(runId);
      this.db
        .prepare(
          `delete from subscriptions where run_id = ? or ${sourceSubs.sql} or ${subscriberSubs.sql}`
        )
        .run(runId, ...sourceSubs.values, ...subscriberSubs.values);
      this.db
        .prepare(`delete from agent_links where run_id = ? or ${sourceLinks.sql} or ${targetLinks.sql}`)
        .run(runId, ...sourceLinks.values, ...targetLinks.values);
      this.db.prepare(`delete from heartbeats where ${agentScoped.sql}`).run(...agentScoped.values);
      this.db.prepare(`delete from goals where ${agentScoped.sql}`).run(...agentScoped.values);
      this.db
        .prepare(`delete from artifacts where run_id = ? or ${agentScoped.sql}`)
        .run(runId, ...agentScoped.values);
      this.db
        .prepare(`delete from usage_snapshots where run_id = ? or ${agentScoped.sql}`)
        .run(runId, ...agentScoped.values);
      this.db.prepare(`delete from agent_tokens where ${agentScoped.sql}`).run(...agentScoped.values);
      this.db.prepare(`delete from adapter_handles where ${agentScoped.sql}`).run(...agentScoped.values);
      this.db
        .prepare(`delete from events where run_id = ? or ${agentEvents.sql}`)
        .run(runId, ...agentEvents.values);
      this.db.prepare("delete from agents where run_id = ?").run(runId);
      this.db.prepare("delete from runs where run_id = ?").run(runId);
    });
    purge();
    return counts;
  }

  private migrate(): void {
    const acceptedWorkPhaseWasPresent = this.hasColumn(
      "agent_work_acceptances",
      "phase"
    );
    this.db.exec(`
      create table if not exists runs (
        run_id text primary key,
        title text not null,
        repo_dir text,
        parent_run_id text,
        created_by_agent_id text,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists agents (
        agent_id text primary key,
        run_id text not null references runs(run_id) on delete cascade,
        backend text not null,
        title text not null,
        role text,
        objective text,
        repo_dir text,
        model text,
        backend_handle_json text,
        work_generation integer not null default 0,
        work_revision integer not null default 0,
        status text not null,
        failure_reason text,
        unregistered_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists agent_work_acceptances (
        acceptance_key text primary key,
        agent_id text not null references agents(agent_id) on delete cascade,
        work_generation integer not null,
        attempt_revision integer not null,
        phase text not null,
        completion_revision integer,
        claim_owner_id text,
        lease_expires_at text,
        delivery_event_id text,
        delivery_claim_attempt integer,
        created_at text not null,
        updated_at text not null,
        completed_at text
      );

      create table if not exists events (
        event_id text primary key,
        run_id text,
        agent_id text,
        type text not null,
        payload_json text not null,
        created_at text not null
      );

      create table if not exists subscriptions (
        subscription_id text primary key,
        run_id text,
        source_agent_id text,
        subscriber_agent_id text not null,
        event_type text not null,
        enabled integer not null default 1,
        last_delivered_event_id text,
        delivery_claim_event_id text,
        delivery_claimed_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists subscription_deliveries (
        event_id text not null references events(event_id) on delete cascade,
        subscriber_agent_id text not null references agents(agent_id) on delete cascade,
        status text not null,
        claim_attempt integer not null default 0,
        claim_owner_id text,
        claimed_at text,
        last_error_json text,
        delivered_at text,
        created_at text not null,
        updated_at text not null,
        primary key(event_id, subscriber_agent_id)
      );

      create table if not exists heartbeats (
        heartbeat_id text primary key,
        agent_id text not null,
        idle_timeout_ms integer not null,
        reminder_interval_ms integer,
        last_event_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists goals (
        goal_id text primary key,
        agent_id text not null,
        objective text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists artifacts (
        artifact_id text primary key,
        run_id text,
        agent_id text,
        label text not null,
        path text not null,
        expected integer not null default 0,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists agent_links (
        link_id text primary key,
        run_id text not null,
        source_agent_id text not null,
        target_agent_id text not null,
        type text not null,
        label text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists usage_snapshots (
        usage_id text primary key,
        run_id text not null,
        agent_id text not null,
        input_tokens integer,
        output_tokens integer,
        total_tokens integer,
        context_used integer,
        context_limit integer,
        source text,
        model text,
        captured_at text not null
      );

      create table if not exists agent_tokens (
        token_id text primary key,
        agent_id text not null,
        token_hash text not null unique,
        created_at text not null,
        revoked_at text
      );

      create table if not exists adapter_handles (
        agent_id text primary key,
        backend text not null,
        handle_json text not null,
        updated_at text not null
      );

      create table if not exists flows (
        flow_record_id text primary key,
        flow_id text not null,
        version text,
        description text,
        config_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists flow_instances (
        flow_instance_id text primary key,
        flow_record_id text not null references flows(flow_record_id) on delete cascade,
        run_id text not null references runs(run_id) on delete cascade,
        orchestrator_agent_id text,
        originating_bridge_grant_id text references bridge_grants(bridge_grant_id) on delete set null,
        status text not null,
        current_step_id text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists flow_step_instances (
        step_instance_id text primary key,
        flow_instance_id text not null references flow_instances(flow_instance_id) on delete cascade,
        step_id text not null,
        agent_id text,
        status text not null,
        input_json text not null,
        output_json text not null,
        result_json text not null,
        transition_id text,
        summary text,
        created_at text not null,
        updated_at text not null,
        completed_at text
      );

      create table if not exists flow_step_reports (
        report_id text primary key,
        step_instance_id text not null references flow_step_instances(step_instance_id) on delete cascade,
        status text not null,
        result_json text not null,
        artifacts_json text not null,
        summary text,
        created_at text not null
      );

      create table if not exists agent_start_attempts (
        start_attempt_id text primary key,
        agent_id text not null references agents(agent_id) on delete cascade,
        flow_instance_id text not null references flow_instances(flow_instance_id) on delete cascade,
        step_instance_id text not null references flow_step_instances(step_instance_id) on delete cascade,
        generation integer not null,
        phase text not null,
        claim_owner_id text not null,
        lease_expires_at text not null,
        invocation_started_at text,
        handle_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        completed_at text,
        unique(agent_id, step_instance_id, generation)
      );

      create table if not exists flow_transitions (
        flow_transition_id text primary key,
        flow_instance_id text not null references flow_instances(flow_instance_id) on delete cascade,
        from_step_instance_id text not null references flow_step_instances(step_instance_id) on delete cascade,
        transition_id text not null,
        target_step_id text,
        action_json text not null,
        created_at text not null
      );

      create table if not exists flow_artifact_bindings (
        binding_id text primary key,
        flow_instance_id text not null references flow_instances(flow_instance_id) on delete cascade,
        artifact_key text not null,
        artifact_id text,
        path text not null,
        produced_by_step_instance_id text,
        created_at text not null,
        updated_at text not null,
        unique(flow_instance_id, artifact_key)
      );

      create table if not exists bridge_grants (
        bridge_grant_id text primary key,
        run_id text not null references runs(run_id) on delete cascade,
        orchestrator_agent_id text not null references agents(agent_id) on delete cascade,
        owner_task_identity text,
        owner_task_path text not null,
        token_hash text not null unique,
        created_at text not null,
        last_used_at text,
        expires_at text,
        revoked_at text
      );

      create table if not exists orchestrator_actions (
        action_id text primary key,
        idempotency_key text not null unique,
        run_id text not null references runs(run_id) on delete cascade,
        orchestrator_agent_id text not null references agents(agent_id) on delete cascade,
        agent_id text not null references agents(agent_id) on delete cascade,
        flow_instance_id text references flow_instances(flow_instance_id) on delete cascade,
        step_instance_id text references flow_step_instances(step_instance_id) on delete cascade,
        operation text not null,
        status text not null,
        payload_json text not null,
        result_json text,
        error_json text,
        originating_bridge_grant_id text references bridge_grants(bridge_grant_id),
        claimed_by_bridge_grant_id text references bridge_grants(bridge_grant_id) on delete set null,
        claim_owner_identity text,
        claim_attempt integer not null default 0,
        claimed_at text,
        claim_lease_expires_at text,
        action_token_hash text,
        created_at text not null,
        updated_at text not null,
        completed_at text
      );

      create table if not exists codex_subagent_external_states (
        agent_id text primary key references agents(agent_id) on delete cascade,
        native_agent_id text,
        native_task_name text,
        native_task_path text,
        native_status text not null,
        latest_message text,
        observed_at text not null,
        missing_since text,
        missing_observation_count integer not null default 0,
        updated_at text not null
      );

      create table if not exists schema_migrations (
        migration_id text primary key,
        applied_at text not null
      );
    `);
    this.ensureColumn("runs", "parent_run_id", "text");
    this.ensureColumn("runs", "created_by_agent_id", "text");
    this.ensureColumn("agents", "work_generation", "integer not null default 0");
    this.ensureColumn("agents", "work_revision", "integer not null default 0");
    this.ensureColumn(
      "agent_work_acceptances",
      "attempt_revision",
      "integer not null default 0"
    );
    this.ensureColumn(
      "agent_work_acceptances",
      "phase",
      "text not null default 'invoking'"
    );
    this.ensureColumn("agent_work_acceptances", "completion_revision", "integer");
    this.ensureColumn("agent_work_acceptances", "claim_owner_id", "text");
    this.ensureColumn("agent_work_acceptances", "lease_expires_at", "text");
    this.ensureColumn("agent_work_acceptances", "delivery_event_id", "text");
    this.ensureColumn("agent_work_acceptances", "delivery_claim_attempt", "integer");
    this.ensureColumn("agent_work_acceptances", "updated_at", "text");
    this.ensureColumn("agent_work_acceptances", "completed_at", "text");
    if (!acceptedWorkPhaseWasPresent) {
      // Pre-revision rows already crossed an adapter boundary, but did not
      // persist its completion phase. Preserve current `unknown` generations
      // as ambiguous across restart; all other historical rows are closed so
      // they cannot masquerade as live invocations after migration.
      this.db.exec(`
        update agent_work_acceptances
        set phase = case
              when exists (
                select 1 from agents
                where agents.agent_id = agent_work_acceptances.agent_id
                  and agents.work_generation = agent_work_acceptances.work_generation
                  and agents.status = 'unknown'
              ) then 'ambiguous'
              else 'succeeded'
            end,
            completion_revision = attempt_revision,
            updated_at = coalesce(updated_at, created_at),
            completed_at = coalesce(completed_at, created_at);
      `);
    } else {
      this.db.exec(`
        update agent_work_acceptances
        set updated_at = coalesce(updated_at, created_at)
        where updated_at is null;
      `);
    }
    this.ensureColumn("subscriptions", "delivery_claim_event_id", "text");
    this.ensureColumn("subscriptions", "delivery_claimed_at", "text");
    this.ensureColumn("flow_instances", "orchestrator_agent_id", "text");
    this.migrateNativeOriginGrantBindings();
    this.db.exec(`
      create index if not exists idx_agents_run on agents(run_id);
      create index if not exists idx_agent_work_acceptances_agent
        on agent_work_acceptances(agent_id, work_generation);
      create index if not exists idx_runs_parent on runs(parent_run_id);
      create index if not exists idx_runs_created_by_agent on runs(created_by_agent_id);
      create index if not exists idx_events_run_created on events(run_id, created_at);
      create index if not exists idx_events_agent_created on events(agent_id, created_at);
      create index if not exists idx_subscriptions_source on subscriptions(source_agent_id, event_type);
      create index if not exists idx_subscription_deliveries_subscriber_status
        on subscription_deliveries(subscriber_agent_id, status, updated_at);
      create index if not exists idx_goals_agent on goals(agent_id);
      create index if not exists idx_heartbeats_agent on heartbeats(agent_id);
      create index if not exists idx_artifacts_run on artifacts(run_id);
      create index if not exists idx_agent_links_run on agent_links(run_id);
      create index if not exists idx_agent_links_source on agent_links(source_agent_id, type);
      create index if not exists idx_agent_links_target on agent_links(target_agent_id, type);
      create index if not exists idx_usage_snapshots_run on usage_snapshots(run_id, captured_at);
      create index if not exists idx_usage_snapshots_agent on usage_snapshots(agent_id, captured_at);
      create index if not exists idx_agent_tokens_agent on agent_tokens(agent_id);
      create index if not exists idx_flows_id on flows(flow_id, version);
      create index if not exists idx_flow_instances_run on flow_instances(run_id);
      create index if not exists idx_flow_instances_origin_grant on flow_instances(originating_bridge_grant_id);
      create index if not exists idx_flow_step_instances_flow on flow_step_instances(flow_instance_id, created_at);
      create index if not exists idx_flow_step_instances_agent on flow_step_instances(agent_id);
      create index if not exists idx_flow_step_reports_step on flow_step_reports(step_instance_id);
      create index if not exists idx_agent_start_attempts_agent_phase on agent_start_attempts(agent_id, phase);
      create index if not exists idx_agent_start_attempts_step on agent_start_attempts(step_instance_id, generation);
      create index if not exists idx_flow_transitions_flow on flow_transitions(flow_instance_id);
      create index if not exists idx_flow_artifact_bindings_flow on flow_artifact_bindings(flow_instance_id);
      create index if not exists idx_bridge_grants_run_orchestrator on bridge_grants(run_id, orchestrator_agent_id, created_at);
      create index if not exists idx_orchestrator_actions_run_status on orchestrator_actions(run_id, status, created_at);
      create index if not exists idx_orchestrator_actions_agent_status on orchestrator_actions(agent_id, status, created_at);
      create index if not exists idx_orchestrator_actions_step on orchestrator_actions(step_instance_id);
      create index if not exists idx_orchestrator_actions_origin_grant on orchestrator_actions(originating_bridge_grant_id);
      create index if not exists idx_codex_subagent_state_native_agent on codex_subagent_external_states(native_agent_id);
      create index if not exists idx_codex_subagent_state_task_path on codex_subagent_external_states(native_task_path);
    `);
  }

  /**
   * Upgrade native flow/action grant provenance as one durable schema unit.
   *
   * Older databases added the two origin columns with ALTER TABLE. SQLite
   * accepts a REFERENCES clause in some ADD COLUMN cases, but it cannot retrofit
   * the complete constraint/on-delete semantics required here. Presence of a
   * column therefore says nothing about whether the migration finished. This
   * named migration rebuilds whichever table lacks the exact fresh-schema FK,
   * performs conservative chronological backfill, verifies referential
   * integrity, recreates table-owned indexes/triggers, and writes its durable
   * marker in the same transaction.
   */
  private migrateNativeOriginGrantBindings(): void {
    if (this.hasSchemaMigration(NATIVE_ORIGIN_GRANT_MIGRATION_ID)) {
      return;
    }
    if (this.db.inTransaction) {
      throw new Error(
        "Native origin grant migration must start outside an existing transaction."
      );
    }

    const foreignKeysWereEnabled =
      Number(this.db.pragma("foreign_keys", { simple: true })) === 1;
    // SQLite only permits changing foreign_keys outside a transaction. The
    // rebuild itself is still atomic; enforcement is disabled solely on this
    // connection while the old parent tables temporarily do not exist.
    if (foreignKeysWereEnabled) {
      this.db.pragma("foreign_keys = OFF");
    }

    try {
      const migrate = this.db.transaction(() => {
        // A second process may have completed the migration while this
        // connection waited for BEGIN IMMEDIATE. Recheck under the write lock.
        if (this.hasSchemaMigration(NATIVE_ORIGIN_GRANT_MIGRATION_ID)) {
          return;
        }

        const schemaObjectsToRestore: string[] = [];
        const flowNeedsRebuild =
          !this.hasColumn("flow_instances", "originating_bridge_grant_id") ||
          !this.hasExactForeignKey(
            "flow_instances",
            "originating_bridge_grant_id",
            "bridge_grants",
            "bridge_grant_id",
            "SET NULL",
            "NO ACTION",
            true
          );
        const actionNeedsRebuild =
          !this.hasColumn("orchestrator_actions", "originating_bridge_grant_id") ||
          !this.hasExactForeignKey(
            "orchestrator_actions",
            "originating_bridge_grant_id",
            "bridge_grants",
            "bridge_grant_id",
            "NO ACTION",
            "NO ACTION",
            true
          );

        if (flowNeedsRebuild) {
          schemaObjectsToRestore.push(
            ...this.tableOwnedSchemaObjects("flow_instances")
          );
          this.rebuildFlowInstancesForOriginGrant();
        }
        if (actionNeedsRebuild) {
          schemaObjectsToRestore.push(
            ...this.tableOwnedSchemaObjects("orchestrator_actions")
          );
          this.rebuildOrchestratorActionsForOriginGrant();
        }

        this.backfillNativeOriginGrantBindings();

        // Rebuild drops table-owned indexes and triggers. Recreate their exact
        // SQL only after backfill so legacy business triggers cannot observe or
        // interfere with intermediate provenance repair.
        for (const sql of schemaObjectsToRestore) {
          this.db.exec(sql);
        }

        if (
          !this.hasExactForeignKey(
            "flow_instances",
            "originating_bridge_grant_id",
            "bridge_grants",
            "bridge_grant_id",
            "SET NULL",
            "NO ACTION",
            true
          ) ||
          !this.hasExactForeignKey(
            "orchestrator_actions",
            "originating_bridge_grant_id",
            "bridge_grants",
            "bridge_grant_id",
            "NO ACTION",
            "NO ACTION",
            true
          )
        ) {
          throw new Error(
            "Native origin grant migration did not install the required foreign keys."
          );
        }

        const violations = [
          ...(this.db
            .prepare("pragma foreign_key_check(flow_instances)")
            .all() as Row[]),
          ...(this.db
            .prepare("pragma foreign_key_check(orchestrator_actions)")
            .all() as Row[])
        ];
        if (violations.length > 0) {
          throw new Error(
            `Native origin grant migration left foreign key violations: ${JSON.stringify(
              violations.slice(0, 5)
            )}`
          );
        }

        this.db
          .prepare(
            "insert into schema_migrations (migration_id, applied_at) values (?, ?)"
          )
          .run(NATIVE_ORIGIN_GRANT_MIGRATION_ID, nowIso());
      });
      migrate.immediate();
    } finally {
      if (foreignKeysWereEnabled) {
        this.db.pragma("foreign_keys = ON");
        if (Number(this.db.pragma("foreign_keys", { simple: true })) !== 1) {
          throw new Error(
            "Failed to restore SQLite foreign key enforcement after migration."
          );
        }
      }
    }
  }

  private hasSchemaMigration(migrationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "select migration_id from schema_migrations where migration_id = ?"
        )
        .get(migrationId)
    );
  }

  private hasExactForeignKey(
    table: string,
    fromColumn: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete: "NO ACTION" | "SET NULL",
    onUpdate: "NO ACTION",
    sourceMustBeNullable: boolean
  ): boolean {
    const foreignKeys = this.db
      .prepare(`pragma foreign_key_list(${table})`)
      .all() as Row[];
    const sourceColumn = (
      this.db.prepare(`pragma table_info(${table})`).all() as Row[]
    ).find((row) => String(row.name) === fromColumn);
    if (
      !sourceColumn ||
      (sourceMustBeNullable && Number(sourceColumn.notnull) !== 0)
    ) {
      return false;
    }
    const sourceForeignKeys = foreignKeys.filter(
      (row) => String(row.from) === fromColumn
    );
    const sourceForeignKey = sourceForeignKeys[0];
    const foreignKeyGroup = sourceForeignKey
      ? foreignKeys.filter(
          (row) => String(row.id) === String(sourceForeignKey.id)
        )
      : [];
    return (
      sourceForeignKeys.length === 1 &&
      // PRAGMA foreign_key_list emits one row per column in an FK. Looking
      // only at rows whose `from` equals the expected source would accept the
      // first leg of a composite FK such as (origin, run_id). Require the FK
      // id itself to contain exactly that one source/target column.
      foreignKeyGroup.length === 1 &&
      Number(sourceForeignKey.seq) === 0 &&
      String(sourceForeignKey.table) === referencedTable &&
      String(sourceForeignKey.to) === referencedColumn &&
      String(sourceForeignKey.on_delete).toUpperCase() === onDelete &&
      String(sourceForeignKey.on_update).toUpperCase() === onUpdate
    );
  }

  /** Capture explicit indexes/triggers; implicit UNIQUE indexes rebuild themselves. */
  private tableOwnedSchemaObjects(table: string): string[] {
    return (
      this.db
        .prepare(
          `select sql from sqlite_master
           where tbl_name = ? and type in ('index', 'trigger') and sql is not null
           order by case type when 'index' then 0 else 1 end, name asc`
        )
        .all(table) as Row[]
    ).map((row) => String(row.sql));
  }

  private rebuildFlowInstancesForOriginGrant(): void {
    const originExpression = this.hasColumn(
      "flow_instances",
      "originating_bridge_grant_id"
    )
      ? "originating_bridge_grant_id"
      : "null";
    this.db.exec(`
      drop table if exists flow_instances__native_origin_v5;
      create table flow_instances__native_origin_v5 (
        flow_instance_id text primary key,
        flow_record_id text not null references flows(flow_record_id) on delete cascade,
        run_id text not null references runs(run_id) on delete cascade,
        orchestrator_agent_id text,
        originating_bridge_grant_id text references bridge_grants(bridge_grant_id) on delete set null,
        status text not null,
        current_step_id text,
        created_at text not null,
        updated_at text not null
      );
      insert into flow_instances__native_origin_v5 (
        flow_instance_id, flow_record_id, run_id, orchestrator_agent_id,
        originating_bridge_grant_id, status, current_step_id, created_at, updated_at
      )
      select flow_instance_id, flow_record_id, run_id, orchestrator_agent_id,
             ${originExpression}, status, current_step_id, created_at, updated_at
      from flow_instances;
      drop table flow_instances;
      alter table flow_instances__native_origin_v5 rename to flow_instances;
    `);
  }

  private rebuildOrchestratorActionsForOriginGrant(): void {
    const originExpression = this.hasColumn(
      "orchestrator_actions",
      "originating_bridge_grant_id"
    )
      ? "originating_bridge_grant_id"
      : "null";
    this.db.exec(`
      drop table if exists orchestrator_actions__native_origin_v5;
      create table orchestrator_actions__native_origin_v5 (
        action_id text primary key,
        idempotency_key text not null unique,
        run_id text not null references runs(run_id) on delete cascade,
        orchestrator_agent_id text not null references agents(agent_id) on delete cascade,
        agent_id text not null references agents(agent_id) on delete cascade,
        flow_instance_id text references flow_instances(flow_instance_id) on delete cascade,
        step_instance_id text references flow_step_instances(step_instance_id) on delete cascade,
        operation text not null,
        status text not null,
        payload_json text not null,
        result_json text,
        error_json text,
        originating_bridge_grant_id text references bridge_grants(bridge_grant_id),
        claimed_by_bridge_grant_id text references bridge_grants(bridge_grant_id) on delete set null,
        claim_owner_identity text,
        claim_attempt integer not null default 0,
        claimed_at text,
        claim_lease_expires_at text,
        action_token_hash text,
        created_at text not null,
        updated_at text not null,
        completed_at text
      );
      insert into orchestrator_actions__native_origin_v5 (
        action_id, idempotency_key, run_id, orchestrator_agent_id, agent_id,
        flow_instance_id, step_instance_id, operation, status, payload_json,
        result_json, error_json, originating_bridge_grant_id,
        claimed_by_bridge_grant_id, claim_owner_identity, claim_attempt,
        claimed_at, claim_lease_expires_at, action_token_hash, created_at,
        updated_at, completed_at
      )
      select action_id, idempotency_key, run_id, orchestrator_agent_id, agent_id,
             flow_instance_id, step_instance_id, operation, status, payload_json,
             result_json, error_json, ${originExpression},
             claimed_by_bridge_grant_id, claim_owner_identity, claim_attempt,
             claimed_at, claim_lease_expires_at, action_token_hash, created_at,
             updated_at, completed_at
      from orchestrator_actions;
      drop table orchestrator_actions;
      alter table orchestrator_actions__native_origin_v5 rename to orchestrator_actions;
    `);
  }

  /**
   * Infer ownership only from evidence that existed no later than the causal
   * row. A deleted original grant followed by a newer sibling grant therefore
   * remains unbound instead of silently transferring authority.
   */
  private backfillNativeOriginGrantBindings(): void {
    this.db.exec(`
      -- Preserve whether a null was present in legacy data or was produced by
      -- rejecting an explicit provenance claim. Once an explicit claim fails,
      -- another surviving grant must never acquire that row merely because it
      -- becomes the only chronological candidate after the clear.
      drop table if exists native_origin_invalid_actions_v5;
      create table native_origin_invalid_actions_v5 (
        action_id text primary key
      );
      insert into native_origin_invalid_actions_v5 (action_id)
      select orchestrator_actions.action_id
      from orchestrator_actions
      where orchestrator_actions.originating_bridge_grant_id is not null
        and not exists (
          select 1 from bridge_grants
          where bridge_grants.bridge_grant_id = orchestrator_actions.originating_bridge_grant_id
            and bridge_grants.run_id = orchestrator_actions.run_id
            and bridge_grants.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
            and bridge_grants.created_at <= orchestrator_actions.created_at
            and (
              orchestrator_actions.flow_instance_id is null
              or exists (
                select 1 from flow_instances
                where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
                  and flow_instances.run_id = orchestrator_actions.run_id
                  and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
                  and orchestrator_actions.created_at >= flow_instances.created_at
                  and bridge_grants.created_at <= flow_instances.created_at
              )
            )
        );

      -- A claimant is provenance, not merely lease bookkeeping. Record an
      -- invalid non-null claimant before the later cleanup turns it into an
      -- indistinguishable null; otherwise the unique surviving grant could be
      -- inferred as both the action origin and its parent flow origin.
      insert or ignore into native_origin_invalid_actions_v5 (action_id)
      select orchestrator_actions.action_id
      from orchestrator_actions
      where orchestrator_actions.claimed_by_bridge_grant_id is not null
        and not exists (
          select 1 from bridge_grants
          where bridge_grants.bridge_grant_id = orchestrator_actions.claimed_by_bridge_grant_id
            and bridge_grants.run_id = orchestrator_actions.run_id
            and bridge_grants.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
            and bridge_grants.created_at <= orchestrator_actions.created_at
            and (
              orchestrator_actions.flow_instance_id is null
              or exists (
                select 1 from flow_instances
                where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
                  and flow_instances.run_id = orchestrator_actions.run_id
                  and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
                  and orchestrator_actions.created_at >= flow_instances.created_at
                  and bridge_grants.created_at <= flow_instances.created_at
              )
            )
        );

      -- ON DELETE SET NULL may already have erased the claimant id before this
      -- migration runs. These fields are written atomically by a successful
      -- claim and are never populated on a fresh pending action. Any one of
      -- them, or a post-claim status, therefore proves prior execution without
      -- guessing that every legacy pending/null row was claimed. Cancelled is
      -- intentionally not status evidence: cancellation is restricted to
      -- actions whose claim_attempt is zero and whose token/claimant are null.
      insert or ignore into native_origin_invalid_actions_v5 (action_id)
      select orchestrator_actions.action_id
      from orchestrator_actions
      where orchestrator_actions.claimed_by_bridge_grant_id is null
        and (
          orchestrator_actions.claim_attempt > 0
          or orchestrator_actions.claim_owner_identity is not null
          or orchestrator_actions.claimed_at is not null
          or orchestrator_actions.claim_lease_expires_at is not null
          or orchestrator_actions.action_token_hash is not null
          or orchestrator_actions.status in ('claimed', 'succeeded', 'failed')
        );

      -- Two different surviving grants in the explicit origin and claimant
      -- fields are contradictory provenance. Neither side may win inference.
      insert or ignore into native_origin_invalid_actions_v5 (action_id)
      select orchestrator_actions.action_id
      from orchestrator_actions
      where orchestrator_actions.originating_bridge_grant_id is not null
        and orchestrator_actions.claimed_by_bridge_grant_id is not null
        and orchestrator_actions.originating_bridge_grant_id <>
            orchestrator_actions.claimed_by_bridge_grant_id;

      drop table if exists native_origin_invalid_flows_v5;
      create table native_origin_invalid_flows_v5 (
        flow_instance_id text primary key
      );
      insert into native_origin_invalid_flows_v5 (flow_instance_id)
      select flow_instances.flow_instance_id
      from flow_instances
      where flow_instances.originating_bridge_grant_id is not null
        and not exists (
          select 1 from bridge_grants
          where bridge_grants.bridge_grant_id = flow_instances.originating_bridge_grant_id
            and bridge_grants.run_id = flow_instances.run_id
            and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
            and bridge_grants.created_at <= flow_instances.created_at
        );

      -- Child provenance is part of the flow's causal evidence. Once any
      -- attached action is tainted, a parent that was null (or even carried a
      -- superficially valid grant) cannot be reconstructed safely from other
      -- actions or from the remaining grant topology.
      insert or ignore into native_origin_invalid_flows_v5 (flow_instance_id)
      select distinct flow_instances.flow_instance_id
      from flow_instances
      join orchestrator_actions
        on orchestrator_actions.flow_instance_id = flow_instances.flow_instance_id
      join native_origin_invalid_actions_v5
        on native_origin_invalid_actions_v5.action_id = orchestrator_actions.action_id;

      update orchestrator_actions
      set originating_bridge_grant_id = null
      where action_id in (
        select action_id from native_origin_invalid_actions_v5
      );

      update orchestrator_actions
      set claimed_by_bridge_grant_id = null
      where claimed_by_bridge_grant_id is not null
        and not exists (
          select 1 from bridge_grants
          where bridge_grants.bridge_grant_id = orchestrator_actions.claimed_by_bridge_grant_id
            and bridge_grants.run_id = orchestrator_actions.run_id
            and bridge_grants.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
            and bridge_grants.created_at <= orchestrator_actions.created_at
            and (
              orchestrator_actions.flow_instance_id is null
              or exists (
                select 1 from flow_instances
                where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
                  and flow_instances.run_id = orchestrator_actions.run_id
                  and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
                  and orchestrator_actions.created_at >= flow_instances.created_at
                  and bridge_grants.created_at <= flow_instances.created_at
              )
            )
        );

      update orchestrator_actions
      set originating_bridge_grant_id = claimed_by_bridge_grant_id
      where originating_bridge_grant_id is null
        and claimed_by_bridge_grant_id is not null
        and action_id not in (
          select action_id from native_origin_invalid_actions_v5
        );

      update orchestrator_actions
      set originating_bridge_grant_id = (
        select min(bridge_grants.bridge_grant_id)
        from bridge_grants
        where bridge_grants.run_id = orchestrator_actions.run_id
          and bridge_grants.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
          and bridge_grants.created_at <= orchestrator_actions.created_at
          and (
            orchestrator_actions.flow_instance_id is null
            or exists (
              select 1 from flow_instances
              where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
                and flow_instances.run_id = orchestrator_actions.run_id
                and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
                and orchestrator_actions.created_at >= flow_instances.created_at
                and bridge_grants.created_at <= flow_instances.created_at
            )
          )
      )
      where originating_bridge_grant_id is null
        and action_id not in (
          select action_id from native_origin_invalid_actions_v5
        )
        and 1 = (
          select count(*)
          from bridge_grants
          where bridge_grants.run_id = orchestrator_actions.run_id
            and bridge_grants.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
            and bridge_grants.created_at <= orchestrator_actions.created_at
            and (
              orchestrator_actions.flow_instance_id is null
              or exists (
                select 1 from flow_instances
                where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
                  and flow_instances.run_id = orchestrator_actions.run_id
                  and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
                  and orchestrator_actions.created_at >= flow_instances.created_at
                  and bridge_grants.created_at <= flow_instances.created_at
              )
            )
        );

      update flow_instances
      set originating_bridge_grant_id = null
      where flow_instance_id in (
        select flow_instance_id from native_origin_invalid_flows_v5
      );

      update flow_instances
      set originating_bridge_grant_id = (
        select min(orchestrator_actions.originating_bridge_grant_id)
        from orchestrator_actions
        join bridge_grants
          on bridge_grants.bridge_grant_id = orchestrator_actions.originating_bridge_grant_id
        where orchestrator_actions.flow_instance_id = flow_instances.flow_instance_id
          and orchestrator_actions.created_at >= flow_instances.created_at
          and bridge_grants.run_id = flow_instances.run_id
          and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
          and bridge_grants.created_at <= flow_instances.created_at
      )
      where originating_bridge_grant_id is null
        and flow_instance_id not in (
          select flow_instance_id from native_origin_invalid_flows_v5
        )
        and 1 = (
          select count(distinct orchestrator_actions.originating_bridge_grant_id)
          from orchestrator_actions
          join bridge_grants
            on bridge_grants.bridge_grant_id = orchestrator_actions.originating_bridge_grant_id
          where orchestrator_actions.flow_instance_id = flow_instances.flow_instance_id
            and orchestrator_actions.created_at >= flow_instances.created_at
            and bridge_grants.run_id = flow_instances.run_id
            and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
            and bridge_grants.created_at <= flow_instances.created_at
        );

      update flow_instances
      set originating_bridge_grant_id = (
        select min(bridge_grants.bridge_grant_id)
        from bridge_grants
        where bridge_grants.run_id = flow_instances.run_id
          and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
          and bridge_grants.created_at <= flow_instances.created_at
      )
      where originating_bridge_grant_id is null
        and flow_instance_id not in (
          select flow_instance_id from native_origin_invalid_flows_v5
        )
        and 0 = (
          select count(distinct orchestrator_actions.originating_bridge_grant_id)
          from orchestrator_actions
          join bridge_grants
            on bridge_grants.bridge_grant_id = orchestrator_actions.originating_bridge_grant_id
          where orchestrator_actions.flow_instance_id = flow_instances.flow_instance_id
            and orchestrator_actions.created_at >= flow_instances.created_at
            and bridge_grants.run_id = flow_instances.run_id
            and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
            and bridge_grants.created_at <= flow_instances.created_at
        )
        and 1 = (
          select count(*)
          from bridge_grants
          where bridge_grants.run_id = flow_instances.run_id
            and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
            and bridge_grants.created_at <= flow_instances.created_at
        );

      -- A valid flow origin is the authoritative causal boundary for its
      -- actions. A legacy null can inherit that exact grant even when several
      -- grants are otherwise eligible, but a null produced by rejecting an
      -- explicit claim remains fail-closed.
      update orchestrator_actions
      set originating_bridge_grant_id = (
        select flow_instances.originating_bridge_grant_id
        from flow_instances
        join bridge_grants
          on bridge_grants.bridge_grant_id = flow_instances.originating_bridge_grant_id
        where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
          and flow_instances.run_id = orchestrator_actions.run_id
          and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
          and orchestrator_actions.created_at >= flow_instances.created_at
          and bridge_grants.run_id = flow_instances.run_id
          and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
          and bridge_grants.created_at <= flow_instances.created_at
          and bridge_grants.created_at <= orchestrator_actions.created_at
      )
      where flow_instance_id is not null
        and originating_bridge_grant_id is null
        and action_id not in (
          select action_id from native_origin_invalid_actions_v5
        )
        and exists (
          select 1
          from flow_instances
          join bridge_grants
            on bridge_grants.bridge_grant_id = flow_instances.originating_bridge_grant_id
          where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
            and flow_instances.run_id = orchestrator_actions.run_id
            and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
            and orchestrator_actions.created_at >= flow_instances.created_at
            and bridge_grants.run_id = flow_instances.run_id
            and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
            and bridge_grants.created_at <= flow_instances.created_at
            and bridge_grants.created_at <= orchestrator_actions.created_at
        );

      -- Reconciliation never rewrites a conflicting non-null action from one
      -- grant to another. It clears the mismatch after the null-binding pass,
      -- so the same migration cannot reinterpret that conflict as permission
      -- to adopt the flow's grant.
      update orchestrator_actions
      set originating_bridge_grant_id = null
      where flow_instance_id is not null
        and originating_bridge_grant_id is not null
        and not exists (
          select 1 from flow_instances
          join bridge_grants
            on bridge_grants.bridge_grant_id = flow_instances.originating_bridge_grant_id
          where flow_instances.flow_instance_id = orchestrator_actions.flow_instance_id
            and flow_instances.run_id = orchestrator_actions.run_id
            and flow_instances.orchestrator_agent_id = orchestrator_actions.orchestrator_agent_id
            and flow_instances.originating_bridge_grant_id =
                orchestrator_actions.originating_bridge_grant_id
            and orchestrator_actions.created_at >= flow_instances.created_at
            and bridge_grants.run_id = flow_instances.run_id
            and bridge_grants.orchestrator_agent_id = flow_instances.orchestrator_agent_id
            and bridge_grants.created_at <= flow_instances.created_at
            and bridge_grants.created_at <= orchestrator_actions.created_at
        );

      drop table native_origin_invalid_actions_v5;
      drop table native_origin_invalid_flows_v5;
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`alter table ${table} add column ${column} ${definition}`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Row[];
    return rows.some((row) => row.name === column);
  }

  private runFromRow(row: Row): RunRecord {
    return {
      run_id: String(row.run_id),
      title: String(row.title),
      repo_dir: row.repo_dir === null ? null : String(row.repo_dir),
      parent_run_id: row.parent_run_id === null ? null : String(row.parent_run_id),
      created_by_agent_id: row.created_by_agent_id === null ? null : String(row.created_by_agent_id),
      status: String(row.status),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private agentFromRow(row: Row): AgentRecord {
    return {
      agent_id: String(row.agent_id),
      run_id: String(row.run_id),
      backend: String(row.backend),
      title: String(row.title),
      role: row.role === null ? null : String(row.role),
      objective: row.objective === null ? null : String(row.objective),
      repo_dir: row.repo_dir === null ? null : String(row.repo_dir),
      model: row.model === null ? null : String(row.model),
      backend_handle: parseJsonObject(row.backend_handle_json),
      work_generation: Number(row.work_generation ?? 0),
      work_revision: Number(row.work_revision ?? 0),
      status: String(row.status) as AgentStatus,
      failure_reason: row.failure_reason === null ? null : (String(row.failure_reason) as FailureReason),
      unregistered_at: row.unregistered_at === null ? null : String(row.unregistered_at),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private agentStartAttemptFromRow(row: Row): AgentStartAttemptRecord {
    return {
      start_attempt_id: String(row.start_attempt_id),
      agent_id: String(row.agent_id),
      flow_instance_id: String(row.flow_instance_id),
      step_instance_id: String(row.step_instance_id),
      generation: Number(row.generation),
      phase: String(row.phase) as AgentStartAttemptRecord["phase"],
      claim_owner_id: String(row.claim_owner_id),
      lease_expires_at: String(row.lease_expires_at),
      invocation_started_at:
        row.invocation_started_at === null ? null : String(row.invocation_started_at),
      handle_json: parseJsonObject(row.handle_json),
      error_json: parseJsonObject(row.error_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      completed_at: row.completed_at === null ? null : String(row.completed_at)
    };
  }

  private bridgeGrantFromRow(row: Row): BridgeGrantRecord {
    const bridgeGrantId = String(row.bridge_grant_id);
    if (!isBridgeGrantId(bridgeGrantId)) {
      throw new Error("SQLite contains an invalid bridge grant id.");
    }
    return {
      bridge_grant_id: bridgeGrantId,
      run_id: String(row.run_id),
      orchestrator_agent_id: String(row.orchestrator_agent_id),
      owner_task_identity: row.owner_task_identity === null ? null : String(row.owner_task_identity),
      owner_task_path: String(row.owner_task_path),
      token_hash: String(row.token_hash),
      created_at: String(row.created_at),
      last_used_at: row.last_used_at === null ? null : String(row.last_used_at),
      expires_at: row.expires_at === null ? null : String(row.expires_at),
      revoked_at: row.revoked_at === null ? null : String(row.revoked_at)
    };
  }

  private orchestratorActionFromRow(row: Row): OrchestratorActionRecord {
    const actionId = String(row.action_id);
    if (!isOrchestratorActionId(actionId)) {
      throw new Error("SQLite contains an invalid orchestrator action id.");
    }
    return {
      action_id: actionId,
      idempotency_key: String(row.idempotency_key),
      run_id: String(row.run_id),
      orchestrator_agent_id: String(row.orchestrator_agent_id),
      agent_id: String(row.agent_id),
      flow_instance_id: row.flow_instance_id === null ? null : String(row.flow_instance_id),
      step_instance_id: row.step_instance_id === null ? null : String(row.step_instance_id),
      operation: String(row.operation) as OrchestratorActionOperation,
      status: String(row.status) as OrchestratorActionStatus,
      payload_json: parseJsonObject(row.payload_json) ?? {},
      result_json: parseJsonObject(row.result_json),
      error_json: parseJsonObject(row.error_json),
      originating_bridge_grant_id:
        row.originating_bridge_grant_id === null ||
        row.originating_bridge_grant_id === undefined
          ? null
          : String(row.originating_bridge_grant_id),
      claimed_by_bridge_grant_id:
        row.claimed_by_bridge_grant_id === null ? null : String(row.claimed_by_bridge_grant_id),
      claim_owner_identity: row.claim_owner_identity === null ? null : String(row.claim_owner_identity),
      claim_attempt: Number(row.claim_attempt),
      claimed_at: row.claimed_at === null ? null : String(row.claimed_at),
      claim_lease_expires_at:
        row.claim_lease_expires_at === null ? null : String(row.claim_lease_expires_at),
      action_token_hash: row.action_token_hash === null ? null : String(row.action_token_hash),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      completed_at: row.completed_at === null ? null : String(row.completed_at)
    };
  }

  private eventFromRow(row: Row): EventRecord {
    return {
      event_id: String(row.event_id),
      run_id: row.run_id === null ? null : String(row.run_id),
      agent_id: row.agent_id === null ? null : String(row.agent_id),
      type: String(row.type) as EventType,
      payload: parseJsonObject(row.payload_json) ?? {},
      created_at: String(row.created_at)
    };
  }

  private subscriptionFromRow(row: Row): SubscriptionRecord {
    return {
      subscription_id: String(row.subscription_id),
      run_id: row.run_id === null ? null : String(row.run_id),
      source_agent_id: row.source_agent_id === null ? null : String(row.source_agent_id),
      subscriber_agent_id: String(row.subscriber_agent_id),
      event_type: String(row.event_type) as EventType,
      enabled: booleanFromSqlite(row.enabled),
      last_delivered_event_id:
        row.last_delivered_event_id === null ? null : String(row.last_delivered_event_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private subscriptionDeliveryFromRow(row: Row): SubscriptionDeliveryRecord {
    return {
      event_id: String(row.event_id),
      subscriber_agent_id: String(row.subscriber_agent_id),
      status: String(row.status) as SubscriptionDeliveryRecord["status"],
      claim_attempt: Number(row.claim_attempt),
      claim_owner_id:
        row.claim_owner_id === null ? null : String(row.claim_owner_id),
      claimed_at: row.claimed_at === null ? null : String(row.claimed_at),
      last_error: parseJsonObject(row.last_error_json),
      delivered_at:
        row.delivered_at === null ? null : String(row.delivered_at),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private heartbeatFromRow(row: Row): HeartbeatRecord {
    return {
      heartbeat_id: String(row.heartbeat_id),
      agent_id: String(row.agent_id),
      idle_timeout_ms: Number(row.idle_timeout_ms),
      reminder_interval_ms:
        row.reminder_interval_ms === null ? null : Number(row.reminder_interval_ms),
      last_event_at: row.last_event_at === null ? null : String(row.last_event_at),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private goalFromRow(row: Row): GoalRecord {
    return {
      goal_id: String(row.goal_id),
      agent_id: String(row.agent_id),
      objective: String(row.objective),
      status: String(row.status) as GoalStatus,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private artifactFromRow(row: Row): ArtifactRecord {
    return {
      artifact_id: String(row.artifact_id),
      run_id: row.run_id === null ? null : String(row.run_id),
      agent_id: row.agent_id === null ? null : String(row.agent_id),
      label: String(row.label),
      path: String(row.path),
      expected: booleanFromSqlite(row.expected),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private agentLinkFromRow(row: Row): AgentLinkRecord {
    return {
      link_id: String(row.link_id),
      run_id: String(row.run_id),
      source_agent_id: String(row.source_agent_id),
      target_agent_id: String(row.target_agent_id),
      type: String(row.type) as AgentLinkType,
      label: row.label === null ? null : String(row.label),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private usageSnapshotFromRow(row: Row): UsageSnapshotRecord {
    return {
      usage_id: String(row.usage_id),
      run_id: String(row.run_id),
      agent_id: String(row.agent_id),
      input_tokens: nullableNumber(row.input_tokens),
      output_tokens: nullableNumber(row.output_tokens),
      total_tokens: nullableNumber(row.total_tokens),
      context_used: nullableNumber(row.context_used),
      context_limit: nullableNumber(row.context_limit),
      source: row.source === null ? null : String(row.source),
      model: row.model === null ? null : String(row.model),
      captured_at: String(row.captured_at)
    };
  }

  private flowFromRow(row: Row): FlowRecord {
    const config = parseJsonObject(row.config_json);
    if (!config) {
      throw new Error(`Invalid flow config row: ${String(row.flow_record_id)}`);
    }
    return {
      flow_record_id: String(row.flow_record_id),
      flow_id: String(row.flow_id),
      version: row.version === null ? null : String(row.version),
      description: row.description === null ? null : String(row.description),
      config: config as unknown as FlowConfig,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private flowInstanceFromRow(row: Row): FlowInstanceRecord {
    return {
      flow_instance_id: String(row.flow_instance_id),
      flow_record_id: String(row.flow_record_id),
      run_id: String(row.run_id),
      orchestrator_agent_id:
        row.orchestrator_agent_id === null || row.orchestrator_agent_id === undefined
          ? null
          : String(row.orchestrator_agent_id),
      originating_bridge_grant_id:
        row.originating_bridge_grant_id === null ||
        row.originating_bridge_grant_id === undefined
          ? null
          : String(row.originating_bridge_grant_id),
      status: String(row.status) as FlowInstanceStatus,
      current_step_id: row.current_step_id === null ? null : String(row.current_step_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private flowStepInstanceFromRow(row: Row): FlowStepInstanceRecord {
    return {
      step_instance_id: String(row.step_instance_id),
      flow_instance_id: String(row.flow_instance_id),
      step_id: String(row.step_id),
      agent_id: row.agent_id === null ? null : String(row.agent_id),
      status: String(row.status) as FlowStepInstanceStatus,
      input_json: parseJsonObject(row.input_json) ?? {},
      output_json: parseJsonObject(row.output_json) ?? {},
      result_json: parseJsonObject(row.result_json) ?? {},
      transition_id: row.transition_id === null ? null : String(row.transition_id),
      summary: row.summary === null ? null : String(row.summary),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      completed_at: row.completed_at === null ? null : String(row.completed_at)
    };
  }

  private flowStepReportFromRow(row: Row): FlowStepReportRecord {
    return {
      report_id: String(row.report_id),
      step_instance_id: String(row.step_instance_id),
      status: String(row.status) as FlowStepInstanceStatus,
      result_json: parseJsonObject(row.result_json) ?? {},
      artifacts_json: parseJsonObject(row.artifacts_json) ?? {},
      summary: row.summary === null ? null : String(row.summary),
      created_at: String(row.created_at)
    };
  }

  private flowTransitionFromRow(row: Row): FlowTransitionRecord {
    return {
      flow_transition_id: String(row.flow_transition_id),
      flow_instance_id: String(row.flow_instance_id),
      from_step_instance_id: String(row.from_step_instance_id),
      transition_id: String(row.transition_id),
      target_step_id: row.target_step_id === null ? null : String(row.target_step_id),
      action_json: parseJsonObject(row.action_json) ?? {},
      created_at: String(row.created_at)
    };
  }

  private flowArtifactBindingFromRow(row: Row): FlowArtifactBindingRecord {
    return {
      binding_id: String(row.binding_id),
      flow_instance_id: String(row.flow_instance_id),
      artifact_key: String(row.artifact_key),
      artifact_id: row.artifact_id === null ? null : String(row.artifact_id),
      path: String(row.path),
      produced_by_step_instance_id:
        row.produced_by_step_instance_id === null ? null : String(row.produced_by_step_instance_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private agentPurgeRowCounts(agentId: string): Record<string, number> {
    const flowStepIds = this.flowStepInstanceIdsForAgent(agentId);
    const flowStepReports = inCondition("step_instance_id", flowStepIds);
    const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);
    const flowStepBindings = inCondition("produced_by_step_instance_id", flowStepIds);

    return {
      agent_work_acceptances: this.count(
        "select count(*) as count from agent_work_acceptances where agent_id = ?",
        agentId
      ),
      subscription_deliveries: this.count(
        `select count(*) as count from subscription_deliveries
         where subscriber_agent_id = ?
            or event_id in (select event_id from events where agent_id = ?)`,
        agentId,
        agentId
      ),
      agent_start_attempts: this.count(
        "select count(*) as count from agent_start_attempts where agent_id = ?",
        agentId
      ),
      orchestrator_actions: this.count(
        "select count(*) as count from orchestrator_actions where agent_id = ? or orchestrator_agent_id = ?",
        agentId,
        agentId
      ),
      bridge_grants: this.count(
        "select count(*) as count from bridge_grants where orchestrator_agent_id = ?",
        agentId
      ),
      codex_subagent_external_states: this.count(
        "select count(*) as count from codex_subagent_external_states where agent_id = ?",
        agentId
      ),
      flow_step_reports: this.count(
        `select count(*) as count from flow_step_reports where ${flowStepReports.sql}`,
        ...flowStepReports.values
      ),
      flow_transitions: this.count(
        `select count(*) as count from flow_transitions where ${flowStepTransitions.sql}`,
        ...flowStepTransitions.values
      ),
      flow_artifact_bindings: this.count(
        `select count(*) as count from flow_artifact_bindings where ${flowStepBindings.sql}`,
        ...flowStepBindings.values
      ),
      flow_step_instances: this.count("select count(*) as count from flow_step_instances where agent_id = ?", agentId),
      subscriptions: this.count(
        "select count(*) as count from subscriptions where source_agent_id = ? or subscriber_agent_id = ?",
        agentId,
        agentId
      ),
      agent_links: this.count(
        "select count(*) as count from agent_links where source_agent_id = ? or target_agent_id = ?",
        agentId,
        agentId
      ),
      heartbeats: this.count("select count(*) as count from heartbeats where agent_id = ?", agentId),
      goals: this.count("select count(*) as count from goals where agent_id = ?", agentId),
      artifacts: this.count("select count(*) as count from artifacts where agent_id = ?", agentId),
      usage_snapshots: this.count("select count(*) as count from usage_snapshots where agent_id = ?", agentId),
      agent_tokens: this.count("select count(*) as count from agent_tokens where agent_id = ?", agentId),
      adapter_handles: this.count(
        "select count(*) as count from adapter_handles where agent_id = ?",
        agentId
      ),
      events: this.count("select count(*) as count from events where agent_id = ?", agentId),
      agents: this.count("select count(*) as count from agents where agent_id = ?", agentId)
    };
  }

  private runPurgeRowCounts(runId: string): Record<string, number> {
    const agentIds = this.agentIdsForRun(runId);
    const agentEvents = inCondition("agent_id", agentIds);
    const sourceSubs = inCondition("source_agent_id", agentIds);
    const subscriberSubs = inCondition("subscriber_agent_id", agentIds);
    const sourceLinks = inCondition("source_agent_id", agentIds);
    const targetLinks = inCondition("target_agent_id", agentIds);
    const agentScoped = inCondition("agent_id", agentIds);
    const deliverySubscribers = inCondition("subscriber_agent_id", agentIds);
    const flowInstanceIds = this.flowInstanceIdsForRun(runId);
    const flowRecordIds = this.flowRecordIdsForRun(runId);
    const flowStepIds = this.flowStepInstanceIdsForRun(runId);
    const flowInstances = inCondition("flow_instance_id", flowInstanceIds);
    const flowRecords = inCondition("flow_record_id", flowRecordIds);
    const flowStepReports = inCondition("step_instance_id", flowStepIds);
    const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);

    return {
      agent_work_acceptances: this.count(
        `select count(*) as count from agent_work_acceptances where ${agentScoped.sql}`,
        ...agentScoped.values
      ),
      subscription_deliveries: this.count(
        `select count(*) as count from subscription_deliveries
         where ${deliverySubscribers.sql}
            or event_id in (
              select event_id from events
              where run_id = ? or ${agentEvents.sql}
            )`,
        ...deliverySubscribers.values,
        runId,
        ...agentEvents.values
      ),
      agent_start_attempts: this.count(
        `select count(*) as count from agent_start_attempts where ${agentScoped.sql}`,
        ...agentScoped.values
      ),
      orchestrator_actions: this.count(
        "select count(*) as count from orchestrator_actions where run_id = ?",
        runId
      ),
      bridge_grants: this.count("select count(*) as count from bridge_grants where run_id = ?", runId),
      codex_subagent_external_states: this.count(
        `select count(*) as count from codex_subagent_external_states where ${agentScoped.sql}`,
        ...agentScoped.values
      ),
      flows: this.count(`select count(*) as count from flows where ${flowRecords.sql}`, ...flowRecords.values),
      flow_instances: this.count("select count(*) as count from flow_instances where run_id = ?", runId),
      flow_step_instances: this.count(
        `select count(*) as count from flow_step_instances where ${flowInstances.sql}`,
        ...flowInstances.values
      ),
      flow_step_reports: this.count(
        `select count(*) as count from flow_step_reports where ${flowStepReports.sql}`,
        ...flowStepReports.values
      ),
      flow_transitions: this.count(
        `select count(*) as count from flow_transitions where ${flowStepTransitions.sql}`,
        ...flowStepTransitions.values
      ),
      flow_artifact_bindings: this.count(
        `select count(*) as count from flow_artifact_bindings where ${flowInstances.sql}`,
        ...flowInstances.values
      ),
      subscriptions: this.count(
        `select count(*) as count from subscriptions where run_id = ? or ${sourceSubs.sql} or ${subscriberSubs.sql}`,
        runId,
        ...sourceSubs.values,
        ...subscriberSubs.values
      ),
      agent_links: this.count(
        `select count(*) as count from agent_links where run_id = ? or ${sourceLinks.sql} or ${targetLinks.sql}`,
        runId,
        ...sourceLinks.values,
        ...targetLinks.values
      ),
      heartbeats: this.count(
        `select count(*) as count from heartbeats where ${agentScoped.sql}`,
        ...agentScoped.values
      ),
      goals: this.count(`select count(*) as count from goals where ${agentScoped.sql}`, ...agentScoped.values),
      artifacts: this.count(
        `select count(*) as count from artifacts where run_id = ? or ${agentScoped.sql}`,
        runId,
        ...agentScoped.values
      ),
      usage_snapshots: this.count(
        `select count(*) as count from usage_snapshots where run_id = ? or ${agentScoped.sql}`,
        runId,
        ...agentScoped.values
      ),
      agent_tokens: this.count(
        `select count(*) as count from agent_tokens where ${agentScoped.sql}`,
        ...agentScoped.values
      ),
      adapter_handles: this.count(
        `select count(*) as count from adapter_handles where ${agentScoped.sql}`,
        ...agentScoped.values
      ),
      events: this.count(
        `select count(*) as count from events where run_id = ? or ${agentEvents.sql}`,
        runId,
        ...agentEvents.values
      ),
      agents: this.count("select count(*) as count from agents where run_id = ?", runId),
      runs: this.count("select count(*) as count from runs where run_id = ?", runId)
    };
  }

  private agentIdsForRun(runId: string): string[] {
    const rows = this.db.prepare("select agent_id from agents where run_id = ?").all(runId) as Row[];
    return rows.map((row) => String(row.agent_id));
  }

  private flowInstanceIdsForRun(runId: string): string[] {
    const rows = this.db.prepare("select flow_instance_id from flow_instances where run_id = ?").all(runId) as Row[];
    return rows.map((row) => String(row.flow_instance_id));
  }

  private flowRecordIdsForRun(runId: string): string[] {
    const rows = this.db.prepare("select flow_record_id from flow_instances where run_id = ?").all(runId) as Row[];
    return rows.map((row) => String(row.flow_record_id));
  }

  private flowStepInstanceIdsForRun(runId: string): string[] {
    const rows = this.db
      .prepare(
        `select flow_step_instances.step_instance_id
         from flow_step_instances
         join flow_instances on flow_instances.flow_instance_id = flow_step_instances.flow_instance_id
         where flow_instances.run_id = ?`
      )
      .all(runId) as Row[];
    return rows.map((row) => String(row.step_instance_id));
  }

  private flowStepInstanceIdsForAgent(agentId: string): string[] {
    const rows = this.db
      .prepare("select step_instance_id from flow_step_instances where agent_id = ?")
      .all(agentId) as Row[];
    return rows.map((row) => String(row.step_instance_id));
  }

  private count(sql: string, ...values: unknown[]): number {
    const row = this.db.prepare(sql).get(...values) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inCondition(column: string, values: string[]): { sql: string; values: string[] } {
  if (values.length === 0) {
    return { sql: "0 = 1", values: [] };
  }
  return {
    sql: `${column} in (${values.map(() => "?").join(", ")})`,
    values
  };
}
