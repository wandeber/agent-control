import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptDir, "..");
const sourceDir = resolve(webDir, "out");
const runtimeDir = resolve(webDir, "..", "web-runtime");

if (!existsSync(sourceDir)) {
  throw new Error(`Next static export was not found at ${sourceDir}. Run pnpm build first.`);
}

rmSync(runtimeDir, { force: true, recursive: true });
cpSync(sourceDir, runtimeDir, { recursive: true });

console.log(`Copied Agent Control web runtime to ${runtimeDir}`);
