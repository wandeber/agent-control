import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexSessionAdapter, readCodexSession } from "../src/adapters/codex-session.js";
import Database from "../src/storage/database.js";

vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), watch: vi.fn(() => Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() })) };
});
const thread = "11111111-1111-4111-8111-111111111111";
const handle = { backend: "codex-session", id: thread, data: { thread_id: thread } };
let home: string, path: string, unwatch: (() => void) | undefined;
const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + "\n";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-session-idle-")); vi.stubEnv("CODEX_HOME", home); vi.stubEnv("AGENT_CONTROL_HOME", home);
  mkdirSync(join(home, "sessions")); path = join(home, "sessions", `rollout-${thread}.jsonl`);
  writeFileSync(path, row("session_meta", { id: thread }) + row("event_msg", { type: "task_complete", turn_id: "old" }));
  vi.useFakeTimers(); vi.clearAllMocks();
});
afterEach(() => { unwatch?.(); unwatch = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
it("backs off unchanged sessions and delivers every event promptly after a file notification", async () => {
  const adapter = new CodexSessionAdapter(), inspect = vi.spyOn(adapter, "getStatus"), changed = vi.fn();
  unwatch = adapter.watchStatus(handle, changed);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(inspect.mock.calls.length).toBeLessThanOrEqual(10); expect(changed).toHaveBeenCalledTimes(1);
  appendFileSync(path, row("event_msg", { type: "task_started", turn_id: "new" }) + row("event_msg", { type: "task_complete", turn_id: "new" }));
  const notify = vi.mocked(watch).mock.calls[0][1] as () => void; notify();
  await vi.advanceTimersByTimeAsync(50);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed.mock.calls[1][0].data.observed_events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "agent.started", turn_id: "new" }), expect.objectContaining({ type: "agent.completed", turn_id: "new" })
  ]));
  const watcher = vi.mocked(watch).mock.results[0].value;
  unwatch(); await vi.advanceTimersByTimeAsync(60_000);
  expect(watcher.close).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(2);
});
it("does not overlap slow status reads or invoke a callback after cancellation", async () => {
  const adapter = new CodexSessionAdapter(), changed = vi.fn(); let release!: (value: { status: "completed" }) => void;
  const inspect = vi.spyOn(adapter, "getStatus").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  unwatch = adapter.watchStatus(handle, changed);
  await vi.advanceTimersByTimeAsync(60_000); expect(inspect).toHaveBeenCalledTimes(1);
  unwatch(); release({ status: "completed" }); await vi.advanceTimersByTimeAsync(60_000);
  expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("bounds refresh frequency without starving notifications during continuous writes", async () => {
  const adapter = new CodexSessionAdapter(), inspect = vi.spyOn(adapter, "getStatus"), changed = vi.fn();
  unwatch = adapter.watchStatus(handle, changed); await vi.advanceTimersByTimeAsync(1_000);
  const notify = vi.mocked(watch).mock.calls[0][1] as () => void;
  for (let i = 0; i < 100; i++) {
    appendFileSync(path, row("event_msg", { type: "task_started", turn_id: `stream-${i}` }));
    notify(); await vi.advanceTimersByTimeAsync(20);
  }
  expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(inspect.mock.calls.length).toBeLessThanOrEqual(4);
  expect(changed.mock.calls.at(-1)?.[0].data.observed_events).toEqual(expect.arrayContaining([
    expect.objectContaining({ turn_id: "stream-99" })
  ]));
});
it("bounds missing-session tree scans and discovers a restored session on retry", async () => {
  const missing = "22222222-2222-4222-8222-222222222222";
  expect(readCodexSession(missing)).toBeNull();
  vi.mocked(readdirSync).mockClear();
  for (let i = 0; i < 44; i++) expect(readCodexSession(missing)).toBeNull();
  expect(vi.mocked(readdirSync).mock.calls.every(([dir]) => dir === home)).toBe(true);
  writeFileSync(join(home, "sessions", `rollout-${missing}.jsonl`), row("session_meta", { id: missing }));
  await vi.advanceTimersByTimeAsync(5_001); expect(readCodexSession(missing)?.id).toBe(missing);
});
it("invalidates cached resolution immediately when the native index rotates a rollout", () => {
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.pragma("journal_mode = WAL"); db.exec("create table threads (id text, rollout_path text)");
    db.prepare("insert into threads values (?, ?)").run(thread, path);
    expect(readCodexSession(thread)?.path).toBe(path);
    const rotated = join(home, "sessions", `resumed-${thread}.jsonl`);
    writeFileSync(rotated, row("session_meta", { id: thread }) + row("event_msg", { type: "task_started" }));
    db.prepare("update threads set rollout_path = ? where id = ?").run(rotated, thread);
    expect(readCodexSession(thread)).toMatchObject({ path: rotated, status: "running" });
  } finally { db.close(); }
});
