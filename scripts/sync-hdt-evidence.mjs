#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// The upstream helper is an authority, not a fork. Updating it is an explicit
// packaging action and ordinary builds only verify the pinned bytes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'mcp/agent-control/vendor/hdt');
const manifestPath = resolve(target, 'provider.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex !== -1) {
  const checkout = resolve(process.argv[sourceIndex + 1]);
  const sourcePath = 'plugins/development-workflow/skills/handle-development-task/scripts/review_checkpoint.py';
  const bytes = readFileSync(resolve(checkout, sourcePath));
  const version = JSON.parse(readFileSync(resolve(checkout, 'plugins/development-workflow/.codex-plugin/plugin.json'), 'utf8')).version;
  const skill = 'plugins/development-workflow/skills/handle-development-task';
  const companions = {
    'contracts/strict-review.md': `${skill}/references/workflow/contracts/strict-review.md`,
    'contracts/plan-intent-review.md': `${skill}/references/workflow/contracts/plan-intent-review.md`,
    'contracts/mechanical-validation.md': `${skill}/references/workflow/contracts/mechanical-validation.md`,
    'contracts/incremental-review.md': `${skill}/references/workflow/handoffs/incremental-review.md`,
    'tests/test_review_checkpoint.py': `${skill}/scripts/tests/test_review_checkpoint.py`,
  };
  mkdirSync(target, { recursive: true });
  if (process.argv.includes('--check')) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (sha(bytes) !== manifest.sha256 || version !== manifest.source_version) throw new Error('Pinned HDT provider differs from canonical source.');
    for (const [path, source] of Object.entries(companions)) if (sha(readFileSync(resolve(checkout, source))) !== manifest.companions[path].sha256) throw new Error(`Canonical companion differs: ${path}`);
  } else {
    writeFileSync(resolve(target, 'review_checkpoint.py'), bytes);
    const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const companionManifest = {};
    for (const [path, source] of Object.entries(companions)) { const content = readFileSync(resolve(checkout, source)); mkdirSync(dirname(resolve(target, path)), { recursive: true }); writeFileSync(resolve(target, path), content); companionManifest[path] = { source_path: source, sha256: sha(content) }; }
    writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, provider: 'hdt-review-checkpoint', source_repository: 'https://github.com/wandeber/agent-settings', source_path: sourcePath, source_version: version, source_commit: commit, sha256: sha(bytes), companions: companionManifest }, null, 2) + '\n');
  }
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (sha(readFileSync(resolve(target, 'review_checkpoint.py'))) !== manifest.sha256) throw new Error('Pinned HDT provider digest mismatch.');
for (const [path, entry] of Object.entries(manifest.companions ?? {})) if (sha(readFileSync(resolve(target, path))) !== entry.sha256) throw new Error(`Pinned HDT companion digest mismatch: ${path}`);
process.stdout.write(`HDT provider ${manifest.source_version}: verified ${manifest.sha256}\n`);
