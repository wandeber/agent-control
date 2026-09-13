import { describe, expect, it, vi } from "vitest";
import { AgentDefinitionSaveQueue, flushDeferredAgentSaves, saveDefinitionUpdate } from "./agent-definition-save-queue";
import { inheritAgentCapabilities, type AgentDefinition, type AgentDefinitionConfigureResult } from "./agent-definitions";

describe("AgentDefinitionSaveQueue", () => {
  it("serializes saves and coalesces edits made while a save is in flight", async () => {
    const first = deferred<AgentDefinitionConfigureResult>();
    const second = deferred<AgentDefinitionConfigureResult>();
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const saved = vi.fn();
    const queue = new AgentDefinitionSaveQueue("rev-1", {
      save,
      onSaved: saved,
      onError: vi.fn(),
      onStateChange: vi.fn()
    });

    queue.enqueue(definition("First"));
    queue.enqueue(definition("Latest"));
    const idle = queue.whenIdle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].name).toBe("First");
    expect(save.mock.calls[0]?.[1]).toBe("rev-1");

    first.resolve(result("rev-2", "First"));
    await tick();
    expect(saved.mock.calls[0]?.[1]).toEqual(new Set(["definition-1"]));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].name).toBe("Latest");
    expect(save.mock.calls[1]?.[1]).toBe("rev-2");

    second.resolve(result("rev-3", "Latest"));
    await idle;
    expect(queue.busy).toBe(false);
  });

  it.each([false, true])("flushes the newest capability snapshot without metadata (return to inherit: %s)", async returnToInheritance => {
    const first = deferred<AgentDefinitionConfigureResult>();
    const requests: ReturnType<typeof saveDefinitionUpdate>[] = [];
    const queue = new AgentDefinitionSaveQueue("rev-1", {
      save: async (draft, revision) => {
        requests.push(saveDefinitionUpdate(draft, revision));
        if (requests.length === 1) return first.promise;
        return { revision: "rev-3", definition: draft, agents: [draft] };
      },
      onSaved: vi.fn(), onError: vi.fn(), onStateChange: vi.fn()
    });
    const inherited = { ...inheritAgentCapabilities(definition("Included")), bundled_key: "research", customized: false };
    const custom: AgentDefinition = {
      ...inherited, capabilities_mode: "custom",
      plugins: [{ id: "second", enabled: false }, { id: "first", enabled: true }],
      skills: [{ path: "skill.md", enabled: true }], mcp_servers: [{ name: "mcp", enabled: true }]
    };
    queue.enqueue(inherited);
    queue.enqueue(custom);
    const latest = { ...(returnToInheritance ? inheritAgentCapabilities(custom) : custom), instructions: "Typed before navigating away" };
    const timers = new Map([[latest.definition_id, setTimeout(() => { throw new Error("Timer should have been flushed"); }, 420)]]);
    flushDeferredAgentSaves(timers, () => latest, draft => queue.enqueue(draft));
    const idle = queue.whenIdle();
    first.resolve({ revision: "rev-2", definition: inherited, agents: [inherited] });
    await idle;
    expect(requests).toHaveLength(2);
    expect(requests[1]?.expected_revision).toBe("rev-2");
    expect(requests[1]?.patch).toMatchObject({
      capabilities_mode: returnToInheritance ? "inherit" : "custom",
      instructions: latest.instructions, plugins: latest.plugins, skills: latest.skills, mcp_servers: latest.mcp_servers
    });
    expect(requests[1]?.patch).not.toHaveProperty("bundled_key");
    expect(requests[1]?.patch).not.toHaveProperty("customized");
    expect(timers.size).toBe(0);
  });

  it("pauses after an error and retries the newest preserved draft after rebasing", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("stale revision conflict"))
      .mockResolvedValueOnce(result("rev-4", "Latest"));
    const onError = vi.fn();
    const queue = new AgentDefinitionSaveQueue("rev-1", {
      save,
      onSaved: vi.fn(),
      onError,
      onStateChange: vi.fn()
    });

    queue.enqueue(definition("First"), 0);
    queue.enqueue(definition("Latest"));
    const failedIdle = queue.whenIdle();
    await expect(failedIdle).rejects.toThrow("stale revision conflict");
    await tick();
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.pendingDrafts().get("definition-1")?.name).toBe("Latest");
    expect(save).toHaveBeenCalledTimes(1);

    queue.rebase("rev-3");
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].name).toBe("Latest");
    expect(save.mock.calls[1]?.[1]).toBe("rev-3");
    expect(save.mock.calls[1]?.[2]).toBe(0);
  });

  it("moves debounced edits into the save queue before their screen unmounts", () => {
    vi.useFakeTimers();
    try {
      const timerCallback = vi.fn();
      const timers = new Map([["definition-1", setTimeout(timerCallback, 420)]]);
      const latest = definition("Latest text before navigation");
      const enqueue = vi.fn();

      flushDeferredAgentSaves(
        timers,
        definitionId => definitionId === latest.definition_id ? latest : undefined,
        enqueue
      );

      expect(timers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledWith(latest);
      vi.runAllTimers();
      expect(timerCallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function definition(name: string): AgentDefinition {
  return {
    definition_id: "definition-1",
    name,
    description: "",
    instructions: "",
    model: "model-1",
    model_provider: "provider-1",
    reasoning_effort: "medium",
    plugins: [],
    skills: [],
    mcp_servers: [],
    created_at: "2026-09-12T10:00:00Z",
    updated_at: "2026-09-12T10:00:00Z"
  };
}

function result(revision: string, name: string): AgentDefinitionConfigureResult {
  return { revision, definition: definition(name), agents: [definition(name)] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise(resolve => setTimeout(resolve, 0));
}
