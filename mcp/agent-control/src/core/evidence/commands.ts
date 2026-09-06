import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, delimiter, join, basename } from 'node:path';
import { release, version } from 'node:os';
import { createHash } from 'node:crypto';
import { fingerprint, repositoryPath, sha256 } from './provider.js';
import type { EvidenceContext, ValidationCheck } from './schema.js';

export interface CheckIdentity {
  check_id: string; identity_sha256: string; input_sha256: string;
  mode: 'exact_result' | 'declared_inputs'; volatile: boolean; context_complete: boolean;
  cwd: string; sandbox: 'read_only' | 'workspace';
  verification: { executable: string; argv_sha256: string; environment_names: string[]; configuration_paths: string[];
    toolchain_paths: string[]; input_paths: string[]; portability_key: string | null; scratch: string; timeout_ms: number };
}
export interface CommandReceipt extends CheckIdentity {
  execution_id: string; disposition: 'executed' | 'reused';
  verdict: 'passed' | 'failed' | 'blocked'; exit_status: number | null;
  duration_ms: number; stdout_sha256: string; stderr_sha256: string;
  stdout_bytes: number; stderr_bytes: number; timed_out: boolean;
  source_receipt_id: string | null; source_execution_id: string | null;
  snapshot_sha256: string; diagnostic: string;
  stdout_artifact: string; stderr_artifact: string;
}
export interface PreparedCheck { identity: CheckIdentity; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; check: ValidationCheck; scratch: string; readPaths: string[]; outputDir: string }

function treeIdentity(root: string, input: string, external = false): unknown {
  const path = external ? realpathSync(resolve(root, input)) : repositoryPath(root, input);
  const visit = (entry: string): unknown => {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error('Declared validation inputs cannot contain symlinks.');
    if (stat.isFile()) return { mode: stat.mode & 0o777, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs,
      inode: stat.ino, device: stat.dev, sha256: sha256(readFileSync(entry)) };
    if (!stat.isDirectory()) throw new Error('Declared validation input is not a regular file or directory.');
    return Object.fromEntries(readdirSync(entry).sort().map(name => [name, visit(join(entry, name))]));
  };
  return { path: relative(realpathSync(root), realpathSync(path)), content: visit(path) };
}
function executablePath(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const paths = command.includes('/') ? [resolve(cwd, command)] : (env.PATH ?? '').split(delimiter).map(path => resolve(path, command));
  const candidate = paths.find(path => existsSync(path) && lstatSync(realpathSync(path)).isFile());
  if (!candidate) throw new Error('Validation executable is unavailable.');
  return realpathSync(candidate);
}

export function prepareCheck(context: EvidenceContext, check: ValidationCheck, snapshot: string, executionRoot: string): PreparedCheck {
  const cwd = repositoryPath(context.repoPath, check.cwd);
  if (!lstatSync(cwd).isDirectory()) throw new Error('Validation cwd must be a directory.');
  // Construct the child environment explicitly. Nothing secret is copied into a
  // receipt, including output, argv, or environment values.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', TZ: 'UTC' };
  for (const name of check.environment_names) if (process.env[name] !== undefined) env[name] = process.env[name];
  const executable = executablePath(check.argv[0], cwd, env);
  const argv = [executable, ...check.argv.slice(1)];
  // Selective reuse needs an enforced read boundary. Other platforms/backends
  // retain exact-result reuse until they expose an equivalent isolated root.
  const selective = check.reuse.mode === 'declared_inputs' && check.context_complete && !check.volatile
    && check.sandbox === 'read_only' && process.platform === 'darwin' && readOnlySandboxAvailable();
  const input = selective && check.reuse.mode === 'declared_inputs'
    ? { portability_key: check.reuse.portability_key, inputs: check.reuse.inputs.map(path => treeIdentity(context.repoPath, path)) }
    : { snapshot_sha256: snapshot, repo_path: realpathSync(context.repoPath) };
  const scratch = resolve(executionRoot, 'scratch', fingerprint({ check_id: check.check_id, argv, cwd }));
  Object.assign(env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch });
  const readPaths = [executable, ...check.configuration_paths.map(path => repositoryPath(context.repoPath, path)),
    ...check.toolchain_paths.map(path => realpathSync(resolve(context.repoPath, path))),
    ...(selective && check.reuse.mode === 'declared_inputs' ? check.reuse.inputs.map(path => repositoryPath(context.repoPath, path)) : [])];
  const invocation = { argv_sha256: fingerprint(argv), cwd: relative(realpathSync(context.repoPath), realpathSync(cwd)) || '.',
    executable: treeIdentity(context.repoPath, executable, true), environment: env,
    configuration: check.configuration_paths.map(path => treeIdentity(context.repoPath, path)),
    toolchain: check.toolchain_paths.map(path => treeIdentity(context.repoPath, path, true)),
    platform: { release: release(), version: version(), arch: process.arch, root_entries: selective ? readdirSync('/').sort() : [] },
    sandbox: check.sandbox, read_boundary: selective ? 'declared_inputs' : 'whole_filesystem', timeout_ms: check.timeout_ms,
  };
  return { check, argv, cwd, env, scratch, readPaths, outputDir: resolve(executionRoot, 'outputs'), identity: { check_id: check.check_id,
    identity_sha256: fingerprint(invocation), input_sha256: fingerprint(input),
    mode: selective ? 'declared_inputs' : 'exact_result', volatile: check.volatile,
    context_complete: check.context_complete, cwd: invocation.cwd, sandbox: check.sandbox,
    verification: { executable, argv_sha256: invocation.argv_sha256, environment_names: check.environment_names,
      configuration_paths: check.configuration_paths, toolchain_paths: check.toolchain_paths,
      input_paths: selective && check.reuse.mode === 'declared_inputs' ? check.reuse.inputs : [],
      portability_key: selective && check.reuse.mode === 'declared_inputs' ? check.reuse.portability_key : null,
      scratch, timeout_ms: check.timeout_ms },
  } };
}

