import { describe, expect, it } from "vitest";
import { codexThreadActivity } from "../src/core/agent-activity.js";

describe("public agent activity", () => {
  it("shows the last public assistant line, never reasoning or user instructions", () => {
    expect(codexThreadActivity([{ status: "inProgress", startedAt: 100, items: [
      { type: "userMessage", text: "private user instructions" },
      { type: "agentMessage", text: "First line\nLast public update" },
      { type: "reasoning", text: "hidden reasoning" }
    ] }])).toEqual({ kind: "message", text: "Last public update", observed_at: new Date(100000).toISOString() });
  });
  it("uses only an explicitly in-progress known tool without its arguments or output", () => {
    expect(codexThreadActivity([{ status: "inProgress", items: [
      { type: "agentMessage", text: "Starting checks" },
      { type: "commandExecution", status: "inProgress", text: "secret command output" }
    ] }])).toEqual({ kind: "tool", text: "Run a command", state: "running" });
  });
  it("retains a last tool without inventing an active state and ignores unknown items", () => {
    expect(codexThreadActivity([{ status: "completed", items: [{ type: "commandExecution", status: "inProgress" }] }])).toEqual({ kind: "tool", text: "Run a command" });
    expect(codexThreadActivity([{ status: "inProgress", items: [{ type: "unknownTool", status: "inProgress" }] }])).toBeNull();
  });
  it("retains the latest completed tool and preserves a later assistant message", () => {
    const items = [{ type: "agentMessage", text: "Earlier message" }, { type: "commandExecution", status: "completed", command: "pnpm test --token very-secret" }];
    expect(codexThreadActivity([{ status: "completed", items }])).toEqual({ kind: "tool", text: "Run tests", state: "completed" });
    items.push({ type: "agentMessage", text: "Later public update" });
    expect(codexThreadActivity([{ status: "completed", items }])).toEqual({ kind: "message", text: "Later public update" });
  });
  it("timestamps tools using their source turn rather than the polling clock", () => {
    const value = codexThreadActivity([{ status: "inProgress", startedAt: 123, items: [{ type: "mcpToolCall", tool: "search", status: "inProgress" }] }]);
    expect(value).toMatchObject({ kind: "tool", text: "search", state: "running", observed_at: new Date(123000).toISOString() });
  });
  it("clears the preceding turn's output when a new turn has no public activity", () => {
    expect(codexThreadActivity([{ status: "completed", items: [{ type: "agentMessage", text: "Old task" }] },
      { status: "inProgress", items: [{ type: "reasoning", text: "Private" }] }])).toBeNull();
  });
});
