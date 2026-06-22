import { describe, expect, it } from "vitest";
import { ManualAdapter } from "../src/adapters/manual-adapter.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";

describe("ManualAdapter", () => {
  it("advertises explicit non-execution capabilities", () => {
    const adapter = new ManualAdapter();

    expect(adapter.capabilities()).toEqual({
      canStart: false,
      canSendMessage: false,
      canReadLatest: true,
      canStopGracefully: true,
      canForceStop: false,
      canStreamMessages: false,
      canInspectStatusCheaply: true,
      canAttachExisting: true
    });
  });

  it("refuses to start a manual participant without an attached handle", async () => {
    const adapter = new ManualAdapter();

    await expect(
      adapter.start({
        agent: {
          agent_id: "agent_manual",
          run_id: "run_manual",
          backend: "manual",
          title: "Manual participant",
          role: null,
          objective: null,
          repo_dir: null,
          model: null,
          backend_handle: null,
          status: "queued",
          failure_reason: null,
          token_hash: null,
          unregistered_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      })
    ).rejects.toMatchObject({ reason: "unsupported_operation" });
  });

  it("reads status and latest messages from an attached handle", async () => {
    const adapter = new ManualAdapter();
    const handle = {
      backend: "manual",
      id: "manual-demo",
      data: {
        id: "manual-demo",
        status: "completed",
        message: "Manual demo finished.",
        messages: [
          { id: "m1", role: "assistant", text: "First", created_at: "2026-06-13T00:00:00.000Z" },
          { id: "m2", role: "assistant", text: "Second", created_at: "2026-06-13T00:00:01.000Z" }
        ]
      }
    };

    await expect(adapter.getStatus(handle)).resolves.toMatchObject({
      status: "completed",
      message: "Manual demo finished."
    });
    await expect(adapter.readLatest(handle, { limit: 1 })).resolves.toEqual([
      { id: "m2", role: "assistant", text: "Second", created_at: "2026-06-13T00:00:01.000Z" }
    ]);
  });

  it("is available in the default adapter registry", () => {
    const backends = createDefaultAdapterRegistry().list().map((backend) => backend.kind);

    expect(backends).toContain("manual");
  });
});
