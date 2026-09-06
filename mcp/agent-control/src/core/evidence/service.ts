import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { evidenceContextSchema, evidenceRequestSchema, evidenceReceiptSchema,
  type EvidenceContext, type EvidenceExpectation, type EvidenceReceipt, type EvidenceReceiptKind,
  type EvidenceRequest, type ParsedEvidenceRequest,
} from './schema.js';
import { HdtProvider, fingerprint, immutableJson, privateDirectory, readRegular, repositoryPath, sha256 } from './provider.js';
import { executeCheck, executeCheckGraph, prepareCheck, verifyCurrentCommand, type CommandReceipt } from './commands.js';
import type { CheckIdentity } from './commands.js';

export * from './schema.js';

type ValidationRequest = Extract<ParsedEvidenceRequest, { operation: 'validation_run' }>;
const executionSchema = z.object({
  check_id: z.string(), identity_sha256: z.string().length(64), input_sha256: z.string().length(64),
  mode: z.enum(['exact_result', 'declared_inputs']), volatile: z.boolean(), context_complete: z.boolean(),
  cwd: z.string(), sandbox: z.enum(['read_only', 'workspace']), execution_id: z.string(),
  disposition: z.enum(['executed', 'reused']), verdict: z.enum(['passed', 'failed', 'blocked']), exit_status: z.number().int().nullable(),
  duration_ms: z.number().nonnegative(), stdout_sha256: z.string().length(64), stderr_sha256: z.string().length(64),
  stdout_bytes: z.number().nonnegative(), stderr_bytes: z.number().nonnegative(), timed_out: z.boolean(),
  source_receipt_id: z.string().nullable(), source_execution_id: z.string().nullable(), snapshot_sha256: z.string().length(64), diagnostic: z.string(),
  stdout_artifact: z.string(), stderr_artifact: z.string(),
  verification: z.object({ executable: z.string(), argv_sha256: z.string().length(64), environment_names: z.array(z.string()),
    configuration_paths: z.array(z.string()), toolchain_paths: z.array(z.string()), input_paths: z.array(z.string()), portability_key: z.string().nullable(),
    scratch: z.string(), timeout_ms: z.number().int().positive(),
  }).strict(),
}).strict();

/** Run-owned evidence facade. The canonical helper remains the only authority
 * for plan/result composition, dependency closure, review schemas and closure.
 * The facade adds authenticated provenance and receipts from actual processes. */
export class EvidenceService {
  readonly rootDir: string;
  private readonly pythonCommand?: string;
  constructor(options: { rootDir: string; pythonCommand?: string }) {
    this.rootDir = resolve(options.rootDir);
    this.pythonCommand = options.pythonCommand;
    privateDirectory(this.rootDir);
  }

  private namespace(context: EvidenceContext): string {
    evidenceContextSchema.parse(context);
    const path = resolve(this.rootDir, context.runId, context.flowInstanceId);
    privateDirectory(path);
    return path;
  }
  private provider(context: EvidenceContext): HdtProvider {
    return new HdtProvider(resolve(this.namespace(context), 'provider'), this.pythonCommand);
  }
  private receiptPath(context: EvidenceContext, id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw new Error('Invalid evidence receipt ID.');
    return resolve(this.namespace(context), 'receipts', `${id}.json`);
  }
  private ensureArtifactInput(context: EvidenceContext, input: string): string {
    const path = resolve(context.repoPath, input);
    const real = realpathSync(path);
    const roots = [realpathSync(context.repoPath), realpathSync(dirname(this.rootDir))];
    if (!roots.some(root => { const rel = relative(root, real); return !rel.startsWith('..') && !isAbsolute(rel); })) throw new Error('Artifact input is outside the repository and run storage.');
    readRegular(path);
    return path;
  }
  private checkpointBinding(context: EvidenceContext, checkpointId: string, plan: boolean, create = false): void {
    const path = resolve(this.namespace(context), 'bindings', `${plan ? 'plan' : 'result'}-${checkpointId}.json`);
    const binding = { acceptance_revision: context.acceptanceRevision, plan_revision: context.planRevision };
    if (create) immutableJson(path, binding);
    else if (fingerprint(JSON.parse(readRegular(path).toString())) !== fingerprint(binding)) throw new Error('Checkpoint belongs to an obsolete acceptance or plan revision.');
  }

