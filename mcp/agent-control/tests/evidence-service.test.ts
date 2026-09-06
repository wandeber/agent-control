import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceService, type EvidenceContext, type EvidenceReceipt, type EvidenceRequest } from '../src/core/evidence/service.js';
import { validationCheckSchema, evidenceRequestJsonSchema } from '../src/core/evidence/schema.js';
import { executeCheckGraph, prepareCheck, readOnlySandboxAvailable } from '../src/core/evidence/commands.js';
import { fingerprint, sha256 } from '../src/core/evidence/provider.js';

let root: string; let repo: string; let context: EvidenceContext; let service: EvidenceService;
function write(path: string, content: string) { writeFileSync(join(repo, path), content); }
function payload(receipt: EvidenceReceipt): Record<string, any> { return receipt.payload; }
async function result(id = 'result-1', previous?: string) {
  return service.execute(context, { operation: 'prepare_result', checkpoint_id: id, plan_path: 'plan.md', paths: ['value.txt'], previous });
}
function draft(paths = ['value.txt']): Record<string, unknown> {
  return { verdict: 'approved', summary: 'Reviewed every affected result path and its behavior.',
    blocking_findings: [], non_blocking_findings: [], required_corrections: [], prior_finding_results: [],
    recommended_next_phase: 'closure', recommended_rollback_phase: null,
    coverage_ledger: { mode: 'full', surfaces: { package: { paths, disposition: 'reviewed', status: 'validated', depends_on: [],
      invariants: ['The result implements the approved behavior.'], finding_ids: [] } }, surface_transitions: [], limitations: [] },
    impact_analysis: null, safe_to_close: true,
  };
}
function validation(checkpointId = 'result-1', sources: string[] = [], code = 'process.stdout.write("passed")'): EvidenceRequest {
  return { operation: 'validation_run', checkpoint_id: checkpointId,
    checks: [{ check_id: 'unit', argv: [process.execPath, '-e', code], sandbox: 'workspace', volatile: false, context_complete: true }],
    coverage: { validation_mode: 'complete_gate', path_packages: { 'value.txt': 'package' }, surfaces: [{ surface_id: 'package', kind: 'package', check_ids: ['unit'], no_applicable_checks_reason: null }] },
    source_receipt_ids: sources,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac-evidence-')); repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Evidence test']);
  write('plan.md', '# Plan\n\nIntro.\n\n<!-- hdt-section: work -->\n## Work\n\nOriginal.\n\n<!-- hdt-section: notes -->\n## Notes\n\nStable.\n');
  write('value.txt', 'before\n'); write('unrelated.txt', 'unrelated\n');
  execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  write('value.txt', 'after\n');
  context = { runId: 'run-test', flowInstanceId: 'flow-test', repoPath: repo, actorId: 'expert-1', actorRole: 'expert', acceptanceRevision: 'accepted-1', planRevision: sha256(readFileSync(join(repo, 'plan.md'))) };
  service = new EvidenceService({ rootDir: join(root, 'run', 'evidence') });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('run-owned canonical evidence', () => {
  it('composes strict review, executes once, reuses once and closes against actual GREEN evidence', async () => {
    await result();
    const first = await service.execute(context, validation());
    const second = await service.execute(context, validation('result-1', [first.receipt_id]));
    expect(first.summary.executed_check_count).toBe(1);
    expect(second.summary.reused_check_count).toBe(1);
    expect(second.summary.executed_check_count).toBe(0);
    const expert = await service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'expert', draft: draft() });
    expect(expert.status).toBe('approved');
    const closure = await service.execute(context, { operation: 'verify_closure', expert_receipt_id: expert.receipt_id, validation_receipt_id: second.receipt_id });
    expect(closure.status).toBe('verified');
    expect(service.verifyReceiptSync(context, closure.receipt_id, { requireCurrent: true }).status).toBe('verified');
    write('value.txt', 'drift\n');
    expect(() => service.verifyReceiptSync(context, closure.receipt_id, { requireCurrent: true })).toThrow(/failed|drift/i);
  }, 30_000);

  it('rejects claims, missing coverage, forged kinds, wrong actors and stale revisions', async () => {
    await result();
    await expect(service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'expert', draft: { verdict: 'approved' } })).rejects.toThrow();
    const complete = validation() as Extract<EvidenceRequest, { operation: 'validation_run' }>;
    complete.coverage.path_packages = {};
    await expect(service.execute(context, complete)).rejects.toThrow(/coverage|Closure|path/i);
    const receipt = await service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'expert', draft: draft() });
    expect(() => service.verifyReceiptSync(context, receipt.receipt_id, { actorId: 'different-owner' })).toThrow(/author/);
    expect(() => service.verifyReceiptSync({ ...context, acceptanceRevision: 'changed' }, receipt.receipt_id)).toThrow(/obsolete/);
    expect(() => service.verifyReceiptSync(context, receipt.receipt_id, { kind: 'validation' })).toThrow(/kind/);
  }, 30_000);

  it('resolves every reuse origin even when the final receipt remains intact', async () => {
    await result();
    const first = await service.execute(context, validation());
    const second = await service.execute(context, validation('result-1', [first.receipt_id]));
    const stored = join(root, 'run/evidence/run-test/flow-test/receipts', `${first.receipt_id}.json`);
    rmSync(stored);
    expect(() => service.verifyReceiptSync(context, second.receipt_id)).toThrow();
    const third = await service.execute(context, validation('result-1', [second.receipt_id]));
    expect(third.summary.executed_check_count).toBe(1);
    expect(third.source_receipt_ids).toEqual([]);
  }, 30_000);

  it('retains inspectable evidence after the worktree is removed, but refuses a current gate', async () => {
    await result();
    const expert = await service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'expert', draft: draft() });
    rmSync(repo, { recursive: true });
    expect(service.verifyReceiptSync(context, expert.receipt_id).status).toBe('approved');
    expect(() => service.verifyReceiptSync(context, expert.receipt_id, { requireCurrent: true })).toThrow();
  });

  it('reuses closed plan sections across a real plan revision, with authenticated predecessor lineage', async () => {
    const first = await service.execute(context, { operation: 'prepare_plan', checkpoint_id: 'plan-1', plan_path: 'plan.md' });
    const records = Object.fromEntries(Object.keys(payload(first).sections).map(id => [id, { disposition: 'reviewed', status: 'validated', depends_on: [], invariants: [`Reviewed ${id}.`] }]));
    const review = await service.execute(context, { operation: 'record_plan_review', checkpoint_id: 'plan-1', draft: { verdict: 'approved', coverage_ledger: { mode: 'full', sections: records, deleted_section_ids_reviewed: [], limitations: [] } } });
    write('plan.md', readFileSync(join(repo, 'plan.md'), 'utf8').replace('Original.', 'Corrected.'));
    context = { ...context, planRevision: sha256(readFileSync(join(repo, 'plan.md'))) };
    await service.execute(context, { operation: 'prepare_plan', checkpoint_id: 'plan-2', plan_path: 'plan.md', previous: 'plan-1' });
    const delta = await service.execute(context, { operation: 'diff_plan', from_checkpoint_id: 'plan-1', to_checkpoint_id: 'plan-2' });
    const direct = Object.fromEntries(payload(delta).required_review_section_ids.map((id: string) => [id, records[id]]));
    const second = await service.execute(context, { operation: 'record_plan_review', checkpoint_id: 'plan-2', draft: { verdict: 'approved', coverage_ledger: { mode: 'incremental', sections: direct, deleted_section_ids_reviewed: [], limitations: [] }, impact_analysis: { summary: 'Work changed, notes remain independent.', additionally_affected_section_ids: [] } } });
    expect(second.summary.carried_scopes).toEqual(['notes']);
    expect(second.source_receipt_ids).toContain(review.receipt_id);
    expect(service.verifyReceiptSync(context, second.receipt_id, { requireCurrent: true, requireApproved: true }).status).toBe('approved');
    const projection = await service.execute(context, { operation: 'project_plan', checkpoint_id: 'plan-2', sections: ['work'] });
    expect(payload(projection).sections[0].content).toContain('Corrected.');
    expect(JSON.stringify(payload(projection).sections)).not.toContain('Stable.');
  }, 30_000);

  it('does not transfer incremental validation to a silently replaced reviewer', async () => {
    await result();
    await service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'expert', draft: draft() });
    write('value.txt', 'correction\n'); await result('result-2', 'result-1');
    await expect(service.execute({ ...context, actorId: 'replacement' }, { operation: 'record_review', checkpoint_id: 'result-2', gate: 'expert', draft: draft() })).rejects.toThrow(/same authenticated/);
  });

  it('rejects plan B under the controller-bound digest of plan A before creating evidence', async () => {
    write('different-plan.md', '# Different approved behavior\n');
    await expect(service.execute(context, { operation: 'prepare_plan', checkpoint_id: 'wrong-plan', plan_path: 'different-plan.md' })).rejects.toThrow(/controller-bound plan revision/);
    await expect(service.execute(context, { operation: 'prepare_result', checkpoint_id: 'wrong-result', plan_path: 'different-plan.md', paths: ['value.txt'] })).rejects.toThrow(/controller-bound plan revision/);
    expect(existsSync(join(root, 'run/evidence/run-test/flow-test/provider/flow/plan/checkpoints/wrong-plan.json'))).toBe(false);
    const plan = await service.execute(context, { operation: 'prepare_plan', checkpoint_id: 'right-plan', plan_path: 'plan.md' });
    // A relabelled receipt with an otherwise correct digest still cannot turn
    // the provider's immutable plan A into a checkpoint for plan B.
    const forged = { ...plan, plan_revision: sha256(readFileSync(join(repo, 'different-plan.md'))) };
    const { record_sha256: _oldDigest, ...body } = forged;
    forged.record_sha256 = fingerprint(body);
    writeFileSync(join(root, 'run/evidence/run-test/flow-test/receipts', `${plan.receipt_id}.json`), JSON.stringify(forged));
    expect(() => service.verifyReceiptSync({ ...context, planRevision: forged.plan_revision }, plan.receipt_id)).toThrow(/controller-bound plan revision/);
  });

  it('composes the planner mechanical binding only from an explicit verified current complete receipt', async () => {
    await result();
    const plannerDraft: Record<string, unknown> = { ...draft(), recommended_next_phase: 'post_planner_choice' };
    delete plannerDraft.safe_to_close;
    await expect(service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'planner', draft: plannerDraft })).rejects.toThrow(/source_receipt_ids/);
    const checks = await service.execute(context, validation());
    await expect(service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'planner',
      draft: { ...plannerDraft, mechanical_validation_report_sha256: 'a'.repeat(64) }, source_receipt_ids: [checks.receipt_id] })).rejects.toThrow(/contradicts/);
    const review = await service.execute(context, { operation: 'record_review', checkpoint_id: 'result-1', gate: 'planner',
      draft: plannerDraft, source_receipt_ids: [checks.receipt_id] });
    const report = JSON.parse(readFileSync(payload(review).record_path, 'utf8')).report;
    expect(report.mechanical_validation_report_sha256).toBe(fingerprint(payload(checks).mechanical_report));
    expect(service.verifyReceiptSync(context, review.receipt_id, { kind: 'planner_review', requireApproved: true, requireCurrent: true }).status).toBe('approved');
    write('value.txt', 'correction\n'); await result('result-2', 'result-1');
    await expect(service.execute(context, { operation: 'record_review', checkpoint_id: 'result-2', gate: 'planner',
      draft: plannerDraft, source_receipt_ids: [checks.receipt_id] })).rejects.toThrow(/exact result/);
  }, 30_000);

  it('reruns volatile or incomplete contexts and preserves actionable redacted failures', async () => {
    await result();
    const first = await service.execute(context, validation());
    const volatile = validation('result-1', [first.receipt_id]) as Extract<EvidenceRequest, { operation: 'validation_run' }>;
    volatile.checks[0].volatile = true;
    const second = await service.execute(context, volatile);
    expect(second.summary.executed_check_count).toBe(1);
    const failure = await service.execute(context, validation('result-1', [], 'console.error("Expected 3 but got 2; token=very-secret-value"); process.exit(1)'));
    const execution = payload(failure).executions[0];
    expect(failure.status).toBe('failed');
    expect(execution.diagnostic).toContain('Expected 3 but got 2');
    expect(execution.diagnostic).not.toContain('very-secret-value');
    expect(readFileSync(execution.stderr_artifact, 'utf8')).toContain('[REDACTED]');
    expect(() => service.verifyReceiptSync(context, failure.receipt_id, { requireApproved: true })).toThrow(/not passed/);
  }, 30_000);

  it('keeps focused evidence available for reuse but prevents it satisfying the complete gate', async () => {
    await result();
    const input = validation() as Extract<EvidenceRequest, { operation: 'validation_run' }>;
    input.coverage.validation_mode = 'focused';
    const focused = await service.execute(context, input);
    expect(() => service.verifyReceiptSync(context, focused.receipt_id, { requireApproved: true })).toThrow(/Focused/);
    expect(service.verifyReceiptSync(context, focused.receipt_id, {
      kind: 'validation', requireApproved: true, requireCurrent: true, validationMode: 'focused',
    }).status).toBe('passed');
    expect(() => service.verifyReceiptSync(context, focused.receipt_id, {
      requireApproved: true, validationMode: 'complete_gate',
    })).toThrow(/Focused/);
    const full = await service.execute(context, validation('result-1', [focused.receipt_id]));
    expect(full.summary.reused_check_count).toBe(1);
    expect(service.verifyReceiptSync(context, full.receipt_id, { requireApproved: true }).status).toBe('passed');
    expect(service.verifyReceiptSync(context, full.receipt_id, {
      kind: 'validation', requireApproved: true, requireCurrent: true, validationMode: 'complete_gate',
    }).status).toBe('passed');
    expect(() => service.verifyReceiptSync(context, full.receipt_id, {
      requireApproved: true, validationMode: 'focused',
    })).toThrow(/required focused/);
  }, 30_000);

  it('rechecks actual environment identity at the final transition guard', async () => {
    await result();
    const input = validation() as Extract<EvidenceRequest, { operation: 'validation_run' }>;
    input.checks[0].environment_names = ['AC_EVIDENCE_TEST_VALUE'];
    process.env.AC_EVIDENCE_TEST_VALUE = 'first';
    try {
      const receipt = await service.execute(context, input);
      expect(service.verifyReceiptSync(context, receipt.receipt_id, { requireCurrent: true }).status).toBe('passed');
      process.env.AC_EVIDENCE_TEST_VALUE = 'changed';
      expect(() => service.verifyReceiptSync(context, receipt.receipt_id, { requireCurrent: true })).toThrow(/environment changed/);
      input.source_receipt_ids = [receipt.receipt_id];
      expect((await service.execute(context, input)).summary.executed_check_count).toBe(1);
    } finally { delete process.env.AC_EVIDENCE_TEST_VALUE; }
  }, 30_000);

  it('rejects a corrupt canonical origin even when native receipt JSON remains intact', async () => {
    await result();
    const first = await service.execute(context, validation());
    const second = await service.execute(context, validation('result-1', [first.receipt_id]));
    const source = payload(first).provider_mechanical.record_path;
    writeFileSync(source, '{}');
    expect(() => service.verifyReceiptSync(context, second.receipt_id)).toThrow(/source|mechanical/i);
  }, 30_000);

  it('reads historical receipts without turning them into current approval', async () => {
    const first = await service.execute(context, { operation: 'prepare_plan', checkpoint_id: 'plan-1', plan_path: 'plan.md' });
    const changed = { ...context, acceptanceRevision: 'new-acceptance' };
    expect((await service.execute(changed, { operation: 'read_receipt', receipt_id: first.receipt_id })).acceptance_revision).toBe('accepted-1');
    expect(() => service.verifyReceiptSync(changed, first.receipt_id)).toThrow(/obsolete/);
  });

  it('falls back to exact result when selective reuse cannot enforce input reads', async () => {
    const check = validationCheckSchema.parse({ check_id: 'unit', argv: [process.execPath, '-e', '0'], sandbox: 'workspace', volatile: false, context_complete: true,
      reuse: { mode: 'declared_inputs', inputs: ['value.txt'], complete: true, portability_key: 'project-test' } });
    const identity = prepareCheck(context, check, 'a'.repeat(64), join(root, 'execution')).identity;
    expect(identity.mode).toBe('exact_result');
    write('value.txt', 'changed');
    expect(prepareCheck(context, check, 'b'.repeat(64), join(root, 'execution')).identity.input_sha256).not.toBe(identity.input_sha256);
  });

  it.skipIf(process.platform !== 'darwin' || !readOnlySandboxAvailable())('denies undeclared reads and writes under enforced selective validation', async () => {
    await result();
    const base = validation() as Extract<EvidenceRequest, { operation: 'validation_run' }>;
    base.checks = [{ check_id: 'unit', argv: ['/bin/cat', 'unrelated.txt'], sandbox: 'read_only', context_complete: true, volatile: false,
      reuse: { mode: 'declared_inputs', inputs: ['value.txt'], complete: true, portability_key: 'test' } }];
    const denied = await service.execute(context, base);
    expect(denied.status).toBe('failed');
    expect(payload(denied).executions[0].diagnostic).toMatch(/permitted|denied/i);
    base.checks[0].argv = ['/bin/cat', 'value.txt'];
    const allowed = await service.execute(context, base);
    expect(allowed.status).toBe('passed');
    const before = payload(allowed).executions[0].input_sha256;
    write('unrelated.txt', 'different unrelated input\n'); await result('unrelated-change', 'result-1');
    base.checkpoint_id = 'unrelated-change'; base.source_receipt_ids = [allowed.receipt_id];
    const preserved = await service.execute(context, base);
    expect(preserved.summary.reused_check_count).toBe(1);
    base.checks[0].argv = ['/bin/sh', '-c', 'echo bad > value.txt'];
    const writeDenied = await service.execute(context, base);
    expect(writeDenied.status).toBe('failed');
    expect(readFileSync(join(repo, 'value.txt'), 'utf8')).toBe('after\n');
    base.checks[0].argv = ['/bin/cat', 'value.txt'];
    write('value.txt', 'changed\n'); await result('result-2', 'result-1');
    base.checkpoint_id = 'result-2'; base.source_receipt_ids = [allowed.receipt_id];
    const changed = await service.execute(context, base);
    expect(changed.summary.executed_check_count).toBe(1);
    expect(payload(changed).executions[0].input_sha256).not.toBe(before);
  }, 30_000);
});

