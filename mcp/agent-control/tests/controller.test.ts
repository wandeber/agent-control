import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeServerAdapter } from "../src/adapters/opencode-server-adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AgentController, buildGoalConfirmationPrompt } from "../src/core/controller.js";
import { resolveAdminKey } from "../src/core/identity.js";
import { agentRuntimePath, runRuntimePath } from "../src/core/paths.js";
import { handleTool } from "../src/tools/handlers.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHandle,
  AgentMessage,
  AgentMessageInput,
  AgentStatus,
  AgentStatusSnapshot,
  ReadLatestOptions,
  StartAgentInput,
  StopOptions,
  StopResult
} from "../src/core/types.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const CAPABILITIES: AgentCapabilities = {
  canStart: true,
  canSendMessage: true,
  canReadLatest: true,
  canStopGracefully: true,
  canForceStop: true,
  canStreamMessages: false,
  canInspectStatusCheaply: true,
  canAttachExisting: true
};

class FakeAdapter implements AgentAdapter {
  readonly sent: Array<{ handle: AgentHandle; message: string; metadata?: Record<string, unknown> }> = [];
  readonly starts: StartAgentInput[] = [];
  readonly stopped: AgentHandle[] = [];
  readonly statuses = new Map<string, AgentStatus>();
  stopStatus: AgentStatus = "stopped";

  constructor(readonly kind = "fake") {}

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async start(input: StartAgentInput): Promise<AgentHandle> {
    this.starts.push(input);
    this.statuses.set(input.agent.agent_id, "running");
    return {
      backend: this.kind,
      id: input.agent.agent_id,
      data: { id: input.agent.agent_id }
    };
  }

  async sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void> {
    this.sent.push({ handle, message: message.message, metadata: message.metadata });
  }

  async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> {
    return {
      status: this.statuses.get(handle.id) ?? "running"
    };
  }

  async readLatest(handle: AgentHandle, _options: ReadLatestOptions): Promise<AgentMessage[]> {
    return [
      {
        id: "message-1",
        role: "assistant",
        text: `latest from ${handle.id}`,
        created_at: new Date().toISOString()
      }
    ];
  }

  async stop(handle: AgentHandle, _options: StopOptions): Promise<StopResult> {
    this.stopped.push(handle);
    this.statuses.set(handle.id, this.stopStatus);
    return { status: this.stopStatus, data: { id: handle.id } };
  }
}

