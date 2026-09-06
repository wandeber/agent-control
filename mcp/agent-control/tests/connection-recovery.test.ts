import { describe, expect, it, vi } from "vitest";
import { ConnectionRecovery, connectWithStartup } from "../src/adapters/connection-recovery.js";

describe("connection recovery", () => {
  it("suppresses repeated failures until cooldown and recovers on later demand", async () => {
    let now = 0;
    const recovery = new ConnectionRecovery(30_000, () => now);
    const connect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await expect(recovery.connect("endpoint", connect)).rejects.toThrow("offline");
    await expect(recovery.connect("endpoint", connect)).rejects.toMatchObject({reason: "backend_unavailable"});
    expect(connect).toHaveBeenCalledTimes(1);
    now = 30_001;
    await recovery.connect("endpoint", connect);
    await recovery.connect("endpoint", connect);
    expect(connect).toHaveBeenCalledTimes(3);
  });
  it("does not suppress a healthy unrelated endpoint", async () => {
    const recovery = new ConnectionRecovery();
    await expect(recovery.connect("bad", async () => { throw new Error("offline"); })).rejects.toThrow();
    const healthy = vi.fn(async () => undefined);
    await recovery.connect("good", healthy);
    expect(healthy).toHaveBeenCalledOnce();
  });
  it("starts managed listener once and waits for readiness without dispatching work", async () => {
    const start = vi.fn(async () => undefined);
    const connect = vi.fn().mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(undefined);
    const wait = vi.fn(async () => undefined);
    await connectWithStartup(connect, start, wait);
    expect(start).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });
  it("bounds unsuccessful readiness attempts", async () => {
    const connect = vi.fn(async () => { throw new Error("offline"); });
    await expect(connectWithStartup(connect, async () => undefined, async () => undefined)).rejects.toThrow("offline");
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