export function verifyCurrentCommand(context: EvidenceContext, identity: CheckIdentity, snapshot: string): void {
  const recipe = identity.verification;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', TZ: 'UTC' };
  for (const name of recipe.environment_names) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, { TMPDIR: recipe.scratch, TMP: recipe.scratch, TEMP: recipe.scratch });
  const invocation = { argv_sha256: recipe.argv_sha256, cwd: identity.cwd,
    executable: treeIdentity(context.repoPath, recipe.executable, true), environment: env,
    configuration: recipe.configuration_paths.map(path => treeIdentity(context.repoPath, path)),
    toolchain: recipe.toolchain_paths.map(path => treeIdentity(context.repoPath, path, true)),
    platform: { release: release(), version: version(), arch: process.arch, root_entries: identity.mode === 'declared_inputs' ? readdirSync('/').sort() : [] },
    sandbox: identity.sandbox, read_boundary: identity.mode === 'declared_inputs' ? 'declared_inputs' : 'whole_filesystem', timeout_ms: recipe.timeout_ms,
  };
  const input = identity.mode === 'declared_inputs'
    ? { portability_key: recipe.portability_key, inputs: recipe.input_paths.map(path => treeIdentity(context.repoPath, path)) }
    : { snapshot_sha256: snapshot, repo_path: realpathSync(context.repoPath) };
  if (fingerprint(invocation) !== identity.identity_sha256 || fingerprint(input) !== identity.input_sha256) throw new Error('Command input, toolchain or environment changed after validation.');
}

export function readOnlySandboxAvailable(): boolean {
  return process.platform === 'darwin' ? existsSync('/usr/bin/sandbox-exec')
    : process.platform === 'linux' && ['/usr/bin/bwrap', '/bin/bwrap'].some(existsSync);
}

