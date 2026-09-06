import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.unknown());
const checkpoint = { checkpoint_id: id };

export const evidenceContextSchema = z.object({
  runId: id, flowInstanceId: id, repoPath: z.string().min(1),
  actorId: z.string().min(1), actorRole: z.string().min(1),
  acceptanceRevision: z.string().min(1), planRevision: z.string().min(1),
}).strict();
export type EvidenceContext = z.infer<typeof evidenceContextSchema>;

// These declarations describe semantic scope. Identity is computed from actual
// files and the actual child environment, never accepted as a worker's hash.
export const validationCheckSchema = z.object({
  check_id: id, argv: z.array(z.string()).min(1).max(256), cwd: z.string().default('.'),
  timeout_ms: z.number().int().min(1).max(3_600_000).default(1_800_000),
  environment_names: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  configuration_paths: z.array(z.string()).default([]),
  toolchain_paths: z.array(z.string()).default([]),
  context_complete: z.boolean().default(false), volatile: z.boolean().default(true),
  depends_on: z.array(id).default([]),
  independent: z.boolean().default(false), resources: z.array(z.string().min(1)).default([]),
  sandbox: z.enum(['read_only', 'workspace']).default('read_only'),
  reuse: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('exact_result') }).strict(),
    z.object({ mode: z.literal('declared_inputs'), inputs: z.array(z.string()).min(1),
      complete: z.literal(true), portability_key: z.string().min(1),
    }).strict(),
  ]).default({ mode: 'exact_result' }),
}).strict();
export type ValidationCheck = z.infer<typeof validationCheckSchema>;

export const validationCoverageSchema = z.object({
  validation_mode: z.enum(['focused', 'complete_gate']),
  path_packages: z.record(id),
  surfaces: z.array(z.object({
    surface_id: id, kind: z.enum(['package', 'consumer', 'mandatory', 'material_risk']),
    check_ids: z.array(id), no_applicable_checks_reason: z.string().min(1).nullable(),
  }).strict()).min(1),
}).strict();

export const evidenceRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read_receipt'), receipt_id: id }).strict(),
  z.object({ operation: z.literal('snapshot_artifact'), path: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('prepare_plan'), ...checkpoint, plan_path: z.string().min(1), previous: id.optional() }).strict(),
  z.object({ operation: z.literal('prepare_result'), ...checkpoint, plan_path: z.string().min(1),
    previous: id.optional(), base: z.string().min(1).optional(), paths: z.array(z.string()).min(1).optional(),
    all_changes: z.boolean().default(false), isolated_worktree: z.boolean().default(false),
  }).strict(),
  z.object({ operation: z.literal('review_scope'), ...checkpoint, gate: z.literal('planner'),
    surfaces: z.array(id).optional(), include_patches: z.boolean().default(false),
  }).strict(),
  z.object({ operation: z.literal('diff_plan'), from_checkpoint_id: id, to_checkpoint_id: id,
    sections: z.array(z.string()).optional(), include_patches: z.boolean().default(false),
  }).strict(),
  z.object({ operation: z.literal('diff_result'), from_checkpoint_id: id, to_checkpoint_id: id,
    include_patches: z.boolean().default(false),
  }).strict(),
  // The provider, not this adapter, is the sole strict authority for nested
  // semantic drafts. Unknown keys or forged carried-forward records fail there.
  z.object({ operation: z.literal('record_plan_review'), ...checkpoint, draft: jsonObject,
    source_receipt_ids: z.array(id).default([]),
  }).strict(),
  z.object({ operation: z.literal('record_review'), ...checkpoint, gate: z.enum(['planner', 'expert']),
    draft: jsonObject, source_receipt_ids: z.array(id).default([]),
  }).strict(),
  z.object({ operation: z.literal('project_plan'), ...checkpoint, sections: z.array(z.string()).min(1) }).strict(),
  z.object({ operation: z.literal('validation_run'), ...checkpoint, checks: z.array(validationCheckSchema),
    coverage: validationCoverageSchema, source_receipt_ids: z.array(id).default([]),
  }).strict(),
  z.object({ operation: z.literal('verify_closure'), expert_receipt_id: id, validation_receipt_id: id }).strict(),
]);
export type EvidenceRequest = z.input<typeof evidenceRequestSchema>;
export type ParsedEvidenceRequest = z.output<typeof evidenceRequestSchema>;

// Generate discovery from the same operation schema used for validation. Inline
// local references so this schema can be embedded under any MCP argument name.
const requestSchemaDocument = toJsonSchemaCompat(z.object({ request: evidenceRequestSchema }));
function inlineSchemaReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inlineSchemaReferences);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string' && object.$ref.startsWith('#/')) {
      let target: unknown = requestSchemaDocument;
      for (const part of object.$ref.slice(2).split('/')) target = (target as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      return inlineSchemaReferences(target);
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, inlineSchemaReferences(child)]));
  }
  return value;
}
export const evidenceRequestJsonSchema = inlineSchemaReferences((requestSchemaDocument.properties as Record<string, unknown>).request) as Record<string, unknown>;

export const evidenceReceiptKindSchema = z.enum(['artifact', 'plan_checkpoint', 'result_checkpoint',
  'review_scope', 'plan_delta', 'result_delta', 'plan_review', 'planner_review', 'expert_review',
  'plan_projection', 'validation', 'closure']);
export type EvidenceReceiptKind = z.infer<typeof evidenceReceiptKindSchema>;
export const evidenceReceiptSchema = z.object({
  schema_version: z.literal(1), receipt_id: id, kind: evidenceReceiptKindSchema,
  status: z.enum(['prepared', 'approved', 'rejected', 'passed', 'failed', 'verified']),
  provider: z.literal('hdt-review-checkpoint'), provider_version: z.string(), provider_sha256: digest,
  run_id: id, flow_instance_id: id, actor_id: z.string(), actor_role: z.string(), repo_path: z.string(),
  acceptance_revision: z.string(), plan_revision: z.string(),
  checkpoint_id: id.nullable(), snapshot_sha256: digest.nullable(),
  source_receipt_ids: z.array(id), payload: jsonObject,
  summary: z.object({ reviewed_count: z.number().optional(), carried_count: z.number().optional(),
    reopened_count: z.number().optional(), executed_check_count: z.number().optional(),
    reused_check_count: z.number().optional(), reason: z.string().optional(),
    reviewed_scopes: z.array(z.string()).optional(), carried_scopes: z.array(z.string()).optional(),
    reopened_scopes: z.array(z.object({ label: z.string(), reason: z.string() }).strict()).optional(),
    reused_checks: z.array(z.string()).optional(), executed_checks: z.array(z.string()).optional(),
  }).strict(), created_at: z.string(), record_sha256: digest,
}).strict();
export type EvidenceReceipt = z.infer<typeof evidenceReceiptSchema>;
export interface EvidenceExpectation {
  kind?: EvidenceReceiptKind;
  checkpointId?: string;
  requireCurrent?: boolean;
  requireApproved?: boolean;
  validationMode?: 'focused' | 'complete_gate';
  actorId?: string;
}
