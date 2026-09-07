#!/usr/bin/env node
// Use the runtime resolver so setup and launch share discovery and validation.
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'mcp/agent-control/package.json'));
const { parse } = require('smol-toml');
const { getFlowFromCatalog } = await import(join(root, 'mcp/agent-control/dist/core/flow-catalog.js'));
const { resolveProjectRoot, applyModelPreferences } = await import(join(root, 'mcp/agent-control/dist/core/project-models.js'));
const args = process.argv.slice(2); const command = args.shift();
if (!['list', 'set'].includes(command)) throw new Error('Expected list or set.');
const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return undefined; const value = args[i+1]; args.splice(i, 2); return value; };
const seenSingletons = new Set();
for (let i=0; i<args.length; i+=2) {
  if (args[i] !== "--set") { if (seenSingletons.has(args[i])) throw new Error("Duplicate option."); seenSingletons.add(args[i]); }
  if (!['--project','--flow','--set'].includes(args[i]) || typeof args[i+1] !== 'string' || args[i+1].startsWith('--')) throw new Error('Unknown or incomplete argument.');
  if (args[i] === '--set' && command !== 'set') throw new Error('--set requires the set command.');
}
const project = resolveProjectRoot(resolve(take('--project') ?? process.cwd()));
let flow = take('--flow') ?? 'development-flow-v1';
const file = join(project, '.agents/models.toml');
const catalog = getFlowFromCatalog({ flowId: flow, projectDir: project });
flow = catalog.config.id;
const originalToml = existsSync(file) ? readFileSync(file, 'utf8') : '';
const config = originalToml ? parse(originalToml) : {};
const touched = new Set();
let changes = 0;
if (command === 'set') {
  for (let value; (value = take('--set')) !== undefined;) {
    const match = /^([^.]+)\.(model|reasoning_effort)=(.+)$/.exec(value);
    if (!match || !catalog.config.roles[match[1]]) throw new Error('Use --set known-role.model=value or known-role.reasoning_effort=value.');
    const [, role, field, setting] = match;
    config.flows ??= {}; config.flows[flow] ??= {}; config.flows[flow][role] ??= {};
    config.flows[flow][role][field] = setting; touched.add(role); changes++;
  }
  if (!changes) throw new Error('set requires at least one --set.');
} else if (command !== 'list') throw new Error('Expected list or set.');
if (args.length) throw new Error('Unknown arguments.');
if (command === 'set') commitConfig();
console.log(JSON.stringify({ project, flow, file, changed: changes, roles: Object.fromEntries(Object.entries(getFlowFromCatalog({ flowId: flow, projectDir: project }).config.roles).map(([id, role]) => [id, { model: role.model, reasoning_effort: role.reasoning_effort }])) }, (_key, value) => value, 2));
function commitConfig() {
  applyModelPreferences(catalog.config, config);
  const content = patchRoleTables(originalToml);
  applyModelPreferences(catalog.config, parse(content));
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, content);
}
// Retain all unrelated tables and comments verbatim, changing only requested keys.
function patchRoleTables(original) {
  let text = original;
  for (const role of touched) {
    const header = `[flows.${JSON.stringify(flow)}.${JSON.stringify(role)}]`;
    const lines = text.split('\n');
    let start = -1, end = lines.length;
    for (let i=0; i<lines.length; i++) {
      if (!/^\s*\[/.test(lines[i])) continue;
      if (start >= 0) { end=i; break; }
      try {
        const sample = parse(lines[i] + '\n__probe = true');
        if (sample.flows?.[flow]?.[role]?.__probe) start=i;
      } catch { /* The full file was already validated; parent tables are unrelated. */ }
    }
    if (start < 0) {
      text += (text && !text.endsWith('\n') ? '\n' : '') + '\n' + header + '\n';
      for (const [key,value] of Object.entries(config.flows[flow][role])) text += `${key} = ${JSON.stringify(value)}\n`;
    } else {
      const body=lines.slice(start+1,end);
      for (const [key,value] of Object.entries(config.flows[flow][role])) {
        const index=body.findIndex(line=>new RegExp(`^\\s*${key}\\s*=`).test(line));
        if(index>=0) body[index]=`${key} = ${JSON.stringify(value)}`; else body.push(`${key} = ${JSON.stringify(value)}`);
      }
      lines.splice(start+1,end-start-1,...body); text=lines.join('\n');
    }
  }
  return text;
}

function atomicWrite(path, content) {
  const temp = path + `.tmp-${process.pid}`;
  try { writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
