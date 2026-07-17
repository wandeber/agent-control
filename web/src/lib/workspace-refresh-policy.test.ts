import { describe, expect, it } from "vitest";
import { agentMessagesQueryKey, workspaceRefreshPolicy } from "./workspace-refresh-policy";

describe("workspaceRefreshPolicy", () => {
  it("disables both independent queries in MCP App mode", () => {
    expect(workspaceRefreshPolicy({ mcpMode: true, hasAgent: true, hasLiveLog: false })).toEqual({
      messagesEnabled: false,
      messagesRefetchInterval: false,
      logEnabled: false,
      logRefetchInterval: false
    });
  });

  it("preserves browser polling and suppresses only the redundant live-log query", () => {
    expect(workspaceRefreshPolicy({ mcpMode: false, hasAgent: true, hasLiveLog: false })).toEqual({
      messagesEnabled: true,
      messagesRefetchInterval: 6000,
      logEnabled: true,
      logRefetchInterval: 4500
    });
    expect(workspaceRefreshPolicy({ mcpMode: false, hasAgent: true, hasLiveLog: true })).toEqual({
      messagesEnabled: true,
      messagesRefetchInterval: 6000,
      logEnabled: true,
      logRefetchInterval: false
    });
  });

  it("keeps each requested history generation on a distinct cache key", () => {
    expect(agentMessagesQueryKey("agent-1", 48)).not.toEqual(agentMessagesQueryKey("agent-1", 96));
  });
});
