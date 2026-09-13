import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "ac-bootstrap-test-")); roots.push(root); return root; };
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const helper = resolve("runtime/bootstrap.mjs");
function node(args: string[], env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || "Exit " + code)));
  });
}
it("recovers one abandoned preparation and excludes concurrent owners", async () => {
  const root = temp(), lock = join(root, "lock"), active = join(root, "active");
  mkdirSync(lock); writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead" }));
  const script = `import {withLock} from ${JSON.stringify(pathToFileURL(helper).href)}; import {writeFileSync,unlinkSync} from 'node:fs';
    await withLock(process.argv[1],async()=>{writeFileSync(process.argv[2],'owned',{flag:'wx'});await new Promise(r=>setTimeout(r,30));unlinkSync(process.argv[2]);});`;
  await Promise.all(Array.from({ length: 8 }, () => node(["--input-type=module", "-e", script, lock, active])));
  expect(existsSync(lock)).toBe(false); expect(existsSync(active)).toBe(false);
}, 15000);
it("releases ownership after a failed preparation", async () => {
  const lock = join(temp(), "lock");
  const script = `import {withLock} from ${JSON.stringify(pathToFileURL(helper).href)};try {await withLock(process.argv[1],()=>{throw Error('fixture');});}catch{};await withLock(process.argv[1],()=>{});`;
  await node(["--input-type=module", "-e", script, lock]); expect(existsSync(lock)).toBe(false);
});
it("repairs a corrupt cached addon and retains other ABI variants", async () => {
  const cache = temp(), env = { ...process.env, AGENT_CONTROL_NATIVE_CACHE: cache };
  const binding = (await node([helper], env)).trim(), before = readFileSync(binding);
  const other = join(cache, "other-abi.node"); writeFileSync(other, "retain"); writeFileSync(binding, "damaged");
  expect(await Promise.all([node([helper], env), node([helper], env)])).toEqual([binding, binding]);
  expect(readFileSync(binding)).toEqual(before); expect(readFileSync(other, "utf8")).toBe("retain");
}, 15000);
