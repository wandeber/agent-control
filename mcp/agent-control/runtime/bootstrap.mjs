import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(packageDir, 'package.json'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

/** Process ownership releases abandoned preparations without expiring a live build. */
export async function withLock(path, action) {
  const token = randomUUID(), deadline = Date.now() + 300_000;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const recovery = path + '.recovery';
  const abandoned = () => {
    try {
      let owner;
      try { owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch {}
      return owner ? !alive(owner.pid) : Date.now() - statSync(path).mtimeMs > 30_000;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  for (;;) {
    if (!existsSync(recovery)) {
      try { mkdirSync(path, { mode: 0o700 }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (abandoned()) {
        // Serialize reapers and reread ownership: a stale observation must never
        // retire a newly acquired lock. This synchronous section contains no I/O children.
        let reaping = false;
        try { mkdirSync(recovery); reaping = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (reaping) {
          try { if (abandoned()) rmSync(path, { recursive: true, force: true }); }
          finally { rmSync(recovery, { recursive: true, force: true }); }
        }
      }
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime preparation: ' + path + ' (check any abandoned recovery guard).');
    await delay(100);
  }
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token }));
  try { return await action(); }
  finally {
    try { if (JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).token === token) rmSync(path, { recursive: true, force: true }); } catch {}
  }
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH } });
  if (result.error || result.status !== 0) throw new Error(`${basename(executable)} ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}, signal ${result.signal}`}`);
  return result;
}
function dependenciesReady() {
  try {
    for (const name of ['better-sqlite3', 'commander', '@modelcontextprotocol/sdk/server/index.js', 'node-gyp/bin/node-gyp.js']) require.resolve(name);
    return true;
  } catch { return false; }
}
function healthy(binding, sqliteRoot) {
  if (!existsSync(binding)) return false;
  // Probe in a fresh process: dlopen caches must not hide a damaged/replaced file.
  const probe = spawnSync(process.execPath, ['-e', `const Database = require(process.argv[1]); const db = new Database(':memory:', {nativeBinding: process.argv[2]}); if(db.prepare('select 1 AS ok').get().ok !== 1) process.exit(1); db.close();`, sqliteRoot, binding], { stdio: 'ignore', timeout: 15_000 });
  return probe.status === 0;
}

export async function ensureRuntime() {
  await withLock(join(packageDir, '.runtime-deps.lock'), async () => {
    if (dependenciesReady()) return;
    // An orphaned PNPM child can only write its own staging tree; it cannot
    // damage the active installation after its bootstrap process is interrupted.
    const stage = mkdtempSync(join(packageDir, '.deps-stage-'));
    try {
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(join(packageDir, name), join(stage, name));
      command('pnpm', ['--dir', stage, 'install', '--frozen-lockfile', '--ignore-scripts'], stage);
      const previous = join(packageDir, '.deps-previous-' + randomUUID());
      if (existsSync(join(packageDir, 'node_modules'))) renameSync(join(packageDir, 'node_modules'), previous);
      renameSync(join(stage, 'node_modules'), join(packageDir, 'node_modules'));
      rmSync(previous, { recursive: true, force: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
    if (!dependenciesReady()) throw new Error('Runtime dependencies are incomplete after installation.');
  });
  const sqliteRoot = dirname(require.resolve('better-sqlite3/package.json'));
  const version = JSON.parse(readFileSync(join(sqliteRoot, 'package.json'), 'utf8')).version;
  const cache = process.env.AGENT_CONTROL_NATIVE_CACHE || join(homedir(), '.cache', 'agent-control', 'native');
  const target = join(cache, 'better-sqlite3', version, `${process.platform}-${process.arch}-${process.versions.modules}`);
  const binding = join(target, 'better_sqlite3.node');
  if (healthy(binding, sqliteRoot)) return binding;
  await withLock(target + '.lock', async () => {
    if (healthy(binding, sqliteRoot)) return;
    const stage = mkdtempSync(join(dirname(target), '.stage-'));
    try {
      const existing = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
      let built = existing;
      if (!healthy(existing, sqliteRoot)) {
        const source = join(stage, 'source');
        cpSync(sqliteRoot, source, { recursive: true, filter: path => !['node_modules', 'build'].includes(basename(path)) });
        symlinkSync(join(packageDir, 'node_modules'), join(source, 'node_modules'), 'dir');
        try { command(process.execPath, [require.resolve('prebuild-install/bin.js', { paths: [sqliteRoot] })], source); }
        catch (prebuildError) {
          // Unsupported prebuild targets still compile using the same Node ABI.
          try { command(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--release'], source); }
          catch (buildError) { throw new Error(prebuildError.message + '\n' + buildError.message); }
        }
        built = join(source, 'build', 'Release', 'better_sqlite3.node');
      }
      const published = join(stage, 'better_sqlite3.node');
      cpSync(built, published);
      if (!healthy(published, sqliteRoot)) throw new Error('Prepared SQLite binding failed its in-memory query.');
      mkdirSync(target, { recursive: true, mode: 0o700 });
      renameSync(published, binding);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
  return binding;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(await ensureRuntime()); }
  catch (error) { process.stderr.write('Agent Control runtime preparation failed: ' + error.message + '\n'); process.exitCode = 1; }
}
