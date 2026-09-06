import { expect, it, vi } from "vitest";
import { AgentDetailReader } from "./agent-detail-reader";

it("isolates disconnected workers, bounds retries, and clears warnings after recovery", async () => {
  let now = 0;
  const reader = new AgentDetailReader<string[], string>(() => now);
  const messages = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(["saved thread"]);
  const log = vi.fn(async () => "log");
  expect(await reader.read("bad", messages, log)).toMatchObject({messages: null, agentError: new Error("offline")});
  await reader.read("bad", messages, log);
  expect(messages).toHaveBeenCalledOnce();
  expect(await reader.read("good", async () => ["healthy"], log)).toEqual({messages: ["healthy"], log: "log"});
  now = 30_001;
  expect(await reader.read("bad", messages, log)).toEqual({messages: ["saved thread"], log: "log"});
});

it("retains successful messages when logs fail, and local logs when messages fail", async () => {
  const reader = new AgentDetailReader<string[], string>();
  const fail = async (): Promise<never> => { throw new Error("offline"); };
  expect(await reader.read("a", async () => ["history"], fail)).toMatchObject({messages: ["history"], log: null});
  expect(await reader.read("b", fail, async () => "local log")).toMatchObject({messages: null, log: "local log"});
});
