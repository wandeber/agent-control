import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { EvidenceContext } from './schema.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function fingerprint(value: unknown): string { return sha256(canonical(value)); }

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Evidence storage must be a real directory.');
}
export function immutableJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export function readRegular(path: string): Buffer {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Evidence input must be a regular file.');
  return readFileSync(path);
}
export function repositoryPath(repo: string, path: string): string {
  const root = realpathSync(repo);
  const target = resolve(repo, path);
  const rel = relative(root, realpathSync(target));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence input escapes the repository.');
  return target;
}

export class HdtProvider {
  readonly manifest: { source_version: string; sha256: string; companions: Record<string, { sha256: string }> };
  readonly helperPath: string;
  constructor(readonly store: string, readonly pythonCommand = 'python3') {
    const vendor = resolve(dirname(fileURLToPath(import.meta.url)), '../../../vendor/hdt');
    this.helperPath = resolve(vendor, 'review_checkpoint.py');
    this.manifest = JSON.parse(readFileSync(resolve(vendor, 'provider.json'), 'utf8'));
    this.verifyPin();
    privateDirectory(store);
  }
  verifyPin(): void {
    if (sha256(readRegular(this.helperPath)) !== this.manifest.sha256) throw new Error('HDT provider integrity check failed.');
  }
  draftContracts(plan: boolean): Record<string, unknown> {
    return Object.fromEntries([plan ? 'plan-intent-review' : 'strict-review', 'incremental-review'].map(name => {
      const entry = `contracts/${name}.md`; const path = resolve(dirname(this.helperPath), entry);
      if (sha256(readRegular(path)) !== this.manifest.companions[entry].sha256) throw new Error('HDT draft contract integrity failed.');
      return [name, { path, sha256: this.manifest.companions[entry].sha256 }];
    }));
  }
  invoke(context: EvidenceContext, operation: string, args: string[] = [], input?: { flag: string; value: unknown }): Record<string, any> {
    this.verifyPin();
    let inputPath: string | undefined;
    try {
      if (input) {
        inputPath = resolve(this.store, `input-${randomUUID()}.json`);
        writeFileSync(inputPath, JSON.stringify(input.value), { flag: 'wx', mode: 0o600 });
      }
      const result = spawnSync(this.pythonCommand, [this.helperPath, operation, '--repo', context.repoPath,
        '--store', this.store, '--workflow-id', 'flow', ...args,
        ...(inputPath && input ? [input.flag, inputPath] : [])], { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
        timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      if (result.error || result.status !== 0) {
        // Provider diagnostics contain structure/path errors, never command output.
        const diagnostic = result.stderr.trim().slice(-1800).replace(/[\u0000-\u001f]/g, ' ');
        throw new Error(`HDT ${operation} verification failed${diagnostic ? `: ${diagnostic}` : ''}`);
      }
      return JSON.parse(result.stdout);
    } finally { if (inputPath) rmSync(inputPath, { force: true }); }
  }
  manifestFor(context: EvidenceContext, checkpointId: string, plan = false): Record<string, any> {
    // Return the same in-memory document verified by the canonical provider,
    // rather than rereading a mutable pathname after that verification.
    return this.verifyStored(context, checkpointId, plan, [], true).manifest;
  }
  verifyStored(context: EvidenceContext, checkpointId: string, plan = false, required: string[] = [], includeManifest = false): Record<string, any> {
    this.verifyPin();
    const result = spawnSync(this.pythonCommand, [resolve(dirname(this.helperPath), 'bridge.py'), '--operation', 'verify-stored',
      '--repo', context.repoPath, '--store', this.store, '--workflow-id', 'flow', '--checkpoint-id', checkpointId,
      ...(plan ? ['--plan'] : []), ...(includeManifest ? ['--include-manifest'] : []), ...required.flatMap(gate => ['--require-review', gate])], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 12 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    if (result.error || result.status !== 0) throw new Error(`Stored evidence verification failed: ${result.stderr.trim().slice(-1800)}`);
    return JSON.parse(result.stdout);
  }
  validateMechanical(context: EvidenceContext, checkpointId: string, report: unknown): void {
    this.verifyPin();
    const input = resolve(this.store, `input-${randomUUID()}.json`);
    try {
      writeFileSync(input, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
      const result = spawnSync(this.pythonCommand, [resolve(dirname(this.helperPath), 'bridge.py'),
        '--repo', context.repoPath, '--store', this.store, '--workflow-id', 'flow',
        '--checkpoint-id', checkpointId, '--report', input], { encoding: 'utf8', timeout: 60_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      if (result.error || result.status !== 0) throw new Error(`Mechanical coverage validation failed: ${result.stderr.trim().slice(-1800)}`);
    } finally { rmSync(input, { force: true }); }
  }
  verifyMechanical(context: EvidenceContext, checkpointId: string, evidenceId: string): Record<string, any> {
    this.verifyPin();
    const result = spawnSync(this.pythonCommand, [resolve(dirname(this.helperPath), 'bridge.py'), '--operation', 'verify-mechanical',
      '--repo', context.repoPath, '--store', this.store, '--workflow-id', 'flow', '--checkpoint-id', checkpointId,
      '--evidence-id', evidenceId], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (result.error || result.status !== 0) throw new Error(`Mechanical source verification failed: ${result.stderr.trim().slice(-1800)}`);
    return JSON.parse(result.stdout);
  }
}
