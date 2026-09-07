import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { ControllerError } from "../core/errors.js";
const run = (bin, args) => execFileSync(bin, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
export function hasRolloutWriter(path) {
    try {
        return run("lsof", ["-nP", "-Fa", "--", path]).split("\n").some(row => /^a[wu]$/.test(row));
    }
    catch (error) {
        return error.status !== 1;
    }
}
/** A PID alone is never authority: require the exclusive writable rollout FD and exec identity. */
export function discoverCliWriter(path) {
    if (process.platform === "win32")
        return null;
    try {
        path = realpathSync(path);
    }
    catch {
        return null;
    }
    let rows;
    try {
        rows = run("lsof", ["-nP", "-Fpcfan", "--", path]).split("\n");
    }
    catch {
        return null;
    }
    const candidates = new Set();
    let pid = 0, access = "";
    for (const row of rows) {
        if (row[0] === "p")
            pid = Number(row.slice(1));
        if (row[0] === "f")
            access = "";
        if (row[0] === "a")
            access = row.slice(1);
        if (row === `n${path}` && /[wu]/.test(access))
            candidates.add(pid);
    }
    if (candidates.size !== 1)
        return null;
    pid = [...candidates][0];
    try {
        const started = run("ps", ["-p", String(pid), "-o", "lstart="]);
        const command = run("ps", ["-p", String(pid), "-o", "command="]);
        // Only standalone exec, never an app-server, UI, shell, or shared multi-session process.
        if (!/^\S*codex\s+exec(?:\s|$)/.test(command))
            return null;
        const files = run("lsof", ["-nP", "-a", "-p", String(pid), "-Ffan"]).split("\n");
        const rollouts = new Set();
        let fd = "", mode = "", executable = "";
        for (const row of files) {
            if (row[0] === "f") {
                fd = row.slice(1);
                mode = "";
            }
            if (row[0] === "a")
                mode = row.slice(1);
            if (row[0] === "n") {
                const name = row.slice(1);
                if (fd === "txt" && basename(name) === "codex")
                    executable = name;
                if (/[wu]/.test(mode) && /rollout-.*\.jsonl$/.test(name))
                    rollouts.add(name);
            }
        }
        if (!executable || rollouts.size !== 1 || !rollouts.has(path))
            return null;
        const profile = command.match(/(?:^|\s)(?:--profile|-p)(?:=|\s+)([A-Za-z0-9][A-Za-z0-9_.-]*)(?=\s|$)/)?.[1];
        if (run("ps", ["-p", String(pid), "-o", "lstart="]) !== started)
            return null;
        const overrides = [...command.matchAll(/(?:^|\s)(?:-c|--config)(?:=|\s+)['"]?([A-Za-z_][A-Za-z0-9_.]*)\s*=/g)].map(match => match[1]);
        const flagCount = [...command.matchAll(/(?:^|\s)(?:-c|--config)(?:=|\s)/g)].length;
        const preserved = new Set(["model", "model_reasoning_effort", "approval_policy", "sandbox_mode", "sandbox_workspace_write.network_access", "sandbox_workspace_write.writable_roots"]);
        return { pid, started, executable, profile, configurationOverrides: flagCount > 0,
            unsupportedOverrides: flagCount !== overrides.length || overrides.some(key => !preserved.has(key)) };
    }
    catch {
        return null;
    }
}
export function interruptCliWriter(path, expected) {
    const current = discoverCliWriter(path);
    if (!current || current.pid !== expected.pid || current.started !== expected.started || current.executable !== expected.executable) {
        throw new ControllerError("The exclusive CLI writer identity changed; no process was signalled.", "backend_unavailable");
    }
    // Signal only the reverified writer, not its process group or unrelated shell.
    process.kill(current.pid, "SIGINT");
}