  private makeReceipt(context: EvidenceContext, provider: HdtProvider, kind: EvidenceReceiptKind,
    status: EvidenceReceipt['status'], payload: Record<string, any>, options: {
      checkpointId?: string; snapshot?: string; sources?: string[]; summary?: EvidenceReceipt['summary']; id?: string;
    } = {}): EvidenceReceipt {
    const record = { schema_version: 1 as const, receipt_id: options.id ?? `ev-${randomUUID()}`, kind, status,
      provider: 'hdt-review-checkpoint' as const, provider_version: provider.manifest.source_version, provider_sha256: provider.manifest.sha256,
      run_id: context.runId, flow_instance_id: context.flowInstanceId, actor_id: context.actorId, actor_role: context.actorRole,
      repo_path: resolve(context.repoPath), acceptance_revision: context.acceptanceRevision, plan_revision: context.planRevision,
      checkpoint_id: options.checkpointId ?? null, snapshot_sha256: options.snapshot ?? null,
      source_receipt_ids: [...new Set(options.sources ?? [])], payload, summary: options.summary ?? {}, created_at: new Date().toISOString(),
    };
    const receipt = evidenceReceiptSchema.parse({ ...record, record_sha256: fingerprint(record) });
    immutableJson(this.receiptPath(context, receipt.receipt_id), receipt);
    if (['plan_review', 'planner_review', 'expert_review'].includes(kind) && receipt.checkpoint_id) {
      immutableJson(this.reviewIndexPath(context, kind, receipt.checkpoint_id), {
        kind, checkpoint_id: receipt.checkpoint_id, receipt_id: receipt.receipt_id,
      });
    }
    return receipt;
  }

  private reviewIndexPath(context: EvidenceContext, kind: EvidenceReceiptKind, checkpointId: string): string {
    return resolve(this.namespace(context), 'review-index', `${kind}-${checkpointId}.json`);
  }

  private findPredecessorReceipt(context: EvidenceContext, kind: EvidenceReceiptKind, checkpointId: string): EvidenceReceipt | undefined {
    const indexPath = this.reviewIndexPath(context, kind, checkpointId);
    if (existsSync(indexPath)) {
      const index = z.object({ kind: z.string(), checkpoint_id: z.string(), receipt_id: z.string() }).strict()
        .parse(JSON.parse(readRegular(indexPath).toString()));
      if (index.kind !== kind || index.checkpoint_id !== checkpointId) throw new Error('Review predecessor index identity is invalid.');
      const receipt = evidenceReceiptSchema.parse(JSON.parse(readRegular(this.receiptPath(context, index.receipt_id)).toString()));
      if (receipt.receipt_id !== index.receipt_id || receipt.kind !== kind || receipt.checkpoint_id !== checkpointId) throw new Error('Review predecessor index does not identify its expected receipt.');
      return receipt;
    }
    // Receipts created before the index existed remain readable. Unrelated
    // malformed files are not prerequisites for this review; selected origins
    // still undergo strict schema, digest, provider and ownership verification.
    const directory = resolve(this.namespace(context), 'receipts');
    if (!existsSync(directory)) return undefined;
    let predecessor: EvidenceReceipt | undefined;
    for (const file of readdirSync(directory)) {
      let candidate: unknown;
      try { candidate = JSON.parse(readRegular(resolve(directory, file)).toString()); } catch { continue; }
      if (!candidate || typeof candidate !== 'object') continue;
      const identity = candidate as Record<string, unknown>;
      if (identity.kind !== kind || identity.checkpoint_id !== checkpointId) continue;
      if (predecessor) throw new Error('Review predecessor receipt is ambiguous; start an explicit fresh full-review lineage.');
      predecessor = evidenceReceiptSchema.parse(candidate);
      if (file !== `${predecessor.receipt_id}.json`) throw new Error('Review predecessor filename does not match its receipt identity.');
    }
    return predecessor;
  }

