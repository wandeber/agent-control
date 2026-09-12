import { describe, expect, it, vi } from "vitest";
import { McpConsoleNotificationStore } from "./mcp-app";
import type { DashboardSnapshot } from "./types";

describe("McpConsoleNotificationStore", () => {
  it("retains flow selection without a dashboard or a run", () => {
    const store = new McpConsoleNotificationStore();
    store.applyToolResult({ structuredContent: { console: { panel_id: "flow-panel", screen: "flows", flow_id: "draft", repo_dir: "/project" } } });
    expect(store.current().snapshot).toBeNull();
    expect(store.current().console).toMatchObject({ screen: "flows", flow_id: "draft", repo_dir: "/project" });
    store.applyToolResult({ structuredContent: { console: { panel_id: "flow-panel", screen: "flows", flow_id: "new", repo_dir: "/project", command_id: "new-selection", action: "reuse" } } });
    expect(store.current().console?.flow_id).toBe("new");
  });

  it("retains the opener id across input notifications and ignores late results from retired panels", () => {
    const store = new McpConsoleNotificationStore();
    const result = (panel_id: string, action?: string) => ({ structuredContent: {
      snapshot: dashboardSnapshot(panel_id), console: { panel_id, requested_run_id: null, follow_latest: true, ...(action ? { action, command_id: "late-command" } : {}) }
    } });
    store.applyToolResult(result("first"));
    store.applyToolInput({ arguments: { run_id: "selected" } });
    expect(store.current().console?.panel_id).toBe("first");
    store.applyToolResult(result("second"));
    store.applyToolResult(result("first", "close"));
    expect(store.current().console?.panel_id).toBe("second");
    expect(store.current().console?.action).toBeUndefined();
    expect(store.current().snapshot?.selected_run_id).toBe("second");
  });
  it("rejects notifications from any source other than the parent host", () => {
    const host = {} as MessageEventSource;
    const foreign = {} as MessageEventSource;
    const store = new McpConsoleNotificationStore();

    const consumed = store.consume(
      {
        source: foreign,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { run_id: "foreign-run" } }
        }
      },
      host
    );

    expect(consumed).toBe(false);
    expect(store.current()).toEqual({ snapshot: null, console: null });
  });

  it("processes id-less tool input/result notifications and replays them to late subscribers", () => {
    const host = {} as MessageEventSource;
    const store = new McpConsoleNotificationStore();
    const snapshot = dashboardSnapshot("run-42");

    expect(
      store.consume(
        {
          source: host,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { run_id: "run-42" } }
          }
        },
        host
      )
    ).toBe(true);
    expect(
      store.consume(
        {
          source: host,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              structuredContent: {
                snapshot,
                console: { requested_run_id: "run-42", follow_latest: false }
              }
            }
          }
        },
        host
      )
    ).toBe(true);

    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      snapshot,
      console: { requested_run_id: "run-42", follow_latest: false }
    });
  });

  it("replays a close command without treating it as a run selection", () => {
    const host = {} as MessageEventSource;
    const store = new McpConsoleNotificationStore();

    expect(
      store.consume(
        {
          source: host,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              structuredContent: {
                console: {
                  requested_run_id: null,
                  follow_latest: false,
                  action: "close",
                  command_id: "console-command-7"
                }
              }
            }
          }
        },
        host
      )
    ).toBe(true);

    expect(store.current()).toEqual({
      snapshot: null,
      console: {
        requested_run_id: null,
        follow_latest: false,
        action: "close",
        command_id: "console-command-7"
      }
    });
  });

  it("ignores app-only snapshot acknowledgements as selection input", () => {
    const host = {} as MessageEventSource;
    const store = new McpConsoleNotificationStore();

    expect(
      store.consume(
        {
          source: host,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { command_id: "console-command-8" } }
          }
        },
        host
      )
    ).toBe(true);

    expect(store.current()).toEqual({ snapshot: null, console: null });
  });
});

function dashboardSnapshot(runId: string): DashboardSnapshot {
  return {
    generated_at: "2026-07-15T12:00:00.000Z",
    selected_run_id: runId,
    runs: [],
    agents: [],
    agent_links: [],
    flows: [],
    flow_instances: [],
    flow_steps: [],
    flow_reports: [],
    flow_transitions: [],
    flow_artifact_bindings: [],
    subscriptions: [],
    heartbeats: [],
    goals: [],
    artifacts: [],
    latest_events: [],
    computed_agents: [],
    status_counts: {
      planned: 0,
      queued: 0,
      starting: 0,
      running: 0,
      waiting_for_input: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      stopping: 0,
      stopped: 0,
      unknown: 0
    },
    usage_totals: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      context_used: null,
      context_limit: null
    }
  };
}
