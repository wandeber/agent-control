import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startControlServer } from "../control-server.js";
import { parseIntOption, resolveAgentctlPath, runCommand } from "./shared.js";
export function registerWebCommands(program, output) {
    const web = program.command("web").description("Run the local Agent Control web console.");
    web
        .command("build")
        .description("Build the static web runtime used by agentctl web start --mode static.")
        .action(async () => {
        const webDir = resolveWebDir();
        await buildWebRuntime(webDir);
        output({
            built: true,
            web_dir: webDir,
            runtime_dir: resolveWebRuntimeDir()
        });
    });
    web
        .command("start")
        .option("--host <host>", "Host to bind.", "localhost")
        .option("--port <port>", "Web UI port.", parseIntOption, 3766)
        .option("--api-port <port>", "Agent Control API/WebSocket port.", parseIntOption, 3767)
        .option("--mode <mode>", "Web mode: auto, static, or dev.", "auto")
        .option("--rebuild", "Rebuild the static web runtime before starting. Ignored for --mode dev.")
        .option("--detach", "Start in the background and return immediately.")
        .action(async (options) => {
        const webDir = resolveWebDir();
        const webRuntimeDir = resolveWebRuntimeDir();
        const mode = options.mode === "auto" ? "static" : options.mode;
        if (options.rebuild && mode !== "dev") {
            await buildWebRuntime(webDir);
        }
        if (options.detach) {
            const child = spawn(resolveAgentctlPath(), [
                "web",
                "start",
                "--host",
                options.host,
                "--port",
                String(options.port),
                "--api-port",
                String(options.apiPort),
                "--mode",
                options.mode
            ], {
                detached: true,
                stdio: "ignore"
            });
            child.unref();
            const webUrl = options.apiPort === options.port + 1
                ? `http://${options.host}:${options.port}`
                : `http://${options.host}:${options.port}?apiPort=${options.apiPort}`;
            output({
                detached: true,
                pid: child.pid,
                api_url: `http://${options.host}:${options.apiPort}`,
                web_url: webUrl
            });
            return;
        }
        if (!existsSync(join(webDir, "package.json"))) {
            throw new Error(`Agent Control web package not found: ${webDir}`);
        }
        const running = await startControlServer({ host: options.host, port: options.apiPort });
        const webUrl = options.apiPort === options.port + 1
            ? `http://${options.host}:${options.port}`
            : `http://${options.host}:${options.port}?apiPort=${options.apiPort}`;
        const apiBase = `http://${options.host}:${options.apiPort}`;
        const wsUrl = `ws://${options.host}:${options.apiPort}/ws/control`;
        let child = null;
        let webServer = null;
        if (mode === "static") {
            if (!existsSync(join(webRuntimeDir, "index.html"))) {
                await running.close();
                throw new Error(`Agent Control web runtime not found at ${webRuntimeDir}. Run agentctl web build before packaging or use --mode dev for local development.`);
            }
            webServer = await startStaticWebServer({ host: options.host, port: options.port, rootDir: webRuntimeDir });
        }
        else if (mode === "dev") {
            child = spawn("pnpm", ["--dir", webDir, "exec", "next", "dev", "-H", options.host, "-p", String(options.port)], {
                env: {
                    ...process.env,
                    NEXT_PUBLIC_AGENT_CONTROL_API_BASE: apiBase,
                    NEXT_PUBLIC_AGENT_CONTROL_WS_URL: wsUrl
                },
                stdio: "inherit"
            });
        }
        else {
            await running.close();
            throw new Error(`Unsupported Agent Control web mode: ${options.mode}`);
        }
        console.error(`Agent Control API listening on ${apiBase}`);
        console.error(`Agent Control web console listening on ${webUrl}`);
        await new Promise((resolveShutdown, rejectShutdown) => {
            const stop = () => {
                child?.kill("SIGTERM");
                webServer?.close();
                void running.close().finally(resolveShutdown);
            };
            webServer?.once("close", () => {
                void running.close().finally(resolveShutdown);
            });
            child?.once("exit", () => {
                webServer?.close();
                void running.close().finally(resolveShutdown);
            });
            child?.once("error", (error) => {
                webServer?.close();
                void running.close().finally(() => rejectShutdown(error));
            });
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
        });
    });
}
function resolveWebDir() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../web");
}
function resolveWebRuntimeDir() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../web-runtime");
}
async function buildWebRuntime(webDir) {
    if (!existsSync(join(webDir, "package.json"))) {
        throw new Error(`Agent Control web package not found: ${webDir}`);
    }
    await runCommand("pnpm", ["--dir", webDir, "build:runtime"]);
}
async function startStaticWebServer({ host, port, rootDir }) {
    const root = resolve(rootDir);
    const server = createServer((request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.statusCode = 405;
            response.setHeader("allow", "GET, HEAD");
            response.end("Method not allowed");
            return;
        }
        try {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
            const filePath = resolveStaticFile(root, url.pathname);
            if (!filePath) {
                sendStaticError(response, 404, "Not found");
                return;
            }
            sendStaticFile(response, filePath, request.method === "HEAD");
        }
        catch (error) {
            sendStaticError(response, 500, error instanceof Error ? error.message : String(error));
        }
    });
    await new Promise((resolveListen) => {
        server.listen(port, host, resolveListen);
    });
    return server;
}
function resolveStaticFile(root, rawPathname) {
    const pathname = decodeURIComponent(rawPathname);
    const requested = resolve(root, `.${pathname}`);
    if (!isInsidePath(root, requested)) {
        return null;
    }
    if (existsSync(requested)) {
        const stat = statSync(requested);
        if (stat.isDirectory()) {
            const indexFile = join(requested, "index.html");
            return existsSync(indexFile) ? indexFile : null;
        }
        return stat.isFile() ? requested : null;
    }
    if (extname(pathname)) {
        return null;
    }
    const indexFile = join(root, "index.html");
    return existsSync(indexFile) ? indexFile : null;
}
function sendStaticFile(response, filePath, headOnly) {
    response.statusCode = 200;
    response.setHeader("content-type", contentTypeFor(filePath));
    response.setHeader("cache-control", cacheControlFor(filePath));
    if (headOnly) {
        response.end();
        return;
    }
    createReadStream(filePath).pipe(response);
}
function sendStaticError(response, status, message) {
    response.statusCode = status;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(message);
}
function cacheControlFor(filePath) {
    if (filePath.endsWith(".html")) {
        return "no-store";
    }
    return filePath.includes(`${sep}_next${sep}static${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
}
function contentTypeFor(filePath) {
    const types = {
        ".css": "text/css; charset=utf-8",
        ".gif": "image/gif",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2"
    };
    return types[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
function isInsidePath(root, target) {
    return target === root || target.startsWith(`${root}${sep}`);
}