  async execute(rawContext: EvidenceContext, rawRequest: EvidenceRequest): Promise<EvidenceReceipt> {
    const context = evidenceContextSchema.parse(rawContext);
    const request = evidenceRequestSchema.parse(rawRequest);
    if (request.operation === 'read_receipt') return this.readReceipt(context, request.receipt_id);
    const provider = this.provider(context);
    if (request.operation === 'snapshot_artifact') {
      const path = this.ensureArtifactInput(context, request.path); const bytes = readRegular(path); const hash = sha256(bytes);
      const blob = resolve(this.namespace(context), 'artifacts', hash);
      privateDirectory(dirname(blob));
      if (!existsSync(blob)) writeFileSync(blob, bytes, { flag: 'wx', mode: 0o600 });
      if (sha256(readRegular(blob)) !== hash) throw new Error('Artifact snapshot integrity failure.');
      return this.makeReceipt(context, provider, 'artifact', 'prepared', { path, blob_path: blob, size_bytes: bytes.length }, { snapshot: hash });
    }
    if (request.operation === 'prepare_plan' || request.operation === 'prepare_result') {
      const plan = request.operation === 'prepare_plan';
      const planPath = this.ensureArtifactInput(context, request.plan_path);
      this.assertPlanIdentity(context, sha256(readRegular(planPath)));
      // Revision changes require a new full-review lineage. The helper itself
      // handles content deltas within a lineage, including deletions/restores.
      if (request.previous) {
        const previousPath = resolve(this.namespace(context), 'bindings', `${plan ? 'plan' : 'result'}-${request.previous}.json`);
        const previous = JSON.parse(readRegular(previousPath).toString());
        if (previous.acceptance_revision !== context.acceptanceRevision || (!plan && previous.plan_revision !== context.planRevision)) throw new Error('Changed acceptance or approved plan requires a fresh full-review lineage.');
      }
      const args = ['--checkpoint-id', request.checkpoint_id, '--plan', request.plan_path];
      if (request.previous) args.push('--previous', request.previous);
      if (!plan && request.operation === 'prepare_result') {
        if (request.base) args.push('--base', request.base);
        if (request.all_changes) args.push('--all-changes');
        if (request.isolated_worktree) args.push('--isolated-worktree');
        request.paths?.forEach(path => args.push('--path', path));
      }
      const payload = provider.invoke(context, plan ? 'create-plan' : 'create', args);
      this.assertPlanIdentity(context, payload.plan.sha256);
      payload.draft_contracts = provider.draftContracts(plan);
      this.checkpointBinding(context, request.checkpoint_id, plan, true);
      return this.makeReceipt(context, provider, plan ? 'plan_checkpoint' : 'result_checkpoint', 'prepared', payload,
        { checkpointId: request.checkpoint_id, snapshot: payload.snapshot_sha256 });
    }
    if (request.operation === 'review_scope' || request.operation === 'diff_plan' || request.operation === 'diff_result') {
      const scope = request.operation === 'review_scope';
      const checkpointId = scope ? request.checkpoint_id : request.to_checkpoint_id;
      this.checkpointBinding(context, checkpointId, request.operation === 'diff_plan');
      const args = scope ? ['--checkpoint-id', checkpointId, '--gate', request.gate]
        : ['--from-checkpoint', request.from_checkpoint_id, '--to-checkpoint', checkpointId];
      if (request.include_patches) args.push('--include-patches');
      if (request.operation === 'review_scope') request.surfaces?.forEach(id => args.push('--surface', id));
      if (request.operation === 'diff_plan') request.sections?.forEach(id => args.push('--section', id));
      const payload = provider.invoke(context, scope ? 'review-scope' : request.operation === 'diff_plan' ? 'diff-plan' : 'diff', args);
      payload.draft_contracts = provider.draftContracts(request.operation === 'diff_plan');
      const carried = Object.keys(payload.carry_forward_sections ?? payload.carry_forward_surfaces ?? {});
      const reopened: string[] = payload.required_review_section_ids ?? payload.required_review_surface_ids ?? [];
      return this.makeReceipt(context, provider, scope ? 'review_scope' : request.operation === 'diff_plan' ? 'plan_delta' : 'result_delta', 'prepared', payload,
        { checkpointId, summary: { carried_count: carried.length, carried_scopes: carried.map(label), reopened_count: reopened.length,
          reopened_scopes: reopened.map(key => ({ label: label(key), reason: (payload.reopen_reasons?.[key] ?? ['Changed scope or dependency requires review.']).join(' ') })) } });
    }
    if (request.operation === 'record_plan_review' || request.operation === 'record_review') {
      const plan = request.operation === 'record_plan_review';
      this.checkpointBinding(context, request.checkpoint_id, plan);
      const sources = [...request.source_receipt_ids];
      const manifest = provider.manifestFor(context, request.checkpoint_id, plan);
      this.assertPlanIdentity(context, manifest.plan.sha256);
      const previousId = plan ? manifest.previous_checkpoint : manifest.scope?.previous_checkpoint;
      const kind = plan ? 'plan_review' : request.operation === 'record_review' && request.gate === 'planner' ? 'planner_review' : 'expert_review';
      if (previousId) {
        const previous = this.findPredecessorReceipt(context, kind, previousId);
        if (previous) {
          if (previous.actor_id !== context.actorId) throw new Error('Incremental review requires the same authenticated review owner.');
          sources.push(previous.receipt_id);
        } else {
          const priorProviderReview = resolve(provider.store, 'flow', ...(plan ? ['plan', 'reviews'] : ['reviews', request.operation === 'record_review' ? request.gate : 'planner']), `${previousId}.json`);
          if ((request.draft.coverage_ledger as Record<string, unknown>)?.mode === 'incremental' || existsSync(priorProviderReview)) {
            throw new Error('Review predecessor lacks an authenticated Agent Control receipt; recover with an explicit fresh full-review checkpoint.');
          }
        }
      }
      for (const source of new Set(sources)) this.verifyReviewSource(context, source, previousId, kind);
      const semanticDraft = { ...request.draft };
      if (request.operation === 'record_review' && request.gate === 'planner') {
        const validation = request.source_receipt_ids.map(id => this.verifyReceiptSync(context, id))
          .find(receipt => receipt.kind === 'validation' && receipt.snapshot_sha256 === manifest.snapshot_sha256
            && (receipt.payload.mechanical_report as Record<string, unknown>).validation_mode === 'complete_gate');
        if (!validation) throw new Error('Planner review requires source_receipt_ids containing a complete validation receipt for this exact result.');
        this.verifyReceiptSync(context, validation.receipt_id, { kind: 'validation', requireCurrent: true, requireApproved: true, validationMode: 'complete_gate' });
        const mechanicalDigest = fingerprint(validation.payload.mechanical_report);
        if (semanticDraft.mechanical_validation_report_sha256 !== undefined && semanticDraft.mechanical_validation_report_sha256 !== mechanicalDigest) {
          throw new Error('Planner mechanical report digest contradicts its verified validation source; omit it and let Agent Control compose the binding.');
        }
        semanticDraft.mechanical_validation_report_sha256 = mechanicalDigest;
      }
      const args = ['--checkpoint-id', request.checkpoint_id, '--compose'];
      if (request.operation === 'record_review') args.push('--gate', request.gate);
      const payload = provider.invoke(context, plan ? 'record-plan-review' : 'record-review', args, { flag: '--report', value: semanticDraft });
      return this.makeReceipt(context, provider, kind, payload.verdict === 'approved' ? 'approved' : 'rejected', payload,
        { checkpointId: request.checkpoint_id, snapshot: payload.snapshot_sha256, sources,
          summary: { reviewed_count: payload.reviewed_ids.length, reviewed_scopes: payload.reviewed_ids.map(label),
            carried_count: payload.carried_forward_ids.length, carried_scopes: payload.carried_forward_ids.map(label) } });
    }
    if (request.operation === 'project_plan') {
      this.checkpointBinding(context, request.checkpoint_id, true);
      const args = ['--checkpoint-id', request.checkpoint_id]; request.sections.forEach(section => args.push('--section', section));
      const payload = provider.invoke(context, 'plan-projection', args);
      this.assertPlanIdentity(context, payload.plan_sha256);
      return this.makeReceipt(context, provider, 'plan_projection', 'verified', payload, { checkpointId: request.checkpoint_id });
    }
    if (request.operation === 'validation_run') return this.runValidation(context, provider, request);
    const expert = this.verifyReceiptSync(context, request.expert_receipt_id, { kind: 'expert_review', requireApproved: true, requireCurrent: true });
    const validation = this.verifyReceiptSync(context, request.validation_receipt_id, { kind: 'validation', requireApproved: true, requireCurrent: true });
    if (expert.snapshot_sha256 !== validation.snapshot_sha256) throw new Error('Expert and validation evidence identify different results.');
    const mechanical = validation.payload.mechanical_report;
    const payload = provider.invoke(context, 'verify-closure', ['--expert-checkpoint-id', expert.checkpoint_id!], { flag: '--mechanical-report', value: mechanical });
    return this.makeReceipt(context, provider, 'closure', 'verified', payload, { checkpointId: expert.checkpoint_id!,
      snapshot: expert.snapshot_sha256!, sources: [expert.receipt_id, validation.receipt_id] });
  }

