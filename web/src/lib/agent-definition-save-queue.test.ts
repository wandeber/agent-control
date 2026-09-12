import { describe, expect, it, vi } from "vitest";
import { AgentDefinitionSaveQueue, flushDeferredAgentSaves } from "./agent-definition-save-queue";
import type { AgentDefinition, AgentDefinitionConfigureResult } from "./agent-definitions";

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
