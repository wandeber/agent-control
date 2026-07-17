export interface WorkspaceRefreshPolicy {
  messagesEnabled: boolean;
  messagesRefetchInterval: number | false;
  logEnabled: boolean;
  logRefetchInterval: number | false;
}

export const INITIAL_AGENT_MESSAGE_LIMIT = 48;
export const AGENT_MESSAGE_LOAD_STEP = 48;
export const MAX_AGENT_MESSAGE_LIMIT = 1000;

/** Query keys are shared by the coordinator writer and disabled MCP readers. */
export function agentMessagesQueryKey(agentId: string | null, limit: number) {
  return ["messages", agentId, limit] as const;
}

export function agentLogQueryKey(agentId: string | null) {
  return ["log", agentId] as const;
}

/**
 * Keeps the browser fallback's independent queries while making the MCP App
 * use a single owner for every periodic tool read. In MCP mode the snapshot
 * coordinator writes messages/logs into the matching query-cache entries, so
 * these queries must stay disabled: an older independent promise could
 * otherwise overwrite a newer coordinator generation after an agent switch.
 */
export function workspaceRefreshPolicy(input: {
  mcpMode: boolean;
  hasAgent: boolean;
  hasLiveLog: boolean;
}): WorkspaceRefreshPolicy {
  if (input.mcpMode) {
    return {
      messagesEnabled: false,
      messagesRefetchInterval: false,
      logEnabled: false,
      logRefetchInterval: false
    };
  }

  return {
    messagesEnabled: input.hasAgent,
    messagesRefetchInterval: input.hasAgent ? 6000 : false,
    logEnabled: input.hasAgent,
    logRefetchInterval: input.hasAgent && !input.hasLiveLog ? 4500 : false
  };
}