  /** Synchronous by design: transition guards invoke this inside the SQLite
   * transaction immediately before committing progress. No trusted worker flag. */
  verifyReceiptSync(rawContext: EvidenceContext, receiptId: string, expected: EvidenceExpectation = {}): EvidenceReceipt {
    return this.verifyInternal(evidenceContextSchema.parse(rawContext), receiptId, expected, new Set());
  }
  verifyResultManifestSync(rawContext: EvidenceContext, receiptId: string): { receipt: EvidenceReceipt; manifest: Record<string, any> } {
    const context = evidenceContextSchema.parse(rawContext);
    const receipt = this.verifyReceiptSync(context, receiptId, { kind: 'result_checkpoint' });
    const provider = this.provider(context);
    const manifest = provider.manifestFor(context, receipt.checkpoint_id!);
    this.assertPlanIdentity(context, manifest.plan.sha256);
    if (manifest.snapshot_sha256 !== receipt.snapshot_sha256 || manifest.checkpoint_id !== receipt.checkpoint_id) {
      throw new Error('Result receipt does not identify the verified provider manifest.');
    }
    // Package consolidation consumes provider truth, not a projection asserted
    // by the receipt. Rehashing an edited receipt cannot expand reviewed scope,
    // alter deletion/file identities, or relabel the task's original base.
    for (const [key, value] of Object.entries(manifest)) {
      if (!(key in receipt.payload) || fingerprint(receipt.payload[key]) !== fingerprint(value)) {
        throw new Error(`Result receipt payload contradicts the verified provider manifest: ${key}.`);
      }
    }
    provider.invoke(context, 'matches', ['--checkpoint-id', receipt.checkpoint_id!]);
    return { receipt, manifest };
  }
  async verifyReceipt(context: EvidenceContext, receiptId: string, expected: EvidenceExpectation = {}): Promise<EvidenceReceipt> {
    return this.verifyReceiptSync(context, receiptId, expected);
  }
  readReceipt(context: EvidenceContext, receiptId: string): EvidenceReceipt {
    const receipt = evidenceReceiptSchema.parse(JSON.parse(readRegular(this.receiptPath(context, receiptId)).toString()));
    return this.verifyReceiptSync({ ...context, acceptanceRevision: receipt.acceptance_revision, planRevision: receipt.plan_revision }, receiptId);
  }
  private verifyInternal(context: EvidenceContext, receiptId: string, expected: EvidenceExpectation, visiting: Set<string>): EvidenceReceipt {
    if (visiting.has(receiptId)) throw new Error('Evidence source cycle detected.');
    visiting.add(receiptId);
    try {
      const receipt = evidenceReceiptSchema.parse(JSON.parse(readRegular(this.receiptPath(context, receiptId)).toString()));
      const payload = receipt.payload as Record<string, any>;
      const { record_sha256, ...body } = receipt;
      const provider = this.provider(context);
      if (fingerprint(body) !== record_sha256 || receipt.receipt_id !== receiptId || receipt.run_id !== context.runId || receipt.flow_instance_id !== context.flowInstanceId
        || receipt.provider_sha256 !== provider.manifest.sha256) throw new Error('Evidence receipt identity or integrity failed.');
      if (receipt.acceptance_revision !== context.acceptanceRevision || receipt.plan_revision !== context.planRevision) throw new Error('Evidence receipt belongs to an obsolete acceptance or plan revision.');
      if (expected.kind && receipt.kind !== expected.kind) throw new Error('Evidence receipt kind does not satisfy this gate.');
      if (expected.checkpointId && receipt.checkpoint_id !== expected.checkpointId) throw new Error('Evidence receipt checkpoint does not satisfy this gate.');
      if (expected.actorId && receipt.actor_id !== expected.actorId) throw new Error('Evidence receipt author does not own this review.');
      if (expected.requireApproved && !['approved', 'passed', 'verified'].includes(receipt.status)) throw new Error('Evidence receipt has not passed its gate.');
      if (receipt.kind === 'validation') {
        const requiredMode = expected.validationMode ?? (expected.requireApproved ? 'complete_gate' : undefined);
        if (requiredMode && payload.mechanical_report.validation_mode !== requiredMode) {
          throw new Error(requiredMode === 'complete_gate'
            ? 'Focused validation cannot satisfy a complete validation gate.'
            : 'Validation receipt does not satisfy the required focused validation mode.');
        }
      } else if (expected.validationMode) throw new Error('A validation mode requires a validation receipt.');
      const sources = receipt.source_receipt_ids.map(id => {
        if (receipt.kind === 'plan_review') {
          const manifest = provider.manifestFor(context, receipt.checkpoint_id!, true);
          return this.verifyReviewSource(context, id, manifest.previous_checkpoint, receipt.kind, visiting);
        }
        return this.verifyInternal(context, id, {}, visiting);
      });
      if (receipt.kind === 'artifact') {
        if (sha256(readRegular(payload.blob_path)) !== receipt.snapshot_sha256) throw new Error('Artifact snapshot is corrupt.');
        if (expected.requireCurrent && sha256(readRegular(this.ensureArtifactInput(context, payload.path))) !== receipt.snapshot_sha256) throw new Error('Artifact changed after it was captured.');
      }
      const plan = ['plan_checkpoint', 'plan_review', 'plan_projection', 'plan_delta'].includes(receipt.kind);
      if (receipt.checkpoint_id) {
        const args = ['--checkpoint-id', receipt.checkpoint_id];
        if (receipt.kind === 'plan_review' || receipt.kind === 'plan_projection') args.push('--require-review');
        if (receipt.kind === 'expert_review' || receipt.kind === 'planner_review') args.push('--require-review', receipt.kind === 'expert_review' ? 'expert' : 'planner');
        // Rejected reviews remain inspectable; approval enforcement is requested
        // by a gate, not by reading a finding or its predecessor.
        const verifyArgs = receipt.status === 'rejected' ? ['--checkpoint-id', receipt.checkpoint_id] : args;
        const required = verifyArgs.includes('--require-review') ? [plan ? 'plan' : receipt.kind === 'expert_review' ? 'expert' : 'planner'] : [];
        const verified = provider.verifyStored(context, receipt.checkpoint_id, plan, required);
        this.assertPlanIdentity(context, verified.plan_sha256);
        if (receipt.snapshot_sha256 && verified.snapshot_sha256 && verified.snapshot_sha256 !== receipt.snapshot_sha256) throw new Error('Provider checkpoint identity changed.');
        if (expected.requireCurrent) provider.invoke(context, plan ? 'matches-plan' : 'matches', ['--checkpoint-id', receipt.checkpoint_id]);
      }
      if (['plan_review', 'planner_review', 'expert_review'].includes(receipt.kind)) {
        const reviewPath = resolve(provider.store, 'flow', ...(receipt.kind === 'plan_review' ? ['plan', 'reviews'] : ['reviews', receipt.kind === 'expert_review' ? 'expert' : 'planner']), `${receipt.checkpoint_id}.json`);
        const envelope = JSON.parse(readRegular(reviewPath).toString());
        if (envelope.report_sha256 !== receipt.payload.report_sha256 || envelope.snapshot_sha256 !== receipt.snapshot_sha256) throw new Error('Review receipt no longer matches its exact provider record.');
        if (receipt.kind === 'planner_review') {
          const validation = sources.find(source => source.kind === 'validation' && source.snapshot_sha256 === receipt.snapshot_sha256
            && source.status === 'passed' && (source.payload.mechanical_report as Record<string, unknown>).validation_mode === 'complete_gate'
            && fingerprint(source.payload.mechanical_report) === envelope.report.mechanical_validation_report_sha256);
          if (!validation) throw new Error('Planner review does not bind a verified complete mechanical source for its exact result.');
        }
      }
      if (receipt.kind === 'validation') {
        this.verifyValidation(context, receipt, sources, provider);
        if (expected.requireCurrent) for (const record of z.array(executionSchema).parse(payload.executions)) verifyCurrentCommand(context, record, receipt.snapshot_sha256!);
      }
      if (receipt.kind === 'closure') {
        const expert = sources.find(source => source.kind === 'expert_review'); const validation = sources.find(source => source.kind === 'validation');
        if (!expert || expert.status !== 'approved' || !validation || validation.status !== 'passed' || expert.snapshot_sha256 !== validation.snapshot_sha256) throw new Error('Closure sources are missing, stale or not GREEN.');
        if (expected.requireCurrent) for (const record of z.array(executionSchema).parse(validation.payload.executions)) verifyCurrentCommand(context, record, validation.snapshot_sha256!);
        if (expected.requireCurrent) provider.invoke(context, 'verify-closure', ['--expert-checkpoint-id', expert.checkpoint_id!], { flag: '--mechanical-report', value: validation.payload.mechanical_report });
      }
      return receipt;
    } finally { visiting.delete(receiptId); }
  }

