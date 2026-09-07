import { CodexSessionAdapter } from "../src/adapters/codex-session.js";
import { CodexAppServerClient } from "../src/adapters/codex-thread-adapter.js";
import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverCliWriter, interruptCliWriter } from "../src/adapters/cli-writer.js";
import { cancelQueuedCliMessages, cliQueueState, ensureCliBridge, queueCliMessage, resolveCliContinuity, superviseAttachedCli } from "../src/adapters/attached-cli-bridge.js";

const thread = "44444444-4444-4444-8444-444444444444";
const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + "\n";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(100); } throw new Error("Fixture did not reach expected state"); }
let supported = process.platform !== "win32";
try { execFileSync("cc", ["--version"], { stdio: "ignore" }); execFileSync("lsof", ["-v"], { stdio: "ignore" }); } catch { supported = false; }

describe.skipIf(!supported)("existing CLI process control and durable continuation", () => {
  let dir: string, rollout: string, executable: string, child: ChildProcess | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-cli-bridge-")); mkdirSync(join(dir, "sessions"));
    vi.stubEnv("CODEX_HOME", dir); vi.stubEnv("AGENT_CONTROL_HOME", dir);
    rollout = join(dir, "sessions", `rollout-${thread}.jsonl`);
    writeFileSync(rollout, row("session_meta", { id: thread, cwd: dir, model_provider: "fixture-provider" }) + row("turn_context", { model: "fixture-model", effort: "high", approval_policy: "never", sandbox_policy: { type: "read-only" } }) + row("event_msg", { type: "task_started" }));
    writeFileSync(join(dir, "fixture.config.toml"), 'model = "fixture-model"\nmodel_provider = "fixture-provider"\n');
    executable = join(dir, "codex");
    const source = join(dir, "fixture.c");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
volatile sig_atomic_t stopped = 0;
void stop(int s) { stopped = 1; }
int main(int argc, char **argv) {
  int resumed = 0; for (int i=1;i<argc;i++) if (!strcmp(argv[i], "resume")) resumed=1;
  FILE *f = fopen(getenv("FIXTURE_ROLLOUT"), "a");
  if (resumed) {
    FILE *capture = fopen(getenv("FIXTURE_CAPTURE"), "a");
    for (int i=1;i<argc;i++) fprintf(capture, "%s|", argv[i]); fprintf(capture, "\\n"); fclose(capture);
    char input[4096]; while (fgets(input,sizeof(input),stdin)) {}
    fprintf(f, "{\\"type\\":\\"event_msg\\",\\"payload\\":{\\"type\\":\\"task_started\\"}}\\n"); fflush(f);
    usleep(getenv("FIXTURE_RESUME_DELAY") ? atoi(getenv("FIXTURE_RESUME_DELAY")) : 20000);
    fprintf(f, "{\\"type\\":\\"event_msg\\",\\"payload\\":{\\"type\\":\\"task_complete\\"}}\\n"); fclose(f); return 0;
  }
  FILE *other = getenv("FIXTURE_SECOND") ? fopen(getenv("FIXTURE_SECOND"), "a") : NULL;
  signal(SIGINT,stop); puts("READY"); fflush(stdout);
  while (!stopped) usleep(10000);
  fprintf(f, "{\\"type\\":\\"event_msg\\",\\"payload\\":{\\"type\\":\\"turn_aborted\\"}}\\n");
  fclose(f); if(other) fclose(other); return 0;
}`);
    execFileSync("cc", [source, "-o", executable]);
    vi.stubEnv("FIXTURE_ROLLOUT", rollout); vi.stubEnv("FIXTURE_CAPTURE", join(dir, "capture"));
    vi.stubEnv("AGENT_CONTROL_CODEX_CLI_BIN", executable);
  });
  afterEach(async () => {
    if (child?.exitCode === null && child.signalCode === null) { child.kill("SIGINT"); await new Promise(resolve => child!.once("exit", resolve)); }
    child = undefined;
    // Wait for the fixture's detached supervisor to release its directory.
    await until(() => !existsSync(join(dir, "attached-cli", thread, "supervisor")));
    vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
  });
  async function start(extra: Record<string, string> = {}) {
    child = spawn(executable, ["exec", "--profile", "fixture"], { env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => { child!.stdout!.once("data", () => resolve()); child!.once("error", reject); });
  }
  it("signals only the exclusive exec writer after rechecking PID, start time and rollout FD", async () => {
    await start(); const writer = discoverCliWriter(rollout)!;
    expect(writer).toMatchObject({ pid: child!.pid, executable: realpathSync(executable), profile: "fixture" });
    expect(() => interruptCliWriter(rollout, { ...writer, started: "different process birth" })).toThrow("no process was signalled");
    expect(child!.exitCode).toBeNull();
    interruptCliWriter(rollout, writer);
    await until(() => child!.exitCode !== null);
    expect(readFileSync(rollout, "utf8")).toContain("turn_aborted");
  });
  it("rejects a shared writer even when it holds the requested rollout", async () => {
    const second = join(dir, "sessions", "rollout-another.jsonl");
    await start({ FIXTURE_SECOND: second });
    expect(discoverCliWriter(rollout)).toBeNull();
  });
  it("queues behind live work, resumes exact UUID/profile once, and survives another supervisor start", async () => {
    await start(); const writer = discoverCliWriter(rollout)!;
    const continuity = resolveCliContinuity(thread, undefined, writer);
    const id = queueCliMessage(continuity, "A requested follow-up");
    expect(cliQueueState(thread).pending).toBe(1);
    await sleep(300); expect(existsSync(join(dir, "capture"))).toBe(false);
    // Simulate another MCP attaching: its supervisor contender must not dispatch twice.
    void superviseAttachedCli(thread);
    interruptCliWriter(rollout, writer);
    await until(() => cliQueueState(thread).pending === 0);
    const args = readFileSync(join(dir, "capture"), "utf8");
    expect(args.trim().split("\n")).toHaveLength(1);
    expect(args).toContain("--profile|fixture|");
    expect(args).toContain(`--model|fixture-model|resume|${thread}|-|`);
    expect(args).toContain("--sandbox|read-only|");
    expect(JSON.parse(readFileSync(join(dir, "attached-cli", thread, `${id}.json`), "utf8")).state).toBe("completed");
  }, 15000);
  it("does not replay an uncertain dispatch after supervisor recovery", async () => {
    appendFileSync(rollout, row("event_msg", { type: "task_complete" }));
    const continuity = resolveCliContinuity(thread, "fixture");
    const queue = join(dir, "attached-cli", thread); mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, "recover.json"), JSON.stringify({ id: "recover", continuity, prompt: "already dispatched?", state: "dispatched" }));
    await superviseAttachedCli(thread);
    expect(cliQueueState(thread).uncertain).toBe(1);
    expect(existsSync(join(dir, "capture"))).toBe(false);
  });
  it("recovers a stale supervisor lock with two competing real processes without duplicate dispatch", async () => {
    appendFileSync(rollout, row("event_msg", { type: "task_complete" }));
    const continuity = resolveCliContinuity(thread, "fixture");
    const queue = join(dir, "attached-cli", thread), lock = join(queue, "supervisor"); mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 2147483647, started: "dead process" }));
    writeFileSync(join(queue, "pending.json"), JSON.stringify({ id: "pending", continuity, prompt: "once", state: "pending" }));
    const runner = new URL("../dist/adapters/attached-cli-bridge.js", import.meta.url).pathname;
    await Promise.all([1, 2].map(() => new Promise<void>((resolve, reject) => {
      const competitor = spawn(process.execPath, [runner, "--attached-bridge", thread], { env: process.env, stdio: "ignore" });
      competitor.once("error", reject); competitor.once("close", code => code === 0 ? resolve() : reject(new Error(`Supervisor exited ${code}`)));
    })));
    expect(readFileSync(join(dir, "capture"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(cliQueueState(thread).pending).toBe(0);
  }, 15000);
  it("serializes cancellation against dispatch and does not start a cancelled message", async () => {
    appendFileSync(rollout, row("event_msg", { type: "task_complete" }));
    const continuity = resolveCliContinuity(thread, "fixture");
    const queue = join(dir, "attached-cli", thread); mkdirSync(queue, { recursive: true });
    const lock = new Database(join(queue, "dispatch-lock.sqlite")); lock.exec("BEGIN IMMEDIATE");
    writeFileSync(join(queue, "pending.json"), JSON.stringify({ id: "pending", continuity, prompt: "cancel me", state: "pending" }));
    expect(() => cancelQueuedCliMessages(thread)).toThrow("acceptance boundary");
    lock.exec("ROLLBACK"); lock.close();
    expect(cancelQueuedCliMessages(thread)).toBe(1);
    await superviseAttachedCli(thread);
    expect(existsSync(join(dir, "capture"))).toBe(false);
  });
  it("reattaches its own continuing CLI despite generated configuration flags", async () => {
    appendFileSync(rollout, row("event_msg", { type: "task_complete" }));
    vi.stubEnv("FIXTURE_RESUME_DELAY", "1000000");
    const continuity = resolveCliContinuity(thread, "fixture");
    queueCliMessage(continuity, "follow up");
    await until(() => existsSync(join(dir, "capture")));
    const writer = discoverCliWriter(rollout)!;
    expect(writer.configurationOverrides).toBe(true);
    expect(resolveCliContinuity(thread, undefined, writer)).toEqual(continuity);
    await until(() => cliQueueState(thread).pending === 0);
  }, 15000);
  it("releases the supervisor exclusion after an actual process crash", async () => {
    appendFileSync(rollout, row("event_msg", { type: "task_complete" }));
    const continuity = resolveCliContinuity(thread, "fixture");
    const queue = join(dir, "attached-cli", thread); mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, "pending.json"), JSON.stringify({ id: "pending", continuity, prompt: "after crash", state: "pending" }));
    const blocker = spawn(process.execPath, ["-e", 'const D=require("better-sqlite3"); const db=new D(process.argv[1]); db.exec("BEGIN IMMEDIATE"); console.log("LOCKED"); setInterval(()=>{},1000)', join(queue, "supervisor-lock.sqlite")], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
    child = blocker;
    await new Promise<void>(resolve => blocker.stdout!.once("data", () => resolve()));
    await superviseAttachedCli(thread);
    expect(existsSync(join(dir, "capture"))).toBe(false);
    const exited = new Promise(resolve => blocker.once("close", resolve)); blocker.kill("SIGKILL"); await exited; child = undefined;
    await superviseAttachedCli(thread);
    expect(readFileSync(join(dir, "capture"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 15000);
  it("does not let an explicit matching profile bypass unknown CLI configuration overrides", async () => {
    await start(); const writer = discoverCliWriter(rollout)!;
    expect(() => resolveCliContinuity(thread, "fixture", { ...writer, unsupportedOverrides: true })).toThrow("additional configuration overrides");
  });
  it("does not resume an app-server archive while a CLI still owns its terminal rollout", async () => {
    await start(); appendFileSync(rollout, row("event_msg", { type: "task_complete" }));
    vi.spyOn(CodexAppServerClient.prototype, "initialize").mockResolvedValue();
    const request = vi.spyOn(CodexAppServerClient.prototype, "request").mockResolvedValue({ thread: { id: thread, status: { type: "notLoaded" } } });
    await expect(new CodexSessionAdapter().sendMessage({ backend: "codex-session", id: thread, data: { thread_id: thread, cli_configuration_valid: true } }, { message: "follow up" })).rejects.toThrow("does not own the active session");
    expect(request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  });
  it("rejects a changed provider profile before dispatch", () => {
    const continuity = resolveCliContinuity(thread, "fixture");
    appendFileSync(join(dir, "fixture.config.toml"), '\n# configuration changed\n');
    expect(() => queueCliMessage(continuity, "follow-up")).toThrow("configuration changed");
  });
});
