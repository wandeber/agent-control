/** Detached supervisor: owns child signals and writes durable results without MCP lifetime coupling. */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function writeState(dir, state) {
    const path = join(dir, "state.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
}
export function supervise(dir) {
    const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
    rmSync(join(dir, "job.json")); // The prompt need not remain in a second file.
    let state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    let stopped = false;
    let completed = false;
    let buffer = "";
    writeFileSync(join(dir, "ready"), "ready", { mode: 0o600 });
    if (existsSync(join(dir, "cancelled"))) {
        state.status = "failed";
        writeState(dir, state);
        rmSync(join(dir, "active"), { recursive: true, force: true });
        return;
    }
    const child = spawn(job.executable, job.args, { cwd: job.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const persist = () => { state.updated_at = new Date().toISOString(); writeState(dir, state); };
    child.stdout.on("data", (chunk) => {
        appendFileSync(join(dir, "events.jsonl"), chunk, { mode: 0o600 });
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            try {
                const event = JSON.parse(line);
                if (event.type === "turn.completed")
                    completed = true;
                if (event.type === "thread.started" && typeof event.thread_id === "string") {
                    state.thread_id = event.thread_id;
                    persist();
                }
            }
            catch { /* Partial/non-JSON output is retained as diagnostic data only. */ }
        }
    });
    child.stderr.on("data", (chunk) => appendFileSync(join(dir, "stderr.log"), chunk, { mode: 0o600 }));
    child.stdin.on("error", () => { });
    child.stdin.end(job.prompt);
    let heartbeatAt = Date.now();
    const terminate = () => {
        stopped = true;
        if (child.pid) {
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch { /* Child already exited. */ }
        }
    };
    process.on("SIGTERM", terminate);
    process.on("SIGINT", terminate);
    const timer = setInterval(() => {
        if (existsSync(join(dir, "cancelled")))
            terminate();
        if (Date.now() - heartbeatAt >= 1000) {
            heartbeatAt = Date.now();
            persist();
        }
        if (existsSync(join(dir, "stop.json"))) {
            const request = JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"));
            stopped = true;
            if (child.pid) {
                try {
                    process.kill(-child.pid, request.mode === "kill" ? "SIGKILL" : "SIGTERM");
                }
                catch { /* Child already exited. */ }
            }
            rmSync(join(dir, "stop.json"), { force: true });
        }
    }, 100);
    let finished = false;
    const finish = (code) => {
        if (finished)
            return;
        finished = true;
        clearInterval(timer);
        process.off("SIGTERM", terminate);
        process.off("SIGINT", terminate);
        state.status = stopped ? "stopped" : code === 0 && completed && state.thread_id ? "completed" : "failed";
        state.exit_code = code;
        persist();
        rmSync(join(dir, "active"), { recursive: true, force: true });
    };
    child.on("error", () => finish(null));
    child.on("close", finish);
}
if (process.argv[2] === "--supervise" && process.argv[3])
    supervise(process.argv[3]);