  private assertPlanIdentity(context: EvidenceContext, planSha256: unknown): void {
    if (!/^[a-f0-9]{64}$/.test(context.planRevision) || planSha256 !== context.planRevision) {
      throw new Error('Checkpoint plan bytes do not match the controller-bound plan revision.');
    }
  }

  private verifyReviewSource(context: EvidenceContext, id: string, previousId: string | null | undefined, kind: EvidenceReceiptKind, visiting = new Set<string>()): EvidenceReceipt {
    const source = evidenceReceiptSchema.parse(JSON.parse(readRegular(this.receiptPath(context, id)).toString()));
    const isPreviousPlan = kind === 'plan_review' && source.kind === kind && source.checkpoint_id === previousId;
    // A plan successor may consume its predecessor's old plan revision. The
    // link must be explicit in the provider manifest and acceptance stays fixed.
    const originContext = isPreviousPlan ? { ...context, planRevision: source.plan_revision } : context;
    return this.verifyInternal(originContext, id, {}, visiting);
  }

  private verifyValidation(context: EvidenceContext, receipt: EvidenceReceipt, sources: EvidenceReceipt[], provider: HdtProvider): void {
    const payload = receipt.payload as Record<string, any>;
    const records = z.array(executionSchema).parse(payload.executions);
    if (new Set(records.map(record => record.check_id)).size !== records.length) throw new Error('Validation contains duplicate check IDs.');
    for (const record of records) {
      if (record.snapshot_sha256 !== receipt.snapshot_sha256) throw new Error('Command execution belongs to another result.');
      const file = resolve(this.namespace(context), 'executions', `${record.execution_id}.json`);
      if (fingerprint(JSON.parse(readRegular(file).toString())) !== fingerprint(record)) throw new Error('Native command execution record is missing or corrupt.');
      if (record.disposition === 'reused') {
        const origin = sources.find(source => source.receipt_id === record.source_receipt_id && source.kind === 'validation');
        const original = (origin?.payload.executions as CommandReceipt[] | undefined)?.find((item: CommandReceipt) => item.execution_id === record.source_execution_id);
        if (!original || original.verdict !== 'passed' || original.exit_status !== 0 || original.volatile || !original.context_complete
          || original.identity_sha256 !== record.identity_sha256 || original.input_sha256 !== record.input_sha256) throw new Error('Reused command origin does not prove this execution identity.');
      } else if (record.source_receipt_id !== null || record.source_execution_id !== null) throw new Error('Executed command must not claim a reuse origin.');
    }
    if (receipt.status === 'passed' && records.some(record => record.verdict !== 'passed' || record.exit_status !== 0)) throw new Error('Passed validation includes a failed command.');
    if (records.length) {
      const stored = provider.verifyMechanical(context, receipt.checkpoint_id!, payload.provider_mechanical.evidence_id);
      if (stored.report_sha256 !== payload.provider_mechanical.report_sha256) throw new Error('Validation no longer binds its canonical mechanical batch.');
    }
    if (payload.mechanical_report.checks.length !== records.length) throw new Error('Validation coverage and executed command set differ.');
    for (const check of payload.mechanical_report.checks) {
      const record = records.find(item => item.check_id === check.check_id);
      if (!record || check.command !== `sha256:${record.identity_sha256}` || check.exit_status !== record.exit_status || check.verdict !== record.verdict
        || check.disposition !== record.disposition) throw new Error('Mechanical report does not bind its native execution receipt.');
    }
    // Strict coverage is validated by the pinned provider at creation and again
    // here. Reuse origins above are dereferenced, which HDT alone cannot attest.
    this.validateCoverage(provider, context, receipt.checkpoint_id!, payload.mechanical_report);
  }

