import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerAgentDefinitionCommands } from "../src/cli/agent-definitions.js";
import type { CliDeps } from "../src/cli/shared.js";

const launch = vi.hoisted(() => vi.fn().mockResolvedValue({ state: "running" }));
vi.mock("../src/agent-definitions.js", () => ({ AgentDefinitionService: class { launch = launch; } }));
beforeEach(() => launch.mockClear());

it.each([
  { flags: [], events: undefined },
  { flags: ["--requester-event", "agent.completed"], events: ["agent.completed"] },
  { flags: ["--requester-event", "agent.completed", "--requester-event", "agent.failed"], events: ["agent.completed", "agent.failed"] }
])("preserves CLI subscription defaults and explicit filters: $flags", async ({ flags, events }) => {
  const command = new Command();
  registerAgentDefinitionCommands(command, { controller: {}, output: vi.fn(), authOptions: () => ({}) } as unknown as CliDeps);
  await command.parseAsync(["agent-definition", "launch", "--name", "Mechanical Validator", "--repo-dir", "/fixture", "--prompt", "Bounded smoke", ...flags], { from: "user" });
  expect(launch).toHaveBeenCalledOnce();
  expect(launch.mock.calls[0]![0]).toMatchObject({ name: "Mechanical Validator", requester_event_types: events });
});
