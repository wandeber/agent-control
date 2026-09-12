import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startStaticWebServer } from "./cli/web.js";
import { startControlServer } from "./control-server.js";
import { defaultControlHome, defaultStatePath } from "./core/paths.js";
import { AGENT_CONTROL_VERSION } from "./core/version.js";
const modulePath = fileURLToPath(import.meta.url);
const pluginRoot = resolve(dirname(modulePath), "../../..");
const pause = (ms) => new Promise(resolvePause => setTimeout(resolvePause, ms));
let starting;
/** Reuse one detached browser service per installation/database, independently of MCP lifetime. */
export async function ensureBrowserConsole() {
    starting ??= ensureServer().finally(() => { starting = undefined; });
    return starting;
}
async function ensureServer() {
    const instanceId = createHash("sha256").update(`${pluginRoot}\0${resolve(defaultStatePath())}\0${AGENT_CONTROL_VERSION}`).digest("hex");
    const folder = join(defaultControlHome(), "browser-console");
    const recordPath = join(folder, `${instanceId}.json`);
    const lock = `${recordPath}.lock`;
    mkdirSync(folder, { recursive: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const existing = await readyUrl(recordPath, instanceId);
        if (existing)
            return existing;
        try {
            mkdirSync(lock);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            try {
                if (Date.now() - statSync(lock).mtimeMs > 30000)
                    rmSync(lock, { recursive: true, force: true });
            }
            catch { /* Another caller released the lock. */ }
            await pause(100);
            continue;
        }
        try {
            const existing = await readyUrl(recordPath, instanceId);
            if (existing)
                return existing;
            if (recordedProcessAlive(recordPath, instanceId)) {
                throw new Error("The browser console is busy. Try again shortly.");
            }
            if (!existsSync(join(pluginRoot, "web-runtime/index.html")))
                throw new Error("The packaged browser console is unavailable.");
            const env = { ...process.env };
            // The global reader must not inherit the conversation's delegated identity.
            delete env.AGENT_CONTROL_TOKEN;
            delete env.CODEX_THREAD_ID;
            delete env.AGENT_CONTROL_REQUESTER_THREAD_ID;
            const child = spawn(process.execPath, [...process.execArgv, modulePath, "--serve", recordPath, instanceId], { env, detached: true, stdio: "ignore", windowsHide: true });
            let failed = false;
            child.once("error", () => { failed = true; });
            child.once("exit", () => { failed = true; });
            child.unref();
            while (!failed && Date.now() < deadline) {
                const url = await readyUrl(recordPath, instanceId, child.pid);
                if (url)
                    return url;
                await pause(100);
            }
            child.kill("SIGTERM");
            throw new Error("The browser console could not start. Try again.");
        }
        finally {
            rmSync(lock, { recursive: true, force: true });
        }
    }
    throw new Error("The browser console is still starting. Try again.");
}
function recordedProcessAlive(recordPath, instanceId) {
    try {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        if (record.instanceId !== instanceId || !Number.isInteger(record.pid) || record.pid <= 0)
            return false;
        try {
            process.kill(record.pid, 0);
            return true;
        }
        catch (error) {
            return error.code === "EPERM";
        }
    }
    catch {
        return false;
    }
}
async function readyUrl(recordPath, instanceId, expectedPid) {
    try {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        if (expectedPid !== undefined && record.pid !== expectedPid)
            return null;
        const url = new URL(record.url);
        if (record.instanceId !== instanceId || url.protocol !== "http:" || url.hostname !== "localhost" || !url.port)
            return null;
        const response = await fetch(new URL("/__agent_control_health", url), { signal: AbortSignal.timeout(400) });
        return response.ok && (await response.json()).instanceId === instanceId ? url.href : null;
    }
    catch {
        return null;
    }
}
export function browserOpenCommand(url, platform = process.platform, wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "localhost")
        throw new Error("Expected a local Agent Control URL.");
    if (platform === "darwin")
        return ["open", [url]];
    if (platform === "win32")
        return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
    if (wsl)
        return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url.replaceAll("'", "''")}'`]];
    return ["xdg-open", [url]];
}
export async function openBrowserConsole(runId, screen = "console", preview) {
    const url = new URL(await ensureBrowserConsole());
    if (runId)
        url.searchParams.set("run_id", runId);
    if (preview?.flow_id)
        url.searchParams.set("flow_id", preview.flow_id);
    if (preview?.repo_dir)
        url.searchParams.set("repo_dir", preview.repo_dir);
    url.hash = `/${screen}`;
    const [command, args] = browserOpenCommand(url.href);
    await promisify(execFile)(command, args, { timeout: 5000, windowsHide: true });
    return { url: url.href };
}
async function serve(recordPath, instanceId) {
    const api = await startControlServer({ host: "localhost", port: 0 });
    let web;
    try {
        web = await startStaticWebServer({ host: "localhost", port: 0, rootDir: join(pluginRoot, "web-runtime"), instanceId });
    }
    catch (error) {
        await api.close();
        throw error;
    }
    api.setUiOrigin(`http://localhost:${web.address().port}`);
    const url = `http://localhost:${web.address().port}/?apiPort=${api.server.address().port}`;
    const temporary = `${recordPath}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify({ url, pid: process.pid, instanceId }), { mode: 0o600 });
        renameSync(temporary, recordPath);
    }
    catch (error) {
        await Promise.all([api.close(), new Promise(done => web.close(() => done()))]);
        rmSync(temporary, { force: true });
        throw error;
    }
    let closing = false;
    const stop = async () => {
        if (closing)
            return;
        closing = true;
        await Promise.all([api.close(), new Promise(done => web.close(() => done()))]);
        try {
            if (JSON.parse(readFileSync(recordPath, "utf8")).pid === process.pid)
                rmSync(recordPath);
        }
        catch { /* A newer listener may have replaced the record. */ }
    };
    process.once("SIGTERM", () => { void stop(); });
    process.once("SIGINT", () => { void stop(); });
}
if (process.argv[1] && resolve(process.argv[1]) === modulePath && process.argv[2] === "--serve") {
    void serve(process.argv[3], process.argv[4]).catch(() => { process.exitCode = 1; });
}