  private validateCoverage(provider: HdtProvider, context: EvidenceContext, checkpointId: string, mechanical: Record<string, any>): void {
    // Reuse the canonical validator through a small transport bridge. No review
    // or surface semantics are reimplemented in TypeScript.
    provider.verifyStored(context, checkpointId);
    provider.validateMechanical(context, checkpointId, mechanical);
  }

  private async runValidation(context: EvidenceContext, provider: HdtProvider, request: ValidationRequest): Promise<EvidenceReceipt> {
    this.checkpointBinding(context, request.checkpoint_id, false);
    provider.invoke(context, 'matches', ['--checkpoint-id', request.checkpoint_id]);
    const manifest = provider.manifestFor(context, request.checkpoint_id);
    this.assertPlanIdentity(context, manifest.plan.sha256);
    const snapshot = manifest.snapshot_sha256 as string;
    const sources: EvidenceReceipt[] = [];
    // A corrupt candidate is never a hit. Validation still makes progress by
    // executing checks, while closure cannot accept an undereferenced origin.
    for (const id of request.source_receipt_ids) {
      try { const source = this.verifyReceiptSync(context, id, { kind: 'validation' }); if (source.status === 'passed') sources.push(source); } catch { /* Conservative cache miss. */ }
    }
    const receiptId = `ev-${randomUUID()}`;
    const prepared = new Map(request.checks.map(check => [check.check_id, prepareCheck(context, check, snapshot, this.namespace(context))]));
    const candidateIds = sources.flatMap(source => {
      const evidence = source.payload.provider_mechanical as Record<string, any> | undefined;
      return evidence?.evidence_id ? [evidence.evidence_id as string] : [];
    });
    const canonicalHits = new Map<string, string>();
    if (candidateIds.length && request.checks.length) {
      const resolution = provider.invoke(context, 'resolve-mechanical-evidence', ['--checkpoint-id', request.checkpoint_id,
        ...candidateIds.flatMap(id => ['--evidence-id', id])], { flag: '--requirements', value: {
          checks: request.checks.map(check => mechanicalDescriptor(prepared.get(check.check_id)!.identity)),
        } });
      for (const item of resolution.resolutions) if (item.disposition === 'reused') canonicalHits.set(item.check_id, item.source.evidence_id);
    }
    const executions = await executeCheckGraph(request.checks, async check => {
      const input = prepared.get(check.check_id)!;
      const origin = !input.identity.volatile && input.identity.context_complete ? sources.flatMap(source => (source.payload.executions as CommandReceipt[]).map(record => ({ source, record }))).find(({ source, record }) =>
        record.check_id === check.check_id && record.verdict === 'passed' && record.exit_status === 0 && !record.volatile && record.context_complete
        && (input.identity.mode === 'declared_inputs' || canonicalHits.get(check.check_id) === (source.payload.provider_mechanical as Record<string, any> | undefined)?.evidence_id)
        && record.identity_sha256 === input.identity.identity_sha256 && record.input_sha256 === input.identity.input_sha256) : undefined;
      const executionId = `exec-${randomUUID()}`;
      const execution: CommandReceipt = origin ? { ...origin.record, ...input.identity, execution_id: executionId,
        disposition: 'reused', duration_ms: 0, source_receipt_id: origin.source.receipt_id, source_execution_id: origin.record.execution_id,
        snapshot_sha256: snapshot, diagnostic: 'Verified GREEN command receipt reused after exact invocation and input identity matching.',
      } : await executeCheck(input, executionId, snapshot);
      // Check both result and declared identities after execution. Tests that
      // alter source/config/toolchain cannot certify the previous snapshot.
      const after = prepareCheck(context, check, snapshot, this.namespace(context));
      if (fingerprint(after.identity) !== fingerprint(input.identity)) throw new Error('Validation inputs or command context changed during execution.');
      immutableJson(resolve(this.namespace(context), 'executions', `${executionId}.json`), execution);
      return execution;
    });
    provider.invoke(context, 'matches', ['--checkpoint-id', request.checkpoint_id]);
    const passed = executions.every(execution => execution.verdict === 'passed' && execution.exit_status === 0);
    const mechanical = { report_schema_version: 1, checkpoint_id: request.checkpoint_id, task_result_snapshot_sha256: snapshot,
      validation_mode: request.coverage.validation_mode, verdict: passed ? 'passed' : 'failed',
      summary: passed ? 'All declared affected checks are GREEN; executions and reuse origins were verified by Agent Control.' : 'One or more affected checks failed.',
      path_packages: request.coverage.path_packages, surfaces: request.coverage.surfaces,
      checks: executions.map(record => ({ check_id: record.check_id, command: `sha256:${record.identity_sha256}`, cwd: record.cwd,
        disposition: record.disposition, verdict: record.verdict, exit_status: record.exit_status, evidence: [`execution:${record.execution_id}`], skip_reason: null,
        source_identity: record.disposition === 'executed' ? null : { report_reference: record.source_receipt_id, check_id: record.check_id,
          task_result_snapshot_sha256: snapshot, invocation_context: record.identity_sha256 },
      })), required_corrections: passed ? [] : executions.filter(record => record.verdict !== 'passed').map(record => `Resolve failed check ${record.check_id}.`),
    };
    // Validate shape/coverage even for focused or failing batches by checking a
    // GREEN projection. This does not approve the batch; only its actual verdict
    // is persisted. Closure still requires the original complete_gate+GREEN.
    this.validateCoverage(provider, context, request.checkpoint_id, mechanical);
    const canonicalMechanical = executions.length ? provider.invoke(context, 'record-mechanical-evidence', ['--checkpoint-id', request.checkpoint_id, '--evidence-id', receiptId],
      { flag: '--report', value: { schema_version: 1, checkpoint_id: request.checkpoint_id, task_result_snapshot_sha256: snapshot,
        producer: 'mechanical_validation', checks: executions.map(record => ({ ...mechanicalDescriptor(record),
          volatile: record.volatile || !record.context_complete, verdict: record.verdict, exit_status: record.exit_status,
          evidence: [`native-execution:${record.execution_id}`],
        })),
      } }) : null;
    const usedSources = [...new Set(executions.flatMap(record => record.source_receipt_id ? [record.source_receipt_id] : []))];
    return this.makeReceipt(context, provider, 'validation', passed ? 'passed' : 'failed', { executions, mechanical_report: mechanical, provider_mechanical: canonicalMechanical }, {
      id: receiptId, checkpointId: request.checkpoint_id, snapshot, sources: usedSources,
      summary: { executed_check_count: executions.filter(record => record.disposition === 'executed').length,
        reused_check_count: executions.filter(record => record.disposition === 'reused').length,
        executed_checks: executions.filter(record => record.disposition === 'executed').map(record => label(record.check_id)),
        reused_checks: executions.filter(record => record.disposition === 'reused').map(record => label(record.check_id)),
        reason: request.coverage.validation_mode === 'focused' ? 'Focused validation; a complete affected gate is still required before closure.' : undefined,
      },
    });
  }
}

function label(value: string): string { return value.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120); }

function mechanicalDescriptor(identity: CheckIdentity): Record<string, unknown> {
  // Actual argv/environment are already controller-attested by this identity.
  // The helper stores only the opaque descriptor hash, avoiding secret-bearing
  // commands in durable reports while retaining its exact-result reuse rules.
  return { check_id: identity.check_id, invocation: { kind: 'argv', argv: [`native-context:${identity.identity_sha256}`] },
    cwd: identity.cwd, configuration: { input_sha256: identity.input_sha256 }, toolchain: { context_sha256: identity.identity_sha256 },
    environment: { context_sha256: identity.identity_sha256 },
  };
}
