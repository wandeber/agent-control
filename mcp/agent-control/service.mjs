#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const home = process.env.AGENT_CONTROL_HOME || join(homedir(), ".agent-control");
const label = "dev.agent-control.mcp", domain = `gui/${process.getuid()}`;
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const configPath = join(home, "mcp-service.json");
const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const launchctl = args => execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
const command = process.argv[2] ?? "status";
if (process.platform !== "darwin") throw new Error("The local service installer currently supports macOS.");

if (command === "install") {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { port: 17662, token: randomBytes(32).toString("hex") };
  if (config.port !== 17662 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error("Invalid existing MCP service configuration.");
  for (const [path, content] of [[configPath, config], [join(home, "mcp-headers.json"), { Authorization: `Bearer ${config.token}` }]]) {
    writeFileSync(path, JSON.stringify(content) + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
  }
  mkdirSync(dirname(plist), { recursive: true });
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(join(packageDir, "run-agent-control-mcp.sh"))}</string><string>--http</string></array>
<key>WorkingDirectory</key><string>${xml(resolve(packageDir, "../.."))}</string>
<key>EnvironmentVariables</key><dict><key>AGENT_CONTROL_NODE_BIN</key><string>${xml(process.execPath)}</string><key>AGENT_CONTROL_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(dirname(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>${xml(join(home, "mcp-service.log"))}</string>
</dict></plist>\n`;
  const unchanged = existsSync(plist) && readFileSync(plist, "utf8") === contents;
  if (!unchanged) {
    if (existsSync(plist)) {
      const previous = readFileSync(plist, "utf8");
      if (!previous.includes(`<string>${label}</string>`)) throw new Error("Refusing to replace an unrelated LaunchAgent.");
      writeFileSync(plist + ".previous", previous, { mode: 0o600 });
    }
    try { launchctl(["bootout", `${domain}/${label}`]); } catch { /* First installation has no running job. */ }
    writeFileSync(plist, contents, { mode: 0o600 }); chmodSync(plist, 0o600);
  }
  try { launchctl(["print", `${domain}/${label}`]); }
  catch { launchctl(["bootstrap", domain, plist]); }
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://localhost:${config.port}/health`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        if (health.version === version) { console.log(JSON.stringify({ installed: true, url: `http://localhost:${config.port}/mcp`, ...health })); break; }
      }
    } catch { /* Allow the packaged runner to prepare its native binding. */ }
    if (Date.now() > deadline) throw new Error("Service did not become healthy; inspect the private mcp-service.log.");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
} else if (command === "status") {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const response = await fetch(`http://localhost:${config.port}/health`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Service health failed (${response.status}).`);
  console.log(JSON.stringify(await response.json()));
} else throw new Error("Use service.mjs install or status.");
