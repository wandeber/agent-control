import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newId, nowIso } from "../core/ids.js";
import { defaultStatePath } from "../core/paths.js";
function parseJsonObject(value) {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
}
function booleanFromSqlite(value) {
    return value === 1 || value === true;
}
export class SqliteStore {
    db;
    constructor(path = defaultStatePath()) {
        mkdirSync(dirname(path), { recursive: true });
        this.db = new Database(path);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.migrate();
    }
    close() {
        this.db.close();
    }
    createRun(input) {
        const now = nowIso();
        const run = {
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
            .prepare(`insert into runs (
          run_id, title, repo_dir, parent_run_id, created_by_agent_id, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(run.run_id, run.title, run.repo_dir, run.parent_run_id, run.created_by_agent_id, run.status, run.created_at, run.updated_at);
        return run;
    }
    getRun(runId) {
        const row = this.db.prepare("select * from runs where run_id = ?").get(runId);
        return row ? this.runFromRow(row) : null;
    }
    listRuns(limit = 50) {
        const rows = this.db
            .prepare("select * from runs order by created_at desc limit ?")
            .all(limit);
        return rows.map((row) => this.runFromRow(row));
    }
    listStoppedRunsOlderThan(cutoffIso) {
        const rows = this.db
            .prepare("select * from runs where status = 'stopped' and updated_at < ? order by updated_at asc")
            .all(cutoffIso);
        return rows.map((row) => this.runFromRow(row));
    }
    updateRunStatus(runId, status) {
        this.db
            .prepare("update runs set status = ?, updated_at = ? where run_id = ?")
            .run(status, nowIso(), runId);
        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Run not found after update: ${runId}`);
        }
        return run;
    }
    createAgent(input) {
        const now = nowIso();
        const agent = {
            agent_id: newId("agent"),
            run_id: input.runId,
            backend: input.backend,
            title: input.title,
            role: input.role ?? null,
            objective: input.objective ?? null,
            repo_dir: input.repoDir ?? null,
            model: input.model ?? null,
            backend_handle: input.backendHandle ?? null,
            status: input.status ?? "queued",
            failure_reason: null,
            unregistered_at: null,
            created_at: now,
            updated_at: now
        };
        this.db
            .prepare(`insert into agents (
          agent_id, run_id, backend, title, role, objective, repo_dir, model,
          backend_handle_json, status, failure_reason, unregistered_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(agent.agent_id, agent.run_id, agent.backend, agent.title, agent.role, agent.objective, agent.repo_dir, agent.model, agent.backend_handle ? JSON.stringify(agent.backend_handle) : null, agent.status, agent.failure_reason, agent.unregistered_at, agent.created_at, agent.updated_at);
        return agent;
    }
    getAgent(agentId) {
        const row = this.db.prepare("select * from agents where agent_id = ?").get(agentId);
        return row ? this.agentFromRow(row) : null;
    }
    listAgents(input = {}) {
        const clauses = [];
        const values = [];
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
            .all(...values);
        return rows.map((row) => this.agentFromRow(row));
    }
    listUnregisteredAgentsOlderThan(cutoffIso, excludeRunIds = []) {
        const rows = this.db
            .prepare("select * from agents where unregistered_at is not null and unregistered_at < ? order by unregistered_at asc")
            .all(cutoffIso);
        const excluded = new Set(excludeRunIds);
        return rows.map((row) => this.agentFromRow(row)).filter((agent) => !excluded.has(agent.run_id));
    }
    updateAgent(agentId, patch) {
        const assignments = ["updated_at = ?"];
        const values = [nowIso()];
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
    createAgentToken(input) {
        const token = {
            token_id: newId("token"),
            agent_id: input.agentId,
            token_hash: input.tokenHash,
            created_at: nowIso(),
            revoked_at: null
        };
        this.db
            .prepare("insert into agent_tokens (token_id, agent_id, token_hash, created_at, revoked_at) values (?, ?, ?, ?, ?)")
            .run(token.token_id, token.agent_id, token.token_hash, token.created_at, token.revoked_at);
        return token;
    }
    getAgentByTokenHash(tokenHash) {
        const row = this.db
            .prepare(`select agents.*
         from agent_tokens
         join agents on agents.agent_id = agent_tokens.agent_id
         where agent_tokens.token_hash = ? and agent_tokens.revoked_at is null
         limit 1`)
            .get(tokenHash);
        return row ? this.agentFromRow(row) : null;
    }
    revokeAgentToken(tokenId) {
        this.db.prepare("update agent_tokens set revoked_at = ? where token_id = ?").run(nowIso(), tokenId);
    }
    createEvent(input) {
        const event = {
            event_id: newId("event"),
            run_id: input.runId ?? null,
            agent_id: input.agentId ?? null,
            type: input.type,
            payload: input.payload ?? {},
            created_at: nowIso()
        };
        this.db
            .prepare("insert into events (event_id, run_id, agent_id, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?)")
            .run(event.event_id, event.run_id, event.agent_id, event.type, JSON.stringify(event.payload), event.created_at);
        return event;
    }
    listEvents(input = {}) {
        const clauses = [];
        const values = [];
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
            .all(...values);
        return rows.map((row) => this.eventFromRow(row));
    }
    createSubscription(input) {
        const now = nowIso();
        const subscription = {
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
            .prepare(`insert into subscriptions (
          subscription_id, run_id, source_agent_id, subscriber_agent_id, event_type,
          enabled, last_delivered_event_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(subscription.subscription_id, subscription.run_id, subscription.source_agent_id, subscription.subscriber_agent_id, subscription.event_type, 1, null, subscription.created_at, subscription.updated_at);
        return subscription;
    }
    listSubscriptions(input = {}) {
        const clauses = [];
        const values = [];
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
            .all(...values);
        return rows.map((row) => this.subscriptionFromRow(row));
    }
    updateSubscriptionDelivery(subscriptionId, eventId) {
        this.db
            .prepare("update subscriptions set last_delivered_event_id = ?, delivery_claim_event_id = null, delivery_claimed_at = null, updated_at = ? where subscription_id = ?")
            .run(eventId, nowIso(), subscriptionId);
    }
    tryClaimSubscriptionDelivery(subscriptionId, eventId, claimTtlMs = 300_000) {
        const now = nowIso();
        const staleBefore = new Date(Date.now() - claimTtlMs).toISOString();
        const result = this.db
            .prepare(`update subscriptions
         set delivery_claim_event_id = ?, delivery_claimed_at = ?, updated_at = ?
         where subscription_id = ?
           and enabled = 1
           and (last_delivered_event_id is null or last_delivered_event_id != ?)
           and (delivery_claim_event_id is null or delivery_claimed_at is null or delivery_claimed_at < ?)`)
            .run(eventId, now, now, subscriptionId, eventId, staleBefore);
        return result.changes > 0;
    }
    clearSubscriptionDeliveryClaim(subscriptionId, eventId) {
        this.db
            .prepare(`update subscriptions
         set delivery_claim_event_id = null, delivery_claimed_at = null, updated_at = ?
         where subscription_id = ? and delivery_claim_event_id = ?`)
            .run(nowIso(), subscriptionId, eventId);
    }
    deleteSubscription(subscriptionId) {
        this.db.prepare("delete from subscriptions where subscription_id = ?").run(subscriptionId);
    }
    createHeartbeat(input) {
        const now = nowIso();
        const heartbeat = {
            heartbeat_id: newId("heartbeat"),
            agent_id: input.agentId,
            idle_timeout_ms: input.idleTimeoutMs,
            reminder_interval_ms: input.reminderIntervalMs ?? null,
            last_event_at: now,
            created_at: now,
            updated_at: now
        };
        this.db
            .prepare(`insert into heartbeats (
          heartbeat_id, agent_id, idle_timeout_ms, reminder_interval_ms,
          last_event_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`)
            .run(heartbeat.heartbeat_id, heartbeat.agent_id, heartbeat.idle_timeout_ms, heartbeat.reminder_interval_ms, heartbeat.last_event_at, heartbeat.created_at, heartbeat.updated_at);
        return heartbeat;
    }
    listHeartbeats(agentId) {
        const rows = agentId
            ? this.db
                .prepare("select * from heartbeats where agent_id = ? order by created_at asc")
                .all(agentId)
            : this.db.prepare("select * from heartbeats order by created_at asc").all();
        return rows.map((row) => this.heartbeatFromRow(row));
    }
    touchHeartbeat(agentId, at = nowIso()) {
        this.db
            .prepare("update heartbeats set last_event_at = ?, updated_at = ? where agent_id = ?")
            .run(at, nowIso(), agentId);
    }
    deleteHeartbeat(heartbeatId) {
        this.db.prepare("delete from heartbeats where heartbeat_id = ?").run(heartbeatId);
    }
    createGoal(input) {
        const now = nowIso();
        const goal = {
            goal_id: newId("goal"),
            agent_id: input.agentId,
            objective: input.objective,
            status: "active",
            created_at: now,
            updated_at: now
        };
        this.db
            .prepare("insert into goals (goal_id, agent_id, objective, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
            .run(goal.goal_id, goal.agent_id, goal.objective, goal.status, goal.created_at, goal.updated_at);
        return goal;
    }
    getGoal(goalId) {
        const row = this.db.prepare("select * from goals where goal_id = ?").get(goalId);
        return row ? this.goalFromRow(row) : null;
    }
    listGoals(agentId) {
        const rows = agentId
            ? this.db.prepare("select * from goals where agent_id = ? order by created_at asc").all(agentId)
            : this.db.prepare("select * from goals order by created_at asc").all();
        return rows.map((row) => this.goalFromRow(row));
    }
    updateGoal(goalId, status) {
        this.db
            .prepare("update goals set status = ?, updated_at = ? where goal_id = ?")
            .run(status, nowIso(), goalId);
        const goal = this.getGoal(goalId);
        if (!goal) {
            throw new Error(`Goal not found after update: ${goalId}`);
        }
        return goal;
    }
    deleteGoal(goalId) {
        this.db.prepare("delete from goals where goal_id = ?").run(goalId);
    }
    createArtifact(input) {
        const now = nowIso();
        const artifact = {
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
            .prepare("insert into artifacts (artifact_id, run_id, agent_id, label, path, expected, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(artifact.artifact_id, artifact.run_id, artifact.agent_id, artifact.label, artifact.path, artifact.expected ? 1 : 0, artifact.created_at, artifact.updated_at);
        return artifact;
    }
    listArtifacts(input = {}) {
        const clauses = [];
        const values = [];
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
            .all(...values);
        return rows.map((row) => this.artifactFromRow(row));
    }
    createAgentLink(input) {
        const now = nowIso();
        const link = {
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
            .prepare(`insert into agent_links (
          link_id, run_id, source_agent_id, target_agent_id, type, label, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(link.link_id, link.run_id, link.source_agent_id, link.target_agent_id, link.type, link.label, link.created_at, link.updated_at);
        return link;
    }
    listAgentLinks(input = {}) {
        const clauses = [];
        const values = [];
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
            .all(...values);
        return rows.map((row) => this.agentLinkFromRow(row));
    }
    deleteAgentLink(linkId) {
        this.db.prepare("delete from agent_links where link_id = ?").run(linkId);
    }
    createUsageSnapshot(input) {
        const snapshot = {
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
            .prepare(`insert into usage_snapshots (
          usage_id, run_id, agent_id, input_tokens, output_tokens, total_tokens,
          context_used, context_limit, source, model, captured_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(snapshot.usage_id, snapshot.run_id, snapshot.agent_id, snapshot.input_tokens, snapshot.output_tokens, snapshot.total_tokens, snapshot.context_used, snapshot.context_limit, snapshot.source, snapshot.model, snapshot.captured_at);
        return snapshot;
    }
    listUsageSnapshots(input = {}) {
        const clauses = [];
        const values = [];
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
            .all(...values);
        return rows.map((row) => this.usageSnapshotFromRow(row));
    }
    createFlow(config) {
        const now = nowIso();
        const flow = {
            flow_record_id: newId("flow"),
            flow_id: config.id,
            version: config.version ?? null,
            description: config.description ?? null,
            config,
            created_at: now,
            updated_at: now
        };
        this.db
            .prepare(`insert into flows (
          flow_record_id, flow_id, version, description, config_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`)
            .run(flow.flow_record_id, flow.flow_id, flow.version, flow.description, JSON.stringify(flow.config), flow.created_at, flow.updated_at);
        return flow;
    }
    getFlow(flowRecordId) {
        const row = this.db.prepare("select * from flows where flow_record_id = ?").get(flowRecordId);
        return row ? this.flowFromRow(row) : null;
    }
    createFlowInstance(input) {
        const now = nowIso();
        const instance = {
            flow_instance_id: newId("flowinst"),
            flow_record_id: input.flowRecordId,
            run_id: input.runId,
            status: "active",
            current_step_id: input.currentStepId ?? null,
            created_at: now,
            updated_at: now
        };
        this.db
            .prepare(`insert into flow_instances (
          flow_instance_id, flow_record_id, run_id, status, current_step_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`)
            .run(instance.flow_instance_id, instance.flow_record_id, instance.run_id, instance.status, instance.current_step_id, instance.created_at, instance.updated_at);
        return instance;
    }
    getFlowInstance(flowInstanceId) {
        const row = this.db
            .prepare("select * from flow_instances where flow_instance_id = ?")
            .get(flowInstanceId);
        return row ? this.flowInstanceFromRow(row) : null;
    }
    listFlowInstances(input = {}) {
        const clauses = [];
        const values = [];
        if (input.runId) {
            clauses.push("run_id = ?");
            values.push(input.runId);
        }
        const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
        const rows = this.db
            .prepare(`select * from flow_instances ${where} order by created_at asc`)
            .all(...values);
        return rows.map((row) => this.flowInstanceFromRow(row));
    }
    updateFlowInstance(flowInstanceId, patch) {
        const assignments = ["updated_at = ?"];
        const values = [nowIso()];
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
    createFlowStepInstance(input) {
        const now = nowIso();
        const step = {
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
            .prepare(`insert into flow_step_instances (
          step_instance_id, flow_instance_id, step_id, agent_id, status, input_json,
          output_json, result_json, transition_id, summary, created_at, updated_at,
          completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(step.step_instance_id, step.flow_instance_id, step.step_id, step.agent_id, step.status, JSON.stringify(step.input_json), JSON.stringify(step.output_json), JSON.stringify(step.result_json), step.transition_id, step.summary, step.created_at, step.updated_at, step.completed_at);
        return step;
    }
    getFlowStepInstance(stepInstanceId) {
        const row = this.db
            .prepare("select * from flow_step_instances where step_instance_id = ?")
            .get(stepInstanceId);
        return row ? this.flowStepInstanceFromRow(row) : null;
    }
    listFlowStepInstances(flowInstanceId) {
        const rows = this.db
            .prepare("select * from flow_step_instances where flow_instance_id = ? order by created_at asc")
            .all(flowInstanceId);
        return rows.map((row) => this.flowStepInstanceFromRow(row));
    }
    updateFlowStepInstance(stepInstanceId, patch) {
        const assignments = ["updated_at = ?"];
        const values = [nowIso()];
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
    createFlowStepReport(input) {
        const report = {
            report_id: newId("flowreport"),
            step_instance_id: input.stepInstanceId,
            status: input.status,
            result_json: input.resultJson ?? {},
            artifacts_json: input.artifactsJson ?? {},
            summary: input.summary ?? null,
            created_at: nowIso()
        };
        this.db
            .prepare(`insert into flow_step_reports (
          report_id, step_instance_id, status, result_json, artifacts_json, summary, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)`)
            .run(report.report_id, report.step_instance_id, report.status, JSON.stringify(report.result_json), JSON.stringify(report.artifacts_json), report.summary, report.created_at);
        return report;
    }
    listFlowStepReports(flowInstanceId) {
        const rows = this.db
            .prepare(`select flow_step_reports.*
         from flow_step_reports
         join flow_step_instances on flow_step_instances.step_instance_id = flow_step_reports.step_instance_id
         where flow_step_instances.flow_instance_id = ?
         order by flow_step_reports.created_at asc`)
            .all(flowInstanceId);
        return rows.map((row) => this.flowStepReportFromRow(row));
    }
    createFlowTransition(input) {
        const transition = {
            flow_transition_id: newId("flowtrans"),
            flow_instance_id: input.flowInstanceId,
            from_step_instance_id: input.fromStepInstanceId,
            transition_id: input.transitionId,
            target_step_id: input.targetStepId ?? null,
            action_json: input.actionJson ?? {},
            created_at: nowIso()
        };
        this.db
            .prepare(`insert into flow_transitions (
          flow_transition_id, flow_instance_id, from_step_instance_id,
          transition_id, target_step_id, action_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)`)
            .run(transition.flow_transition_id, transition.flow_instance_id, transition.from_step_instance_id, transition.transition_id, transition.target_step_id, JSON.stringify(transition.action_json), transition.created_at);
        return transition;
    }
    listFlowTransitions(flowInstanceId) {
        const rows = this.db
            .prepare("select * from flow_transitions where flow_instance_id = ? order by created_at asc")
            .all(flowInstanceId);
        return rows.map((row) => this.flowTransitionFromRow(row));
    }
    upsertFlowArtifactBinding(input) {
        const existing = this.db
            .prepare("select * from flow_artifact_bindings where flow_instance_id = ? and artifact_key = ?")
            .get(input.flowInstanceId, input.artifactKey);
        const now = nowIso();
        if (existing) {
            this.db
                .prepare(`update flow_artifact_bindings
           set artifact_id = ?, path = ?, produced_by_step_instance_id = ?, updated_at = ?
           where flow_instance_id = ? and artifact_key = ?`)
                .run(input.artifactId ?? null, input.path, input.producedByStepInstanceId ?? null, now, input.flowInstanceId, input.artifactKey);
            return this.flowArtifactBindingFromRow({
                ...existing,
                artifact_id: input.artifactId ?? null,
                path: input.path,
                produced_by_step_instance_id: input.producedByStepInstanceId ?? null,
                updated_at: now
            });
        }
        const binding = {
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
            .prepare(`insert into flow_artifact_bindings (
          binding_id, flow_instance_id, artifact_key, artifact_id, path,
          produced_by_step_instance_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(binding.binding_id, binding.flow_instance_id, binding.artifact_key, binding.artifact_id, binding.path, binding.produced_by_step_instance_id, binding.created_at, binding.updated_at);
        return binding;
    }
    listFlowArtifactBindings(flowInstanceId) {
        const rows = this.db
            .prepare("select * from flow_artifact_bindings where flow_instance_id = ? order by created_at asc")
            .all(flowInstanceId);
        return rows.map((row) => this.flowArtifactBindingFromRow(row));
    }
    countAgentPurgeRows(agentId) {
        return this.agentPurgeRowCounts(agentId);
    }
    purgeAgentRows(agentId, dryRun) {
        const counts = this.agentPurgeRowCounts(agentId);
        if (dryRun) {
            return counts;
        }
        const flowStepIds = this.flowStepInstanceIdsForAgent(agentId);
        const flowStepReports = inCondition("step_instance_id", flowStepIds);
        const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);
        const flowStepBindings = inCondition("produced_by_step_instance_id", flowStepIds);
        const purge = this.db.transaction(() => {
            this.db.prepare(`delete from flow_step_reports where ${flowStepReports.sql}`).run(...flowStepReports.values);
            this.db.prepare(`delete from flow_transitions where ${flowStepTransitions.sql}`).run(...flowStepTransitions.values);
            this.db
                .prepare(`delete from flow_artifact_bindings where ${flowStepBindings.sql}`)
                .run(...flowStepBindings.values);
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
    countRunPurgeRows(runId) {
        return this.runPurgeRowCounts(runId);
    }
    purgeRunRows(runId, dryRun) {
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
        const flowInstanceIds = this.flowInstanceIdsForRun(runId);
        const flowRecordIds = this.flowRecordIdsForRun(runId);
        const flowStepIds = this.flowStepInstanceIdsForRun(runId);
        const flowInstances = inCondition("flow_instance_id", flowInstanceIds);
        const flowRecords = inCondition("flow_record_id", flowRecordIds);
        const flowStepReports = inCondition("step_instance_id", flowStepIds);
        const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);
        const purge = this.db.transaction(() => {
            this.db.prepare(`delete from flow_step_reports where ${flowStepReports.sql}`).run(...flowStepReports.values);
            this.db.prepare(`delete from flow_transitions where ${flowStepTransitions.sql}`).run(...flowStepTransitions.values);
            this.db.prepare(`delete from flow_artifact_bindings where ${flowInstances.sql}`).run(...flowInstances.values);
            this.db.prepare(`delete from flow_step_instances where ${flowInstances.sql}`).run(...flowInstances.values);
            this.db.prepare("delete from flow_instances where run_id = ?").run(runId);
            this.db.prepare(`delete from flows where ${flowRecords.sql}`).run(...flowRecords.values);
            this.db
                .prepare(`delete from subscriptions where run_id = ? or ${sourceSubs.sql} or ${subscriberSubs.sql}`)
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
    migrate() {
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
        status text not null,
        failure_reason text,
        unregistered_at text,
        created_at text not null,
        updated_at text not null
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
    `);
        this.ensureColumn("runs", "parent_run_id", "text");
        this.ensureColumn("runs", "created_by_agent_id", "text");
        this.ensureColumn("subscriptions", "delivery_claim_event_id", "text");
        this.ensureColumn("subscriptions", "delivery_claimed_at", "text");
        this.db.exec(`
      create index if not exists idx_agents_run on agents(run_id);
      create index if not exists idx_runs_parent on runs(parent_run_id);
      create index if not exists idx_runs_created_by_agent on runs(created_by_agent_id);
      create index if not exists idx_events_run_created on events(run_id, created_at);
      create index if not exists idx_events_agent_created on events(agent_id, created_at);
      create index if not exists idx_subscriptions_source on subscriptions(source_agent_id, event_type);
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
      create index if not exists idx_flow_step_instances_flow on flow_step_instances(flow_instance_id, created_at);
      create index if not exists idx_flow_step_instances_agent on flow_step_instances(agent_id);
      create index if not exists idx_flow_step_reports_step on flow_step_reports(step_instance_id);
      create index if not exists idx_flow_transitions_flow on flow_transitions(flow_instance_id);
      create index if not exists idx_flow_artifact_bindings_flow on flow_artifact_bindings(flow_instance_id);
    `);
    }
    ensureColumn(table, column, definition) {
        const rows = this.db.prepare(`pragma table_info(${table})`).all();
        const exists = rows.some((row) => row.name === column);
        if (!exists) {
            this.db.exec(`alter table ${table} add column ${column} ${definition}`);
        }
    }
    runFromRow(row) {
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
    agentFromRow(row) {
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
            status: String(row.status),
            failure_reason: row.failure_reason === null ? null : String(row.failure_reason),
            unregistered_at: row.unregistered_at === null ? null : String(row.unregistered_at),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    eventFromRow(row) {
        return {
            event_id: String(row.event_id),
            run_id: row.run_id === null ? null : String(row.run_id),
            agent_id: row.agent_id === null ? null : String(row.agent_id),
            type: String(row.type),
            payload: parseJsonObject(row.payload_json) ?? {},
            created_at: String(row.created_at)
        };
    }
    subscriptionFromRow(row) {
        return {
            subscription_id: String(row.subscription_id),
            run_id: row.run_id === null ? null : String(row.run_id),
            source_agent_id: row.source_agent_id === null ? null : String(row.source_agent_id),
            subscriber_agent_id: String(row.subscriber_agent_id),
            event_type: String(row.event_type),
            enabled: booleanFromSqlite(row.enabled),
            last_delivered_event_id: row.last_delivered_event_id === null ? null : String(row.last_delivered_event_id),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    heartbeatFromRow(row) {
        return {
            heartbeat_id: String(row.heartbeat_id),
            agent_id: String(row.agent_id),
            idle_timeout_ms: Number(row.idle_timeout_ms),
            reminder_interval_ms: row.reminder_interval_ms === null ? null : Number(row.reminder_interval_ms),
            last_event_at: row.last_event_at === null ? null : String(row.last_event_at),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    goalFromRow(row) {
        return {
            goal_id: String(row.goal_id),
            agent_id: String(row.agent_id),
            objective: String(row.objective),
            status: String(row.status),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    artifactFromRow(row) {
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
    agentLinkFromRow(row) {
        return {
            link_id: String(row.link_id),
            run_id: String(row.run_id),
            source_agent_id: String(row.source_agent_id),
            target_agent_id: String(row.target_agent_id),
            type: String(row.type),
            label: row.label === null ? null : String(row.label),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    usageSnapshotFromRow(row) {
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
    flowFromRow(row) {
        const config = parseJsonObject(row.config_json);
        if (!config) {
            throw new Error(`Invalid flow config row: ${String(row.flow_record_id)}`);
        }
        return {
            flow_record_id: String(row.flow_record_id),
            flow_id: String(row.flow_id),
            version: row.version === null ? null : String(row.version),
            description: row.description === null ? null : String(row.description),
            config: config,
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    flowInstanceFromRow(row) {
        return {
            flow_instance_id: String(row.flow_instance_id),
            flow_record_id: String(row.flow_record_id),
            run_id: String(row.run_id),
            status: String(row.status),
            current_step_id: row.current_step_id === null ? null : String(row.current_step_id),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    flowStepInstanceFromRow(row) {
        return {
            step_instance_id: String(row.step_instance_id),
            flow_instance_id: String(row.flow_instance_id),
            step_id: String(row.step_id),
            agent_id: row.agent_id === null ? null : String(row.agent_id),
            status: String(row.status),
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
    flowStepReportFromRow(row) {
        return {
            report_id: String(row.report_id),
            step_instance_id: String(row.step_instance_id),
            status: String(row.status),
            result_json: parseJsonObject(row.result_json) ?? {},
            artifacts_json: parseJsonObject(row.artifacts_json) ?? {},
            summary: row.summary === null ? null : String(row.summary),
            created_at: String(row.created_at)
        };
    }
    flowTransitionFromRow(row) {
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
    flowArtifactBindingFromRow(row) {
        return {
            binding_id: String(row.binding_id),
            flow_instance_id: String(row.flow_instance_id),
            artifact_key: String(row.artifact_key),
            artifact_id: row.artifact_id === null ? null : String(row.artifact_id),
            path: String(row.path),
            produced_by_step_instance_id: row.produced_by_step_instance_id === null ? null : String(row.produced_by_step_instance_id),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at)
        };
    }
    agentPurgeRowCounts(agentId) {
        const flowStepIds = this.flowStepInstanceIdsForAgent(agentId);
        const flowStepReports = inCondition("step_instance_id", flowStepIds);
        const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);
        const flowStepBindings = inCondition("produced_by_step_instance_id", flowStepIds);
        return {
            flow_step_reports: this.count(`select count(*) as count from flow_step_reports where ${flowStepReports.sql}`, ...flowStepReports.values),
            flow_transitions: this.count(`select count(*) as count from flow_transitions where ${flowStepTransitions.sql}`, ...flowStepTransitions.values),
            flow_artifact_bindings: this.count(`select count(*) as count from flow_artifact_bindings where ${flowStepBindings.sql}`, ...flowStepBindings.values),
            flow_step_instances: this.count("select count(*) as count from flow_step_instances where agent_id = ?", agentId),
            subscriptions: this.count("select count(*) as count from subscriptions where source_agent_id = ? or subscriber_agent_id = ?", agentId, agentId),
            agent_links: this.count("select count(*) as count from agent_links where source_agent_id = ? or target_agent_id = ?", agentId, agentId),
            heartbeats: this.count("select count(*) as count from heartbeats where agent_id = ?", agentId),
            goals: this.count("select count(*) as count from goals where agent_id = ?", agentId),
            artifacts: this.count("select count(*) as count from artifacts where agent_id = ?", agentId),
            usage_snapshots: this.count("select count(*) as count from usage_snapshots where agent_id = ?", agentId),
            agent_tokens: this.count("select count(*) as count from agent_tokens where agent_id = ?", agentId),
            adapter_handles: this.count("select count(*) as count from adapter_handles where agent_id = ?", agentId),
            events: this.count("select count(*) as count from events where agent_id = ?", agentId),
            agents: this.count("select count(*) as count from agents where agent_id = ?", agentId)
        };
    }
    runPurgeRowCounts(runId) {
        const agentIds = this.agentIdsForRun(runId);
        const agentEvents = inCondition("agent_id", agentIds);
        const sourceSubs = inCondition("source_agent_id", agentIds);
        const subscriberSubs = inCondition("subscriber_agent_id", agentIds);
        const sourceLinks = inCondition("source_agent_id", agentIds);
        const targetLinks = inCondition("target_agent_id", agentIds);
        const agentScoped = inCondition("agent_id", agentIds);
        const flowInstanceIds = this.flowInstanceIdsForRun(runId);
        const flowRecordIds = this.flowRecordIdsForRun(runId);
        const flowStepIds = this.flowStepInstanceIdsForRun(runId);
        const flowInstances = inCondition("flow_instance_id", flowInstanceIds);
        const flowRecords = inCondition("flow_record_id", flowRecordIds);
        const flowStepReports = inCondition("step_instance_id", flowStepIds);
        const flowStepTransitions = inCondition("from_step_instance_id", flowStepIds);
        return {
            flows: this.count(`select count(*) as count from flows where ${flowRecords.sql}`, ...flowRecords.values),
            flow_instances: this.count("select count(*) as count from flow_instances where run_id = ?", runId),
            flow_step_instances: this.count(`select count(*) as count from flow_step_instances where ${flowInstances.sql}`, ...flowInstances.values),
            flow_step_reports: this.count(`select count(*) as count from flow_step_reports where ${flowStepReports.sql}`, ...flowStepReports.values),
            flow_transitions: this.count(`select count(*) as count from flow_transitions where ${flowStepTransitions.sql}`, ...flowStepTransitions.values),
            flow_artifact_bindings: this.count(`select count(*) as count from flow_artifact_bindings where ${flowInstances.sql}`, ...flowInstances.values),
            subscriptions: this.count(`select count(*) as count from subscriptions where run_id = ? or ${sourceSubs.sql} or ${subscriberSubs.sql}`, runId, ...sourceSubs.values, ...subscriberSubs.values),
            agent_links: this.count(`select count(*) as count from agent_links where run_id = ? or ${sourceLinks.sql} or ${targetLinks.sql}`, runId, ...sourceLinks.values, ...targetLinks.values),
            heartbeats: this.count(`select count(*) as count from heartbeats where ${agentScoped.sql}`, ...agentScoped.values),
            goals: this.count(`select count(*) as count from goals where ${agentScoped.sql}`, ...agentScoped.values),
            artifacts: this.count(`select count(*) as count from artifacts where run_id = ? or ${agentScoped.sql}`, runId, ...agentScoped.values),
            usage_snapshots: this.count(`select count(*) as count from usage_snapshots where run_id = ? or ${agentScoped.sql}`, runId, ...agentScoped.values),
            agent_tokens: this.count(`select count(*) as count from agent_tokens where ${agentScoped.sql}`, ...agentScoped.values),
            adapter_handles: this.count(`select count(*) as count from adapter_handles where ${agentScoped.sql}`, ...agentScoped.values),
            events: this.count(`select count(*) as count from events where run_id = ? or ${agentEvents.sql}`, runId, ...agentEvents.values),
            agents: this.count("select count(*) as count from agents where run_id = ?", runId),
            runs: this.count("select count(*) as count from runs where run_id = ?", runId)
        };
    }
    agentIdsForRun(runId) {
        const rows = this.db.prepare("select agent_id from agents where run_id = ?").all(runId);
        return rows.map((row) => String(row.agent_id));
    }
    flowInstanceIdsForRun(runId) {
        const rows = this.db.prepare("select flow_instance_id from flow_instances where run_id = ?").all(runId);
        return rows.map((row) => String(row.flow_instance_id));
    }
    flowRecordIdsForRun(runId) {
        const rows = this.db.prepare("select flow_record_id from flow_instances where run_id = ?").all(runId);
        return rows.map((row) => String(row.flow_record_id));
    }
    flowStepInstanceIdsForRun(runId) {
        const rows = this.db
            .prepare(`select flow_step_instances.step_instance_id
         from flow_step_instances
         join flow_instances on flow_instances.flow_instance_id = flow_step_instances.flow_instance_id
         where flow_instances.run_id = ?`)
            .all(runId);
        return rows.map((row) => String(row.step_instance_id));
    }
    flowStepInstanceIdsForAgent(agentId) {
        const rows = this.db
            .prepare("select step_instance_id from flow_step_instances where agent_id = ?")
            .all(agentId);
        return rows.map((row) => String(row.step_instance_id));
    }
    count(sql, ...values) {
        const row = this.db.prepare(sql).get(...values);
        return Number(row?.count ?? 0);
    }
}
function nullableNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function inCondition(column, values) {
    if (values.length === 0) {
        return { sql: "0 = 1", values: [] };
    }
    return {
        sql: `${column} in (${values.map(() => "?").join(", ")})`,
        values
    };
}