describe("AgentController", () => {
  let tmp: string;
  let store: SqliteStore;
  let adapter: FakeAdapter;
  let registry: AdapterRegistry;
  let controller: AgentController;
  let oldControlHome: string | undefined;
  let oldAdminKey: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-control-test-"));
    oldControlHome = process.env.AGENT_CONTROL_HOME;
    oldAdminKey = process.env.AGENT_CONTROL_ADMIN_KEY;
    process.env.AGENT_CONTROL_HOME = join(tmp, "home");
    delete process.env.AGENT_CONTROL_ADMIN_KEY;
    store = new SqliteStore(join(tmp, "state.sqlite"));
    adapter = new FakeAdapter();
    registry = new AdapterRegistry();
    registry.register(adapter);
    controller = new AgentController(store, registry);
  });

  afterEach(() => {
    store.close();
    if (oldControlHome === undefined) {
      delete process.env.AGENT_CONTROL_HOME;
    } else {
      process.env.AGENT_CONTROL_HOME = oldControlHome;
    }
    if (oldAdminKey === undefined) {
      delete process.env.AGENT_CONTROL_ADMIN_KEY;
    } else {
      process.env.AGENT_CONTROL_ADMIN_KEY = oldAdminKey;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("generates a persistent local admin key when no env override exists", () => {
    const first = resolveAdminKey();
    const second = resolveAdminKey();

    expect(first).toMatch(/^ack_/);
    expect(second).toBe(first);
  });

  it("uses the admin key env override when present", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_test_admin";

    expect(resolveAdminKey()).toBe("ack_test_admin");
  });

  it("logs in an orchestrator with an admin key and returns a usable agent token", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_login_test";

    const result = controller.orchestratorLogin({
      adminKey: "ack_login_test",
      title: "Root orchestration",
      repoDir: "/repo",
      backend: "fake"
    });
    const resolved = controller.requireAgentToken(result.agent_token);

    expect(result.run.parent_run_id).toBeNull();
    expect(result.run.created_by_agent_id).toBeNull();
    expect(result.agent.role).toBe("orchestrator");
    expect(resolved.agent_id).toBe(result.agent.agent_id);
  });

  it("reuses an existing orchestrator login for the same run and Codex thread handle", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_login_reuse_test";
    const backendHandle = {
      thread_id: "thread_123",
      agent_control_role: "orchestrator",
      cwd: "/repo"
    };

    const first = controller.orchestratorLogin({
      adminKey: "ack_login_reuse_test",
      title: "Reusable orchestrator",
      repoDir: "/repo",
      backend: "fake",
      backendHandle
    });
    const second = controller.orchestratorLogin({
      adminKey: "ack_login_reuse_test",
      title: "Reusable orchestrator",
      repoDir: "/repo",
      runId: first.run.run_id,
      backend: "fake",
      backendHandle
    });

    expect(second.run.run_id).toBe(first.run.run_id);
    expect(second.agent.agent_id).toBe(first.agent.agent_id);
    expect(controller.requireAgentToken(second.agent_token).agent_id).toBe(first.agent.agent_id);
    expect(controller.listAgents({ runId: first.run.run_id }).filter((agent) => agent.role === "orchestrator")).toHaveLength(1);
  });

  it("registers same-run children from the caller token and creates the hierarchy link", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_parent_child_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_parent_child_test",
      title: "Parent orchestration",
      backend: "fake"
    });

    const worker = controller.registerAgent({
      agentToken: login.agent_token,
      backend: "fake",
      title: "Implementation worker",
      role: "implementer"
    });
    const links = controller.listAgentLinks({ runId: login.run.run_id });

    expect(worker.run_id).toBe(login.run.run_id);
    expect(worker.agent_token).toMatch(/^act_/);
    expect(links).toMatchObject([
      {
        source_agent_id: login.agent.agent_id,
        target_agent_id: worker.agent_id,
        type: "parent_child",
        label: "implementer"
      }
    ]);
  });

  it("creates child runs from agent tokens and scopes run listing to accessible descendants", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_child_run_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_child_run_test",
      title: "Root run",
      backend: "fake"
    });
    const child = controller.createRun({
      title: "Child run",
      repoDir: "/repo/child",
      agentToken: login.agent_token
    });
    const siblingAgent = controller.registerAgent({
      runId: login.run.run_id,
      backend: "fake",
      title: "Sibling agent"
    });
    const siblingChild = controller.createRun({
      title: "Sibling child run",
      agentToken: siblingAgent.agent_token
    });
    const unrelated = controller.createRun({ title: "Unrelated run" });

    const visible = controller.listRuns(50, { agentToken: login.agent_token }).map((run) => run.run_id);
    const siblingVisible = controller.listRuns(50, { agentToken: siblingAgent.agent_token }).map((run) => run.run_id);

    expect(child.parent_run_id).toBe(login.run.run_id);
    expect(child.created_by_agent_id).toBe(login.agent.agent_id);
    expect(visible).toContain(login.run.run_id);
    expect(visible).toContain(child.run_id);
    expect(visible).not.toContain(siblingChild.run_id);
    expect(siblingVisible).toContain(login.run.run_id);
    expect(siblingVisible).toContain(siblingChild.run_id);
    expect(siblingVisible).not.toContain(child.run_id);
    expect(visible).not.toContain(unrelated.run_id);
  });

  it("injects a fresh worker token into adapter start inputs", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_start_token_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_start_token_test",
      title: "Token run",
      backend: "fake"
    });
    const worker = controller.registerAgent({
      agentToken: login.agent_token,
      backend: "fake",
      title: "Worker"
    });

    const started = await controller.startAgent({
      agentId: worker.agent_id,
      prompt: "do work",
      agentToken: login.agent_token
    });

    expect(adapter.starts[0]?.agentToken).toBe(started.agent_token);
    expect(controller.requireAgentToken(started.agent_token).agent_id).toBe(worker.agent_id);
  });

  it("creates runs and registers agents", () => {
    const run = controller.createRun({ title: "test run", repoDir: "/repo" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      role: "implementer",
      backendHandle: { id: "attached-thread" },
      status: "running"
    });

    expect(agent.status).toBe("running");
    expect(agent.backend_handle?.id).toBe("attached-thread");
    expect(controller.listAgents({ runId: run.run_id })).toHaveLength(1);
  });

  it("starts an agent and records lifecycle events", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker"
    });

    const started = await controller.startAgent({ agentId: agent.agent_id, prompt: "do work" });
    const events = controller.listEvents({ runId: run.run_id });

    expect(started.status).toBe("running");
    expect(events.some((event) => event.type === "agent.started")).toBe(true);
  });

  it("does not fail a starting agent before its backend handle is stored", async () => {
    const run = controller.createRun({ title: "starting race run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "starting worker",
      status: "starting"
    });

    const refreshed = await controller.refreshAgentStatus(agent.agent_id);
    const events = controller.listEvents({ runId: run.run_id });

    expect(refreshed.status).toBe("starting");
    expect(events.some((event) => event.type === "agent.failed")).toBe(false);
  });

  it("marks an existing agent running when a follow-up message is delivered", async () => {
    const run = controller.createRun({ title: "follow-up run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "follow-up worker",
      backendHandle: { id: "attached-worker" },
      status: "completed"
    });

    const result = await controller.sendMessage(agent.agent_id, "continue");
    const events = controller.listEvents({ runId: run.run_id });

    expect(result.delivered).toBe(true);
    expect(result.agent.status).toBe("running");
    expect(controller.getAgent(agent.agent_id).status).toBe("running");
    expect(adapter.sent.at(-1)).toMatchObject({
      message: "continue"
    });
    expect(events.some((event) => event.type === "agent.message")).toBe(true);
  });

  it("does not emit repeated status changes when only missing failure reason normalization differs", async () => {
    const run = controller.createRun({ title: "stable status run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "stable worker",
      backendHandle: { id: "stable-worker" },
      status: "running"
    });

    await controller.refreshAgentStatus(agent.agent_id);
    await controller.refreshAgentStatus(agent.agent_id);
    const statusEvents = controller.listEvents({ runId: run.run_id }).filter((event) => event.type === "agent.status_changed");

    expect(statusEvents).toHaveLength(0);
  });

  it("runs a simple multi-step flow, selects a transition, and binds artifacts", () => {
    const run = controller.createRun({ title: "flow run", repoDir: "/repo" });
    const analyst = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Analyst",
      role: "analyst"
    });
    const smallWorker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Small worker",
      role: "small-worker"
    });
    const analysisPath = join(tmp, "analysis.md");
    const smallResultPath = join(tmp, "small-result.md");

    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "simple-task-router",
        description: "Route a task by size.",
        initial_step: "classify",
        artifacts: {
          analysis: { path: analysisPath, description: "Classifier handoff." },
          small_result: { path: smallResultPath, description: "Small worker result." }
        },
        steps: {
          classify: {
            agent_id: analyst.agent_id,
            role: "analyst",
            outputs: {
              analysis: { artifact: "analysis", required: true }
            },
            report: {
              schema: {
                required: ["size"],
                properties: {
                  size: { enum: ["s", "xl"] }
                }
              }
            },
            on: {
              reported: {
                transitions: [
                  {
                    id: "route-small",
                    when: { equals: { var: "result.size", value: "s" } },
                    to: "small_worker"
                  },
                  {
                    id: "route-large",
                    when: { equals: { var: "result.size", value: "xl" } },
                    notify: "orchestrator"
                  }
                ]
              }
            }
          },
          small_worker: {
            agent_id: smallWorker.agent_id,
            role: "small_worker",
            inputs: {
              analysis: { artifact: "analysis", required: true }
            },
            outputs: {
              small_result: { artifact: "small_result", required: true }
            },
            on: {
              reported: { finish: true }
            }
          }
        },
        roles: {
          analyst: {
            backend: "opencode-server",
            model: "custom/analyst"
          },
          small_worker: {
            backend: "codex-thread",
            model: "custom/small"
          }
        }
      }
    });

    expect(started.active_step?.step_id).toBe("classify");
    expect(started.active_step?.input_json.runtime_contract).toMatchObject({
      flow_id: "simple-task-router",
      flow_instance_id: started.instance.flow_instance_id,
      step_id: "classify",
      run: {
        run_id: run.run_id,
        title: "flow run",
        repo_dir: "/repo"
      },
      worker: {
        agent_id: analyst.agent_id,
        role: "analyst",
        backend: "opencode-server",
        model: "custom/analyst"
      },
      input_artifacts: {},
      output_artifacts: {
        analysis: {
          artifact: "analysis",
          description: "Classifier handoff.",
          required: true,
          path: analysisPath
        }
      }
    });
    expect(JSON.stringify(started.active_step?.input_json.runtime_contract)).toContain("Runtime Contract");
    expect(JSON.stringify(started.active_step?.input_json.runtime_contract)).toContain("Classifier handoff.");
    expect(JSON.stringify(started.active_step?.input_json.runtime_contract)).toContain("custom/analyst");
    expect(started.active_step?.input_json.output_artifacts).toMatchObject({
      analysis: {
        artifact: "analysis",
        description: "Classifier handoff.",
        required: true,
        path: analysisPath
      }
    });
    expect(started.active_step?.input_json.reporting_contract).toMatchObject({
      step_id: "classify",
      step_instance_id: started.active_step?.step_instance_id,
      mcp_tool: {
        name: "flow_step_report",
        input: {
          step_instance_id: started.active_step?.step_instance_id,
          status: "completed",
          result: { size: "s" },
          artifacts: { analysis: analysisPath }
        }
      },
      result_schema: {
        required: ["size"],
        properties: {
          size: { enum: ["s", "xl"] }
        }
      },
      artifact_example: { analysis: analysisPath }
    });
    expect(JSON.stringify(started.active_step?.input_json.reporting_contract)).toContain("agentctl flow report");
    expect(JSON.stringify(started.active_step?.input_json.reporting_contract)).toContain("Reporting Contract");

    const classifyStartedEvent = controller
      .listEvents({ runId: run.run_id, type: "flow.step_started" })
      .find((event) => event.payload.step_id === "classify");
    expect(classifyStartedEvent?.payload.runtime_contract).toEqual(
      started.active_step?.input_json.runtime_contract
    );
    expect(classifyStartedEvent?.payload.reporting_contract).toEqual(
      started.active_step?.input_json.reporting_contract
    );

    writeFileSync(analysisPath, "classified as small\n", "utf8");
    const routed = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { size: "s" },
      artifacts: { analysis: analysisPath },
      summary: "Classified as a small task."
    });

    expect(routed.instance.current_step_id).toBe("small_worker");
    expect(routed.selected_transition?.transition_id).toBe("route-small");
    expect(routed.active_step?.step_id).toBe("small_worker");
    expect(routed.active_step?.input_json).toMatchObject({ analysis: analysisPath });
    expect(routed.active_step?.input_json.input_artifacts).toMatchObject({
      analysis: {
        artifact: "analysis",
        description: "Classifier handoff.",
        required: true,
        path: analysisPath
      }
    });
    expect(routed.active_step?.input_json.runtime_contract).toMatchObject({
      worker: {
        agent_id: smallWorker.agent_id,
        role: "small_worker",
        backend: "codex-thread",
        model: "custom/small"
      }
    });
    expect(JSON.stringify(routed.active_step?.input_json.runtime_contract)).toContain("Input artifacts");
    expect(JSON.stringify(routed.active_step?.input_json.runtime_contract)).toContain(analysisPath);
    expect(routed.artifact_bindings).toMatchObject([{ artifact_key: "analysis", path: analysisPath }]);

    writeFileSync(smallResultPath, "small path done\n", "utf8");
    const completed = controller.reportFlowStep({
      stepInstanceId: routed.active_step!.step_instance_id,
      status: "completed",
      artifacts: { small_result: smallResultPath },
      summary: "Small path completed."
    });

    expect(completed.instance.status).toBe("completed");
    expect(completed.active_step).toBeNull();
    expect(completed.artifact_bindings.map((binding) => binding.artifact_key).sort()).toEqual([
      "analysis",
      "small_result"
    ]);
    expect(controller.listEvents({ runId: run.run_id }).map((event) => event.type)).toContain("flow.completed");

    const dashboard = controller.getDashboardSnapshot(run.run_id);
    expect(dashboard.flows.map((flow) => flow.flow_id)).toEqual(["simple-task-router"]);
    expect(dashboard.flow_instances).toHaveLength(1);
    expect(dashboard.flow_steps.map((step) => step.step_id)).toEqual(["classify", "small_worker"]);
    expect(dashboard.flow_reports).toHaveLength(2);
    expect(dashboard.flow_transitions.map((transition) => transition.transition_id)).toEqual([
      "route-small",
      "notify"
    ]);
    expect(dashboard.flow_artifact_bindings.map((binding) => binding.artifact_key).sort()).toEqual([
      "analysis",
      "small_result"
    ]);
  });

  it("reuses an active flow instance when start is called again for the same run and flow", () => {
    const run = controller.createRun({ title: "reused flow run", repoDir: "/repo" });
    const config = {
      id: "reused-flow",
      version: "1.0.0",
      initial_step: "first",
      steps: {
        first: {
          on: {
            reported: { finish: true }
          }
        }
      }
    };

    const first = controller.startFlow({ runId: run.run_id, config });
    const second = controller.startFlow({ runId: run.run_id, config });

    expect(second.reused).toBe(true);
    expect(second.instance.flow_instance_id).toBe(first.instance.flow_instance_id);
    expect(second.active_step?.step_instance_id).toBe(first.active_step?.step_instance_id);
    expect(store.listFlowInstances({ runId: run.run_id })).toHaveLength(1);
    expect(controller.listEvents({ runId: run.run_id, type: "flow.started" })).toHaveLength(1);
  });

  it("dispatches an active flow step using a subscriber agent without creating a temporary orchestrator", async () => {
    const run = controller.createRun({ title: "subscriber dispatch run", repoDir: "/repo" });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Flow orchestrator",
      role: "orchestrator"
    });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "subscriber-dispatch-flow",
        initial_step: "work",
        roles: {
          worker: {
            backend: "fake",
            model: "fake-model"
          }
        },
        steps: {
          work: {
            role: "worker",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const dispatched = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: orchestrator.agent_id
    });
    const agents = controller.listAgents({ runId: run.run_id });
    const links = controller.listAgentLinks({ runId: run.run_id });

    expect(dispatched.agent.role).toBe("worker");
    expect(agents.filter((agent) => agent.role === "orchestrator")).toHaveLength(1);
    expect(links).toMatchObject([
      {
        source_agent_id: orchestrator.agent_id,
        target_agent_id: dispatched.agent.agent_id,
        type: "parent_child",
        label: "worker"
      }
    ]);
  });

  it("pre-registers declarative flow agents and reuses their cards across clean step instances", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_planned_flow_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_planned_flow_test",
      title: "Planned role run",
      repoDir: "/repo",
      backend: "fake"
    });
    const config = {
      id: "planned-role-flow",
      initial_step: "work",
      roles: {
        worker: {
          backend: "fake",
          model: "fake-worker"
        },
        reviewer: {
          backend: "fake",
          model: "fake-reviewer"
        }
      },
      steps: {
        work: {
          role: "worker",
          report: {
            schema: {
              required: ["done"],
              properties: {
                done: { enum: [true] }
              }
            }
          },
          on: {
            reported: { to: "review" }
          }
        },
        review: {
          role: "reviewer",
          report: {
            schema: {
              required: ["verdict"],
              properties: {
                verdict: { enum: ["approved", "changes"] }
              }
            }
          },
          on: {
            reported: {
              transitions: [
                {
                  id: "needs-more-work",
                  when: { equals: { var: "result.verdict", value: "changes" } },
                  to: "work"
                },
                {
                  id: "approved",
                  when: { equals: { var: "result.verdict", value: "approved" } },
                  finish: true
                }
              ]
            }
          }
        }
      }
    };

    const started = controller.startFlow({
      runId: login.run.run_id,
      config,
      agentToken: login.agent_token
    });
    const plannedAgents = controller.listAgents({ runId: login.run.run_id });
    const worker = plannedAgents.find((agent) => agent.role === "worker");
    const reviewer = plannedAgents.find((agent) => agent.role === "reviewer");

    expect(worker).toMatchObject({
      title: "planned-role-flow: worker",
      status: "planned",
      model: "fake-worker"
    });
    expect(reviewer).toMatchObject({
      title: "planned-role-flow: reviewer",
      status: "planned",
      model: "fake-reviewer"
    });
    expect(controller.listAgentLinks({ runId: login.run.run_id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_agent_id: login.agent.agent_id,
          target_agent_id: worker?.agent_id,
          type: "parent_child",
          label: "worker"
        }),
        expect.objectContaining({
          source_agent_id: login.agent.agent_id,
          target_agent_id: reviewer?.agent_id,
          type: "parent_child",
          label: "reviewer"
        }),
        expect.objectContaining({
          source_agent_id: worker?.agent_id,
          target_agent_id: reviewer?.agent_id,
          type: "handoff",
          label: "reported"
        }),
        expect.objectContaining({
          source_agent_id: reviewer?.agent_id,
          target_agent_id: worker?.agent_id,
          type: "handoff",
          label: "needs-more-work"
        })
      ])
    );

    const firstWork = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(firstWork.agent.agent_id).toBe(worker?.agent_id);
    expect(firstWork.agent.status).toBe("running");
    expect(adapter.starts.at(-1)?.prompt).toContain(`- Worker agent: \`${worker?.agent_id}\``);

    const afterWork = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { done: true },
      summary: "Work completed."
    });
    const reviewDispatch = await controller.dispatchActiveFlowStep({
      flowInstanceId: afterWork.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(reviewDispatch.agent.agent_id).toBe(reviewer?.agent_id);

    const afterReview = controller.reportFlowStep({
      stepInstanceId: afterWork.active_step!.step_instance_id,
      status: "completed",
      result: { verdict: "changes" },
      summary: "Needs one clean retry."
    });
    const secondWork = await controller.dispatchActiveFlowStep({
      flowInstanceId: afterReview.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    const dashboard = controller.getDashboardSnapshot(login.run.run_id);

    expect(secondWork.agent.agent_id).toBe(worker?.agent_id);
    expect(dashboard.agents.filter((agent) => agent.role === "worker")).toHaveLength(1);
    expect(dashboard.flow_steps.filter((step) => step.agent_id === worker?.agent_id)).toHaveLength(2);
    expect(controller.listSubscriptions({ runId: login.run.run_id })).toHaveLength(10);
  });

  it("auto-continues reported flow steps without routing through an orchestrator", async () => {
    const run = controller.createRun({ title: "auto flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "auto-flow",
        initial_step: "work",
        roles: {
          worker: { backend: "fake" },
          reviewer: { backend: "fake" }
        },
        steps: {
          work: {
            role: "worker",
            report: {
              schema: {
                required: ["done"],
                properties: { done: { enum: [true] } }
              }
            },
            on: {
              reported: { to: "review" }
            }
          },
          review: {
            role: "reviewer",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const first = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });
    expect(first.action).toBe("dispatched");
    expect(first.agent?.role).toBe("worker");
    expect(controller.listSubscriptions({ runId: run.run_id })).toHaveLength(0);

    const reported = await controller.reportFlowStepAndContinue({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { done: true },
      summary: "Work done."
    });

    expect(reported.report.active_step?.step_id).toBe("review");
    expect(reported.continuation?.action).toBe("dispatched");
    expect(reported.continuation?.agent?.role).toBe("reviewer");
    expect(adapter.starts).toHaveLength(2);
  });

  it("auto-continues compactly from the MCP flow_step_report handler", async () => {
    const run = controller.createRun({ title: "tool auto flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "tool-auto-flow",
        initial_step: "work",
        roles: {
          worker: { backend: "fake" },
          reviewer: { backend: "fake" }
        },
        steps: {
          work: {
            role: "worker",
            report: {
              schema: {
                required: ["done"],
                properties: { done: { enum: [true] } }
              }
            },
            on: {
              reported: { to: "review" }
            }
          },
          review: {
            role: "reviewer",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });
    await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });

    const response = await handleTool(controller, "flow_step_report", {
      step_instance_id: started.active_step!.step_instance_id,
      status: "completed",
      result: { done: true },
      summary: "Tool report done."
    });

    expect(response).toMatchObject({
      flow_instance_id: started.instance.flow_instance_id,
      flow_status: "active",
      reported_step: {
        step_id: "work",
        status: "completed"
      },
      selected_transition: {
        target_step_id: "review"
      },
      continuation: {
        action: "dispatched",
        agent: {
          role: "reviewer",
          status: "running"
        }
      }
    });
    expect(JSON.stringify(response)).not.toContain("runtime_contract");
    expect(JSON.stringify(response)).not.toContain("tool-auto-flow: worker");
  });

  it("blocks a flow when a terminal worker never reports its step result", async () => {
    const run = controller.createRun({ title: "missing report flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "missing-report-flow",
        initial_step: "work",
        roles: {
          worker: { backend: "fake" }
        },
        steps: {
          work: {
            role: "worker",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const dispatched = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });
    expect(dispatched.action).toBe("dispatched");
    adapter.statuses.set(dispatched.agent!.agent_id, "completed");

    const blocked = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });

    expect(blocked.action).toBe("blocked");
    expect(blocked.blocked_reason).toBe("terminal_agent_missing_flow_report");
    expect(blocked.active_step?.status).toBe("blocked");
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).instance.status).toBe("blocked");
    expect(controller.listEvents({ runId: run.run_id }).map((event) => event.type)).toContain("flow.step_blocked");
  });

  it("includes flow blocker and notification instructions in subscription notifications", async () => {
    const run = controller.createRun({ title: "flow notification run", repoDir: "/repo" });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Orchestrator",
      role: "orchestrator"
    });
    await controller.startAgent({ agentId: subscriber.agent_id, prompt: "register visible thread" });
    controller.createSubscription({
      runId: run.run_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "flow.step_started"
    });

    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "notified-flow",
        initial_step: "first",
        steps: {
          first: {}
        }
      }
    });
    await controller.drainDeliveries();

    expect(adapter.sent.at(-1)?.message).toContain(`Flow instance: ${started.instance.flow_instance_id}`);
    expect(adapter.sent.at(-1)?.message).toContain(`Step instance: ${started.active_step?.step_instance_id}`);
    expect(adapter.sent.at(-1)?.message).toContain("do not call `flow_start` again");
    expect(adapter.sent.at(-1)?.message).toContain("Normal flow advancement is handled by Agent Control");
    expect(adapter.sent.at(-1)?.message).not.toContain("Preferred MCP call");
    expect(adapter.sent.at(-1)?.message).not.toContain("flow_dispatch_active");
  });

  it("delivers configured owner feedback when a flow finishes with notify", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_finish_notify_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_finish_notify_test",
      title: "Finish notification orchestrator",
      repoDir: "/repo",
      backend: "fake"
    });
    await controller.startAgent({ agentId: login.agent.agent_id, prompt: "register visible orchestrator" });
    const started = controller.startFlow({
      runId: login.run.run_id,
      agentToken: login.agent_token,
      config: {
        id: "finish-notify-flow",
        initial_step: "final_review",
        steps: {
          final_review: {
            on: {
              reported: {
                finish: true,
                notify: "orchestrator"
              }
            }
          }
        }
      }
    });

    const completed = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      summary: "Final answer is ready."
    });
    await controller.drainDeliveries();

    expect(completed.instance.status).toBe("completed");
    expect(completed.notification).toBe("orchestrator");
    expect(controller.listEvents({ runId: login.run.run_id }).map((event) => event.type)).toEqual(
      expect.arrayContaining(["flow.completed", "flow.notification"])
    );
    expect(adapter.sent.at(-1)?.message).toContain("flow.notification");
    expect(adapter.sent.at(-1)?.message).toContain("Status: completed");
    expect(adapter.sent.at(-1)?.message).toContain("Message: Final answer is ready.");
    expect(adapter.sent.at(-1)?.message).toContain("configured flow notification");
  });

  it("accepts markdown prompt references for roles and steps", () => {
    const run = controller.createRun({ title: "prompted flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "prompted-flow",
        initial_step: "analysis",
        prompts: {
          analyst_role: {
            path: "prompts/roles/analyst.md",
            description: "Stable analyst behavior."
          },
          analysis_step: {
            path: "prompts/steps/analysis.md",
            description: "Analysis step instructions."
          }
        },
        roles: {
          analyst: {
            prompt_ref: "analyst_role"
          }
        },
        steps: {
          analysis: {
            role: "analyst",
            prompt_ref: "analysis_step",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    expect(started.active_step?.input_json.prompt_sources).toEqual([
      {
        scope: "role",
        owner_id: "analyst",
        prompt_ref: "analyst_role",
        path: "prompts/roles/analyst.md",
        description: "Stable analyst behavior."
      },
      {
        scope: "step",
        owner_id: "analysis",
        prompt_ref: "analysis_step",
        path: "prompts/steps/analysis.md",
        description: "Analysis step instructions."
      }
    ]);

    const startedEvent = controller
      .listEvents({ runId: run.run_id, type: "flow.step_started" })
      .find((event) => event.payload.step_id === "analysis");
    expect(startedEvent?.payload.prompt_sources).toEqual(started.active_step?.input_json.prompt_sources);
  });

  it("rejects invalid prompt references and non-markdown prompt paths", () => {
    expect(() =>
      controller.validateFlowConfig({
        id: "missing-prompt-ref",
        initial_step: "analysis",
        steps: {
          analysis: {
            prompt_ref: "unknown_prompt"
          }
        }
      })
    ).toThrow(/undefined prompt/);

    expect(() =>
      controller.validateFlowConfig({
        id: "wrong-prompt-extension",
        initial_step: "analysis",
        prompts: {
          analysis_step: {
            path: "prompts/analysis.txt"
          }
        },
        steps: {
          analysis: {
            prompt_ref: "analysis_step"
          }
        }
      })
    ).toThrow(/Markdown/);
  });

  it("blocks a flow step when the result schema or required artifacts are invalid", () => {
    const run = controller.createRun({ title: "blocked flow run" });
    const reportPath = join(tmp, "report.md");
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "schema-gated-flow",
        initial_step: "classify",
        artifacts: {
          report: { path: reportPath }
        },
        steps: {
          classify: {
            outputs: {
              report: { artifact: "report", required: true }
            },
            report: {
              schema: {
                required: ["size"],
                properties: {
                  size: { enum: ["s", "xl"] }
                }
              }
            },
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const blocked = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { size: "m" },
      artifacts: { report: reportPath },
      summary: "Invalid size value."
    });

    expect(blocked.instance.status).toBe("blocked");
    expect(blocked.reported_step.status).toBe("blocked");
    expect(blocked.notification).toBe("blocked");
    expect(controller.listEvents({ runId: run.run_id }).map((event) => event.type)).toContain("flow.step_blocked");
  });

  it("lets an orchestrator manually start the next step after a notify action", () => {
    const run = controller.createRun({ title: "manual flow run" });
    const analysisPath = join(tmp, "manual-analysis.md");
    const planPath = join(tmp, "manual-plan.md");
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "orchestrator-driven-flow",
        initial_step: "analysis",
        artifacts: {
          analysis: { path: analysisPath },
          plan: { path: planPath }
        },
        steps: {
          analysis: {
            outputs: {
              analysis: { artifact: "analysis", required: true }
            },
            on: {
              reported: { notify: "orchestrator" }
            }
          },
          planning: {
            inputs: {
              analysis: { artifact: "analysis", required: true }
            },
            outputs: {
              plan: { artifact: "plan", required: true }
            },
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    writeFileSync(analysisPath, "analysis ready\n", "utf8");
    const waiting = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      artifacts: { analysis: analysisPath },
      summary: "Analysis ready for orchestrator routing."
    });

    expect(waiting.instance.status).toBe("waiting_for_orchestrator");
    expect(waiting.notification).toBe("orchestrator");

    const planning = controller.startFlowStep({
      flowInstanceId: waiting.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: waiting.reported_step.step_instance_id,
      transitionId: "manual-analysis-to-planning",
      reason: "orchestrator approved planning"
    });

    expect(planning.selected_transition?.transition_id).toBe("manual-analysis-to-planning");
    expect(planning.active_step?.step_id).toBe("planning");
    expect(planning.active_step?.input_json).toMatchObject({ analysis: analysisPath });
    expect(planning.instance.status).toBe("active");
  });

  it("records visual links, usage snapshots, and dashboard aggregates", () => {
    const run = controller.createRun({ title: "visual run", repoDir: "/repo" });
    const planner = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "planner",
      status: "completed"
    });
    const implementer = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "implementer",
      status: "running",
      model: "fake-model"
    });

    const link = controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: implementer.agent_id,
      targetAgentId: planner.agent_id,
      type: "waits_for",
      label: "implementation waits for plan"
    });
    const usage = controller.createUsageSnapshot({
      runId: run.run_id,
      agentId: implementer.agent_id,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      contextUsed: 200,
      contextLimit: 1000,
      source: "fake",
      model: "fake-model"
    });
    const snapshot = controller.getDashboardSnapshot(run.run_id);

    expect(link.type).toBe("waits_for");
    expect(usage.total_tokens).toBe(125);
    expect(snapshot.agent_links).toHaveLength(1);
    expect(snapshot.usage_totals.total_tokens).toBe(125);
    expect(snapshot.status_counts.running).toBe(1);
    expect(snapshot.computed_agents.find((agent) => agent.agent_id === implementer.agent_id)?.latest_usage?.usage_id).toBe(
      usage.usage_id
    );
  });

  it("freezes elapsed time for terminal agents at their last update", () => {
    const run = controller.createRun({ title: "terminal duration run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "completed worker",
      status: "completed"
    });
    const createdAt = "2026-06-11T10:00:00.000Z";
    const updatedAt = "2026-06-11T10:01:00.000Z";
    store.db
      .prepare("update agents set created_at = ?, updated_at = ? where agent_id = ?")
      .run(createdAt, updatedAt, agent.agent_id);

    const snapshot = controller.getDashboardSnapshot(run.run_id);
    const computed = snapshot.computed_agents.find((entry) => entry.agent_id === agent.agent_id);

    expect(computed?.is_terminal).toBe(true);
    expect(computed?.elapsed_ms).toBe(60_000);
  });

  it("does not fail queued or waiting agents that are only registered for visibility", async () => {
    const run = controller.createRun({ title: "visibility-only run" });
    const queued = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "future reviewer",
      status: "queued"
    });
    const waiting = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "coordinator",
      status: "waiting_for_input"
    });

    await controller.pollActiveAgents(run.run_id);

    expect(controller.getAgent(queued.agent_id).status).toBe("queued");
    expect(controller.getAgent(waiting.agent_id).status).toBe("waiting_for_input");
  });

  it("reads OpenCode latest output passively when the server is unavailable", async () => {
    const opencodeAdapter = new OpenCodeServerAdapter();
    const runtimeDir = join(tmp, "opencode-passive-read");
    mkdirSync(runtimeDir, { recursive: true });
    const logFile = join(runtimeDir, "opencode.log");
    writeFileSync(logFile, "last visible worker line\n", "utf8");

    const messages = await opencodeAdapter.readLatest(
      {
        backend: "opencode-server",
        id: "agent-opencode",
        data: {
          server: "http://localhost:1",
          model: "opencode-go/deepseek-v4-pro",
          title: "passive read",
          repoDir: "/repo",
          pidFile: join(runtimeDir, "opencode.pid"),
          logFile,
          exitFile: join(runtimeDir, "opencode-exit.json"),
          metadataFile: join(runtimeDir, "opencode-launch.json"),
          expectedArtifacts: []
        }
      },
      { limit: 5 }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.metadata?.source).toBe("opencode-log-tail");
    expect(messages[0]?.text).toContain("last visible worker line");
  });

  it("delivers completion events to subscribers", async () => {
    const run = controller.createRun({ title: "test run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      objective: "React to worker completion.",
      backendHandle: { id: "orchestrator-handle" },
      status: "completed"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    adapter.statuses.set("worker-handle", "completed");

    await controller.refreshAgentStatus(worker.agent_id);
    await controller.drainDeliveries();

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.message).toContain("Agent Control notification");
    expect(adapter.sent[0]?.message).toContain("agent.completed");
    expect(adapter.sent[0]?.message).toContain(`Source agent: worker (${worker.agent_id})`);
    expect(adapter.sent[0]?.message).toContain("Status: completed");
    expect(adapter.sent[0]?.message).toContain("React to worker completion.");
    expect(adapter.sent[0]?.message.trim().startsWith("{")).toBe(false);
    expect(controller.getAgent(orchestrator.agent_id).status).toBe("running");
  });

  it("delivers one message when duplicate subscriptions match the same subscriber event", async () => {
    const run = controller.createRun({ title: "duplicate subscription run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      objective: "React once.",
      backendHandle: { id: "orchestrator-handle" },
      status: "running"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    adapter.statuses.set("worker-handle", "completed");

    await controller.refreshAgentStatus(worker.agent_id);
    await controller.drainDeliveries();

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.message).toContain("agent.completed");
  });

  it("requires Codex thread subscribers to use native delivery for visible wakeups", async () => {
    const codexAdapter = new FakeAdapter("codex-thread");
    registry.register(codexAdapter);
    const run = controller.createRun({ title: "codex subscriber run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-thread",
      title: "orchestrator",
      objective: "Ask the user whether to continue.",
      backendHandle: { thread_id: "thread-visible", id: "thread-visible" },
      status: "waiting_for_input"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    adapter.statuses.set("worker-handle", "completed");

    await controller.refreshAgentStatus(worker.agent_id);
    await controller.drainDeliveries();

    expect(codexAdapter.sent).toHaveLength(1);
    expect(codexAdapter.sent[0]?.message).toContain("Codex Desktop visibility note");
    expect(codexAdapter.sent[0]?.message).toContain("Target Codex thread: thread-visible");
    expect(codexAdapter.sent[0]?.message).toContain("start with a short human-readable assistant update");
    expect(codexAdapter.sent[0]?.message).toContain("Do not try to force-refresh this same active turn");
    expect(codexAdapter.sent[0]?.message).not.toContain("codex_app.read_thread");
    expect(codexAdapter.sent[0]?.message).not.toContain("codex_app.send_message_to_thread");
  });

  it("sends compact goal confirmation prompts through the owning agent", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const goal = controller.createGoal({
      agentId: agent.agent_id,
      objective: "finish the phase"
    });

    const result = await controller.confirmGoal(goal.goal_id);

    expect(result.delivered).toBe(true);
    expect(adapter.sent[0]?.message).toContain("finish the phase");
    expect(buildGoalConfirmationPrompt("x")).toContain("complete");
  });

  it("adds the Codex native delivery reminder to goal confirmations for Codex threads", async () => {
    const codexAdapter = new FakeAdapter("codex-thread");
    registry.register(codexAdapter);
    const run = controller.createRun({ title: "codex goal run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-thread",
      title: "orchestrator",
      backendHandle: { thread_id: "thread-goal", id: "thread-goal" },
      status: "waiting_for_input"
    });
    const goal = controller.createGoal({
      agentId: agent.agent_id,
      objective: "supervise until final review is resolved"
    });

    await controller.confirmGoal(goal.goal_id);

    expect(codexAdapter.sent).toHaveLength(1);
    expect(codexAdapter.sent[0]?.message).toContain("supervise until final review is resolved");
    expect(codexAdapter.sent[0]?.message).toContain("Target Codex thread: thread-goal");
    expect(codexAdapter.sent[0]?.message).toContain("Codex Desktop visibility note");
  });

  it("does not create a heartbeat when registering a goal", () => {
    const run = controller.createRun({ title: "goal without heartbeat run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      backendHandle: { id: "orchestrator-handle" },
      status: "waiting_for_input"
    });

    controller.createGoal({
      agentId: agent.agent_id,
      objective: "supervise until complete"
    });

    const heartbeats = controller.listHeartbeats(agent.agent_id);
    expect(heartbeats).toHaveLength(0);
  });

  it("defers goal confirmation until active descendants are terminal", async () => {
    const run = controller.createRun({ title: "goal run" });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      backendHandle: { id: "orchestrator-handle" },
      status: "running"
    });
    const child = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "child worker",
      backendHandle: { id: "child-handle" },
      status: "running"
    });
    controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: orchestrator.agent_id,
      targetAgentId: child.agent_id,
      type: "parent_child"
    });
    const goal = controller.createGoal({
      agentId: orchestrator.agent_id,
      objective: "finish the orchestrated task"
    });

    const deferred = await controller.confirmGoal(goal.goal_id);

    expect(deferred.deferred).toBe(true);
    expect(deferred.delivered).toBe(false);
    expect(deferred.active_descendants.map((agent) => agent.agent_id)).toEqual([child.agent_id]);
    expect(adapter.sent).toHaveLength(0);

    adapter.statuses.set("child-handle", "completed");
    const confirmed = await controller.waitForGoalConfirmation(goal.goal_id, { intervalMs: 1, timeoutMs: 100 });

    expect(confirmed).toMatchObject({ timed_out: false, confirmed: true });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.handle.id).toBe("orchestrator-handle");
    expect(adapter.sent[0]?.message).toContain("finish the orchestrated task");
  });

  it("keeps stop and unregister as separate operations", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });

    const stopped = await controller.stopAgent(agent.agent_id);
    const unregistered = await controller.unregisterAgent(agent.agent_id);

    expect(stopped.status).toBe("stopped");
    expect(unregistered.unregistered_at).not.toBeNull();
    expect(controller.listAgents({ runId: run.run_id })).toHaveLength(0);
    expect(controller.listAgents({ runId: run.run_id, includeUnregistered: true })).toHaveLength(1);
  });

  it("purges one agent rows and controller-owned runtime files", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "stopped"
    });
    mkdirSync(agentRuntimePath(run.run_id, agent.agent_id), { recursive: true });
    controller.createHeartbeat({ agentId: agent.agent_id, idleTimeoutMs: 1_000 });
    controller.createGoal({ agentId: agent.agent_id, objective: "done" });
    controller.createArtifact({
      runId: run.run_id,
      agentId: agent.agent_id,
      label: "outside",
      path: join(tmp, "outside-artifact.md")
    });
    controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: agent.agent_id,
      targetAgentId: agent.agent_id,
      type: "parent_child"
    });
    controller.createUsageSnapshot({
      runId: run.run_id,
      agentId: agent.agent_id,
      totalTokens: 10
    });
    controller.createSubscription({
      sourceAgentId: agent.agent_id,
      subscriberAgentId: agent.agent_id,
      eventType: "agent.completed"
    });
    controller.startFlow({
      runId: run.run_id,
      config: {
        id: "agent-purge-flow",
        initial_step: "tracked_step",
        steps: {
          tracked_step: {
            agent_id: agent.agent_id,
            on: {
              reported: { notify: "orchestrator" }
            }
          }
        }
      }
    });
    await controller.unregisterAgent(agent.agent_id);

    const result = await controller.agentPurge(agent.agent_id);

    expect(result.purged_agents).toContain(agent.agent_id);
    expect(result.deleted_rows.agents).toBe(1);
    expect(result.deleted_rows.goals).toBe(1);
    expect(result.deleted_rows.heartbeats).toBe(1);
    expect(result.deleted_rows.artifacts).toBe(1);
    expect(result.deleted_rows.agent_links).toBe(1);
    expect(result.deleted_rows.usage_snapshots).toBe(1);
    expect(result.deleted_rows.subscriptions).toBe(1);
    expect(result.deleted_rows.flow_step_instances).toBe(1);
    expect(existsSync(agentRuntimePath(run.run_id, agent.agent_id))).toBe(false);
    expect(controller.listAgents({ runId: run.run_id, includeUnregistered: true })).toHaveLength(0);
    expect(store.listGoals(agent.agent_id)).toHaveLength(0);
  });

  it("purges one run rows and controller-owned runtime files", async () => {
    const run = controller.createRun({ title: "test run" });
    const first = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "first",
      status: "stopped"
    });
    const second = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "second",
      status: "completed"
    });
    mkdirSync(runRuntimePath(run.run_id), { recursive: true });
    controller.createHeartbeat({ agentId: first.agent_id, idleTimeoutMs: 1_000 });
    controller.createGoal({ agentId: second.agent_id, objective: "done" });
    controller.createArtifact({
      runId: run.run_id,
      agentId: first.agent_id,
      label: "report",
      path: join(tmp, "repo-report.md")
    });
    controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: first.agent_id,
      targetAgentId: second.agent_id,
      type: "handoff"
    });
    controller.createUsageSnapshot({
      runId: run.run_id,
      agentId: second.agent_id,
      totalTokens: 42
    });
    controller.startFlow({
      runId: run.run_id,
      config: {
        id: "run-purge-flow",
        initial_step: "visible_step",
        steps: {
          visible_step: {
            agent_id: first.agent_id,
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const result = await controller.runPurge(run.run_id);

    expect(result.purged_runs).toEqual([run.run_id]);
    expect(result.purged_agents.sort()).toEqual([first.agent_id, second.agent_id].sort());
    expect(result.deleted_rows.runs).toBe(1);
    expect(result.deleted_rows.agents).toBe(2);
    expect(result.deleted_rows.agent_links).toBe(1);
    expect(result.deleted_rows.usage_snapshots).toBe(1);
    expect(result.deleted_rows.flows).toBe(1);
    expect(result.deleted_rows.flow_instances).toBe(1);
    expect(result.deleted_rows.flow_step_instances).toBe(1);
    expect(existsSync(runRuntimePath(run.run_id))).toBe(false);
    expect(controller.listAgents({ runId: run.run_id, includeUnregistered: true })).toHaveLength(0);
    expect(() => controller.getRun(run.run_id)).toThrow(/Run not found/);
  });

  it("refuses to purge active agents unless forced", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });

    await expect(controller.agentPurge(agent.agent_id)).rejects.toThrow(/Refusing to purge/);

    const preview = await controller.agentPurge(agent.agent_id, { dryRun: true });
    expect(preview.deleted_rows.agents).toBe(1);

    const result = await controller.agentPurge(agent.agent_id, { force: true });
    expect(result.purged_agents).toEqual([agent.agent_id]);
  });

  it("refuses to purge when stop_first cannot stop an active agent", async () => {
    adapter.stopStatus = "stopping";
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });

    await expect(
      controller.runPurge(run.run_id, { stopFirst: true, force: true })
    ).rejects.toThrow(/stop_first did not stop/);
    expect(controller.getAgent(agent.agent_id).status).toBe("stopping");
  });

  it("does not deliver stop events while purging a run with stop_first", async () => {
    const run = controller.createRun({ title: "cleanup run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      status: "waiting_for_input",
      backendHandle: { id: "orchestrator-handle" }
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.stopped"
    });

    await controller.runPurge(run.run_id, { stopFirst: true, force: true });
    await controller.drainDeliveries();

    expect(adapter.sent).toHaveLength(0);
  });

  it("recovers OpenCode runtime handles before purge stop-first", async () => {
    const opencodeAdapter = new FakeAdapter("opencode-server");
    registry.register(opencodeAdapter);
    const run = controller.createRun({ title: "opencode run", repoDir: "/repo" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "opencode-server",
      title: "implementation",
      repoDir: "/repo",
      model: "opencode-go/deepseek-v4-pro",
      status: "running"
    });
    const runtimePath = agentRuntimePath(run.run_id, agent.agent_id);
    mkdirSync(runtimePath, { recursive: true });
    const pidFile = join(runtimePath, "opencode.pid");
    const logFile = join(runtimePath, "opencode.log");
    const metadataFile = join(runtimePath, "opencode-launch.json");
    writeFileSync(pidFile, "12345\n", "utf8");
    writeFileSync(
      metadataFile,
      JSON.stringify({
        server: "http://localhost:53910",
        model: "opencode-go/deepseek-v4-pro",
        title: "implementation",
        repoDir: "/repo",
        pidFile,
        logFile,
        expectedArtifacts: [join(tmp, "implementation-report.md")]
      }),
      "utf8"
    );

    const result = await controller.runPurge(run.run_id, { stopFirst: true });

    expect(opencodeAdapter.stopped).toHaveLength(1);
    expect(opencodeAdapter.stopped[0]?.data.pidFile).toBe(pidFile);
    expect(result.purged_runs).toEqual([run.run_id]);
    expect(existsSync(runRuntimePath(run.run_id))).toBe(false);
    expect(() => controller.getRun(run.run_id)).toThrow(/Run not found/);
  });

  it("requires explicit debug opt-in for MCP blocking waits", async () => {
    const run = controller.createRun({ title: "wait run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });

    await expect(
      handleTool(controller, "agent_wait", {
        agent_id: agent.agent_id,
        interval_ms: 1,
        timeout_ms: 1
      })
    ).rejects.toThrow(/Blocking waits are disabled/);
    await expect(
      handleTool(controller, "agent_wait", {
        agent_id: agent.agent_id,
        interval_ms: 1,
        timeout_ms: 1,
        allow_blocking_wait: true
      })
    ).resolves.toMatchObject({ timed_out: true });
  });

  it("dry-runs purge without deleting rows or runtime files", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "stopped"
    });
    mkdirSync(agentRuntimePath(run.run_id, agent.agent_id), { recursive: true });

    const result = await controller.agentPurge(agent.agent_id, { dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.deleted_rows.agents).toBe(1);
    expect(result.deleted_runtime_paths).toContain(agentRuntimePath(run.run_id, agent.agent_id));
    expect(existsSync(agentRuntimePath(run.run_id, agent.agent_id))).toBe(true);
    expect(controller.getAgent(agent.agent_id).agent_id).toBe(agent.agent_id);
  });

  it("purges old stopped runs and old unregistered agents only", async () => {
    const oldStoppedRun = controller.createRun({ title: "old stopped" });
    const oldStoppedAgent = controller.registerAgent({
      runId: oldStoppedRun.run_id,
      backend: "fake",
      title: "old stopped agent",
      status: "stopped"
    });
    const oldActiveRun = controller.createRun({ title: "old active" });
    const oldUnregisteredAgent = controller.registerAgent({
      runId: oldActiveRun.run_id,
      backend: "fake",
      title: "old unregistered agent",
      status: "stopped"
    });
    const freshRun = controller.createRun({ title: "fresh stopped" });
    const freshAgent = controller.registerAgent({
      runId: freshRun.run_id,
      backend: "fake",
      title: "fresh agent",
      status: "stopped"
    });
    await controller.unregisterAgent(oldUnregisteredAgent.agent_id);
    store.updateRunStatus(oldStoppedRun.run_id, "stopped");
    store.updateRunStatus(freshRun.run_id, "stopped");
    const oldIso = new Date(Date.now() - 10 * 86_400_000).toISOString();
    store.db.prepare("update runs set updated_at = ? where run_id = ?").run(oldIso, oldStoppedRun.run_id);
    store.db
      .prepare("update agents set unregistered_at = ?, updated_at = ? where agent_id = ?")
      .run(oldIso, oldIso, oldUnregisteredAgent.agent_id);

    const result = await controller.maintenancePurgeOld({
      olderThanMs: 7 * 86_400_000,
      dryRun: false,
      stopFirst: false,
      force: false,
      deleteRuntimeFiles: true
    });

    expect(result.purged_runs).toEqual([oldStoppedRun.run_id]);
    expect(result.purged_agents).toContain(oldStoppedAgent.agent_id);
    expect(result.purged_agents).toContain(oldUnregisteredAgent.agent_id);
    expect(controller.getRun(oldActiveRun.run_id).run_id).toBe(oldActiveRun.run_id);
    expect(controller.getRun(freshRun.run_id).run_id).toBe(freshRun.run_id);
    expect(controller.getAgent(freshAgent.agent_id).agent_id).toBe(freshAgent.agent_id);
  });

  it("refuses to delete runtime paths outside the controller runs root", async () => {
    const now = new Date().toISOString();
    store.db
      .prepare(
        "insert into runs (run_id, title, repo_dir, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run("..", "path traversal", null, "stopped", now, now);
    store.db
      .prepare(
        `insert into agents (
          agent_id, run_id, backend, title, role, objective, repo_dir, model,
          backend_handle_json, status, failure_reason, unregistered_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("agent_escape", "..", "fake", "escape", null, null, null, null, null, "stopped", null, null, now, now);

    const result = await controller.runPurge("..");

    expect(result.skipped_runtime_paths.some((path) => path.includes("outside controller runtime root"))).toBe(
      true
    );
  });
});
