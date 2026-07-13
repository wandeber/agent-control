import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function registerMarketplaceCommands(program, output) {
    const marketplace = program
        .command("marketplace")
        .description("Install or update the Agent Control Codex marketplace.");
    marketplace
        .command("install")
        .description("Register this repository, or another source, as a Codex plugin marketplace.")
        .argument("[source]", "Local path or Git marketplace source. Defaults to this checkout.", resolveRepoRoot())
        .option("--ref <ref>", "Git ref to use when source is a Git marketplace.", process.env.AGENT_CONTROL_MARKETPLACE_REF ?? "main")
        .option("--json", "Request JSON output from Codex.")
        .action(async (source, options) => {
        const args = ["plugin", "marketplace", "add", source];
        if (isGitMarketplaceSource(source)) {
            args.push("--ref", options.ref);
        }
        if (options.json) {
            args.push("--json");
        }
        const result = await runCodex(args);
        output({
            installed: true,
            source,
            ref: isGitMarketplaceSource(source) ? options.ref : null,
            ...result
        });
    });
    marketplace
        .command("update")
        .alias("upgrade")
        .description("Refresh an existing Git marketplace installation.")
        .argument("[name]", "Configured marketplace name.", process.env.AGENT_CONTROL_MARKETPLACE_NAME ?? "agent-control")
        .option("--json", "Request JSON output from Codex.")
        .action(async (name, options) => {
        const args = ["plugin", "marketplace", "upgrade", name];
        if (options.json) {
            args.push("--json");
        }
        const result = await runCodex(args);
        output({
            updated: true,
            name,
            ...result
        });
    });
}
function resolveRepoRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}
function isGitMarketplaceSource(source) {
    if (source.startsWith("/") || source.startsWith(".") || source.startsWith("~")) {
        return false;
    }
    return true;
}
async function runCodex(args) {
    return await new Promise((resolveCommand, rejectCommand) => {
        const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", rejectCommand);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolveCommand({
                    command: "codex",
                    args,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
                return;
            }
            rejectCommand(new Error(`codex ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
        });
    });
}