describe('validation DAG join', () => {
  it('publishes operation-specific discovery from the validated schema without dangling references', () => {
    const schema = JSON.stringify(evidenceRequestJsonSchema);
    expect(schema).toContain('record_plan_review');
    expect(schema).toContain('read_receipt');
    expect(schema).toContain('configuration_paths');
    expect(schema).not.toContain('"$ref"');
  });
  it('runs only declared independent disjoint resources concurrently and joins every result', async () => {
    const checks = ['a', 'b', 'c'].map(id => validationCheckSchema.parse({ check_id: id, argv: ['true'], independent: true,
      resources: id === 'c' ? ['a-resource'] : [`${id}-resource`] }));
    let active = 0; let max = 0; const order: string[] = [];
    const results = await executeCheckGraph(checks, async check => { active++; max = Math.max(max, active); order.push(`start:${check.check_id}`);
      await new Promise(resolve => setTimeout(resolve, 15)); active--; order.push(`end:${check.check_id}`); return check.check_id; });
    expect(results).toEqual(['a', 'b', 'c']); expect(max).toBe(2);
    expect(order.indexOf('start:c')).toBeGreaterThan(order.indexOf('end:a'));
    expect(active).toBe(0);
  });
  it('serializes undeclared independence and rejects dependency cycles', async () => {
    const a = validationCheckSchema.parse({ check_id: 'a', argv: ['true'] });
    const b = validationCheckSchema.parse({ check_id: 'b', argv: ['true'], depends_on: ['a'] });
    expect(await executeCheckGraph([a, b], async check => check.check_id)).toEqual(['a', 'b']);
    await expect(executeCheckGraph([{ ...a, depends_on: ['b'] }, b], async check => check.check_id)).rejects.toThrow(/cycle/);
  });
});