export async function executeCheck(prepared: PreparedCheck, executionId: string, snapshot: string): Promise<CommandReceipt> {
  const { check, identity, cwd, env } = prepared;
  let argv = prepared.argv;
  const scratch = prepared.scratch;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    if (check.sandbox === 'read_only') {
      if (!readOnlySandboxAvailable()) throw new Error('Read-only command sandbox is unavailable; explicitly choose workspace execution or a supported backend.');
      if (process.platform === 'darwin') {
        const readBoundary = identity.mode === 'declared_inputs'
          ? `(deny file-read*) (allow file-read* (literal "/") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/dev") (subpath "/private/var/db/dyld") (subpath ${JSON.stringify(realpathSync(scratch))}) ${prepared.readPaths.map(path => `(${lstatSync(path).isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(realpathSync(path))})`).join(' ')})`
          : '';
        const profile = `(version 1) (allow default) (deny network*) ${readBoundary} (deny file-write*) (allow file-write* (subpath ${JSON.stringify(realpathSync(scratch))}) (literal "/dev/null"))`;
        argv = ['/usr/bin/sandbox-exec', '-p', profile, ...argv];
      } else {
        const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find(existsSync)!;
        argv = [bwrap, '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--bind', scratch, scratch,
          '--proc', '/proc', '--dev', '/dev', '--chdir', cwd, '--', ...argv];
      }
    }
    const started = Date.now();
    const result = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string; outBytes: number; errBytes: number; outPreview: string; errPreview: string }>((resolveResult, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const out = createHash('sha256'); const err = createHash('sha256');
      let outBytes = 0; let errBytes = 0; let timedOut = false; let outPreview = ''; let errPreview = '';
      child.stdout.on('data', (data: Buffer) => { out.update(data); outBytes += data.length; outPreview = (outPreview + data.toString()).slice(-32_768); });
      child.stderr.on('data', (data: Buffer) => { err.update(data); errBytes += data.length; errPreview = (errPreview + data.toString()).slice(-32_768); });
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, check.timeout_ms);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolveResult({ code, timedOut, stdout: out.digest('hex'), stderr: err.digest('hex'), outBytes, errBytes, outPreview, errPreview }); });
    });
    mkdirSync(prepared.outputDir, { recursive: true, mode: 0o700 });
    const stdoutArtifact = resolve(prepared.outputDir, `${executionId}.stdout.txt`);
    const stderrArtifact = resolve(prepared.outputDir, `${executionId}.stderr.txt`);
    writeFileSync(stdoutArtifact, sanitizeOutput(result.outPreview), { flag: 'wx', mode: 0o600 });
    writeFileSync(stderrArtifact, sanitizeOutput(result.errPreview), { flag: 'wx', mode: 0o600 });
    return { ...identity, execution_id: executionId, disposition: 'executed', verdict: result.code === 0 && !result.timedOut ? 'passed' : 'failed',
      exit_status: result.code, duration_ms: Date.now() - started, stdout_sha256: result.stdout, stderr_sha256: result.stderr,
      stdout_bytes: result.outBytes, stderr_bytes: result.errBytes, timed_out: result.timedOut,
      source_receipt_id: null, source_execution_id: null, snapshot_sha256: snapshot,
      stdout_artifact: stdoutArtifact, stderr_artifact: stderrArtifact,
      diagnostic: result.timedOut ? 'Command timed out; the process group was terminated.' : result.code === 0
        ? 'Command passed.' : `Command exited ${result.code ?? 'without an exit code'}. ${sanitizeOutput(result.errPreview || result.outPreview).slice(-1600)}`,
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function sanitizeOutput(value: string): string {
  let result = value;
  for (const [key, secret] of Object.entries(process.env)) if (secret && secret.length >= 6 && /secret|token|password|credential|api.?key/i.test(key)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Run a declared DAG. Undeclared independence serializes; a shared resource
 * always serializes. Completion is a join over every check, including failures. */
export async function executeCheckGraph<T>(checks: ValidationCheck[], run: (check: ValidationCheck) => Promise<T>): Promise<T[]> {
  const byId = new Map(checks.map(check => [check.check_id, check]));
  if (byId.size !== checks.length) throw new Error('Validation check IDs must be unique.');
  for (const check of checks) if (check.depends_on.some(id => !byId.has(id) || id === check.check_id)) throw new Error('Invalid validation check dependency.');
  const pending = new Set(byId.keys()); const completed = new Map<string, T>();
  while (pending.size) {
    const ready = checks.filter(check => pending.has(check.check_id) && check.depends_on.every(id => completed.has(id)));
    if (!ready.length) throw new Error('Validation check dependencies contain a cycle.');
    const batch: ValidationCheck[] = []; const resources = new Set<string>();
    for (const check of ready) {
      if (batch.length && (!check.independent || !batch[0].independent || check.resources.some(resource => resources.has(resource)))) continue;
      batch.push(check); check.resources.forEach(resource => resources.add(resource));
      if (!check.independent) break;
    }
    // Wait for every launched check even when one fails to spawn. A tool error
    // must never leave unobserved children running after returning to the caller.
    const results = await Promise.allSettled(batch.map(run));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    results.forEach((result, index) => { if (result.status === 'fulfilled') { completed.set(batch[index].check_id, result.value); pending.delete(batch[index].check_id); } });
  }
  return checks.map(check => completed.get(check.check_id)!);
}
