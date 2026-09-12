import { describe, it, expect } from "vitest";
import { mergeToolMessages, permissionsForTool, readToolActivity } from "./tool-activity";
import type { AgentMessage, PermissionRequest } from "./types";
const message = (id: string, turn: string, tool: Record<string, unknown>): AgentMessage => ({ id, role: "tool", text: "tool", created_at: "2026-09-11", metadata: { turnId: turn, tool_activity: { call_id: "same-call", name: "exec_command", ...tool } } });
describe("structured tool transcript", () => {
  it("combines input and result in place while preserving independent turns", () => {
    const rows = mergeToolMessages([message("1", "first", { status: "running", command: "printf ok" }), message("2", "first", { status: "completed", name: "Tool result", output: "ok", exit_code: 0 }), message("3", "second", { status: "running", command: "printf next" })]);
    expect(rows).toHaveLength(2);
    expect(readToolActivity(rows[0].metadata)).toMatchObject({ name: "exec_command", command: "printf ok", output: "ok", status: "completed", exit_code: 0 });
    expect(readToolActivity(rows[1].metadata)).toMatchObject({ command: "printf next", status: "running" });
  });
  it("does not invent completion or confuse separate calls", () => {
    const rows = mergeToolMessages([message("1", "first", { status: "futureStatus" }), message("2", "first", { call_id: "another", status: "failed", error: "Failed" })]);
    expect(rows).toHaveLength(2); expect(readToolActivity(rows[0].metadata)?.status).toBe("unknown");
    expect(readToolActivity(rows[1].metadata)?.status).toBe("failed");
  });
  it("places a permission only on its native thread, turn and item", () => {
    const request = { request_id: "permission", thread_id: "thread", turn_id: "turn", item_id: "item" } as PermissionRequest;
    const activity = { tool_activity: { call_id: "item", name: "commandExecution", command: "same command" }, threadId: "thread", turnId: "turn" };
    expect(permissionsForTool(activity, [request])).toEqual([request]);
    expect(permissionsForTool({ ...activity, threadId: "other-thread" }, [request])).toEqual([]);
    expect(permissionsForTool({ ...activity, turnId: "other-turn" }, [request])).toEqual([]);
    expect(permissionsForTool({ tool_activity: activity.tool_activity }, [request])).toEqual([]);
    const cli = { ...activity, threadId: undefined, turnId: "2:3", tool_activity: { ...activity.tool_activity, call_id: "2:3:item" }, approval_identity: { thread_id: "thread", turn_id: "turn", item_id: "item" } };
    expect(permissionsForTool(cli, [request])).toEqual([request]);
    expect(permissionsForTool({ ...cli, approval_identity: { ...cli.approval_identity, item_id: "other" } }, [request])).toEqual([]);
  });
});
