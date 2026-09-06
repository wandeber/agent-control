import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ControllerError } from "./errors.js";
import { artifactDigest, digest, type FlowRuntime } from "./flow-runtime.js";
import type { AgentRecord, FlowConfig } from "./types.js";
import type { EvidenceReceipt } from "./evidence/service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
export const workPackageSchema = z.object({ id, title: z.string().min(1), role: z.string().min(1), worktree: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1), deliverables: z.array(z.string().min(1)).min(1),
  depends_on: z.array(id).default([]), required: z.boolean().default(true) }).strict();
export const flowPackagesRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("define"), packages: z.array(workPackageSchema) }).strict(),
  z.object({ operation: z.literal("launch") }).strict(),
  z.object({ operation: z.literal("deliver"), package_id: id, attempt: z.number().int().positive(), summary: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("accept"), deliveries: z.array(z.object({ package_id: id, delivery_id: z.string().min(1) }).strict()).min(1), reason: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("retry"), package_id: id, attempt: z.number().int().positive(), reason: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("cancel"), package_id: id, attempt: z.number().int().positive(), reason: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("integrate"), result_receipt_id: z.string().min(1) }).strict(),
]);
export type FlowPackagesRequest = z.input<typeof flowPackagesRequestSchema>;
export type WorkPackage = z.output<typeof workPackageSchema>;
const schemaDocument = toJsonSchemaCompat(z.object({ request: flowPackagesRequestSchema }));
function inlineRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inlineRefs);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
      let target: unknown = schemaDocument;
      for (const part of record.$ref.slice(2).split("/")) target = (target as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      return inlineRefs(target);
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, inlineRefs(child)]));
  }
  return value;
}
export const flowPackagesRequestJsonSchema = inlineRefs((schemaDocument.properties as Record<string, unknown>).request) as Record<string, unknown>;
export interface PackageFile { path: string; sha256: string | null; mode: number | null; snapshot_path?: string }
export interface PackageDelivery { delivery_id: string; package_id: string; attempt: number; actor_id: string; work_generation: number;
  manifest_digest: string; plan_revision: string; acceptance_revision: number; source_delivery_ids: string[]; summary: string; files: PackageFile[]; record_sha256: string; path: string }
export interface PackageBranch { step_id?: string; parent_agent_id?: string; attempt: number; agent_id?: string; state: "pending" | "invoking" | "running" | "delivered" | "accepted" | "failed" | "cancelled" | "uncertain";
  launch_settled?: boolean; prior_start_event_id?: string | null; dependency_delivery_ids?: string[]; launch_lease_expires_at?: string; work_generation?: number; delivery?: PackageDelivery; acceptance?: { actor_id: string; reason: string }; reason?: string; prior_attempts?: PackageBranch[] }
export interface PackageGroup { manifest: WorkPackage[]; manifest_digest: string; base_commit: string; repository_identity: string;
  plan_revision: string; acceptance_revision: number; branches: Record<string, PackageBranch>;
  integration?: { receipt_id: string; result_receipt_id: string; result_snapshot_sha256: string; delivery_ids: string[]; manifest_digest: string; record_sha256: string; path: string } }
export interface PackageContext { flowId: string; runId: string; repo: string; root: string; planPath: string; planRevision: string; acceptanceRevision: number;
  stepId: string | null; parentAgentId: string; policy: NonNullable<NonNullable<FlowConfig["policy"]>["work_packages"]>; config: FlowConfig; approval?: { value: unknown; acceptance_revision: number; artifact_digest?: string; package_manifest_digest?: string } }
export interface PackageHost {
  store: SqliteStore; runtime: FlowRuntime;
  context(id: string, verifyPlan?: boolean): PackageContext;
  authorize(id: string, purpose: "define" | "manage" | "deliver" | "integrate", agentId?: string): string;
  register(context: PackageContext, entry: WorkPackage): AgentRecord;
  start(context: PackageContext, entry: WorkPackage, branch: PackageBranch): Promise<AgentRecord>;
  agent(id: string): AgentRecord;
  refresh(id: string): Promise<AgentRecord>;
  stop(id: string): Promise<unknown>;
  verifyResult(context: PackageContext, id: string): { receipt: EvidenceReceipt; manifest: Record<string, unknown> };
  emit(context: PackageContext, reason: string, detail: Record<string, unknown>): void;
}
const terminal = (agent: AgentRecord) => ["completed", "failed", "stopped"].includes(agent.status) || Boolean(agent.unregistered_at);
function fail(message: string): never { throw new ControllerError(message, "tool_error"); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trimEnd(); }
function scoped(path: string, prefix: string): boolean { return path === prefix || path.startsWith(`${prefix}/`); }
function normalizePath(path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(p => p === ".." || p === "." || p === "") || path === ".git" || path.startsWith(".git/")) fail("Package paths must be literal repository-relative paths without traversal or Git metadata.");
  return path;
}
function regular(root: string, path: string): string {
  const absolute = resolve(root, path); let cursor = absolute;
  while (cursor !== root) {
    try { if (lstatSync(cursor).isSymbolicLink()) fail("Package files and path ancestors must not be symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    cursor = dirname(cursor);
  }
  return absolute;
}
function repositoryIdentity(repo: string): string { return realpathSync(resolve(repo, git(repo, "rev-parse", "--git-common-dir"))); }

/** Package state is in the same flow transaction/history as its approved plan.
 * Backend I/O is deliberately outside transactions and claimed exactly once. */
export class FlowPackages {
  constructor(private host: PackageHost) {}
  private state(id: string) { const state = this.host.runtime.get(id); if (!state) fail("Flow runtime is missing."); return state; }
  private save(context: PackageContext, group: PackageGroup) { const state = this.state(context.flowId); state.packages = group; state.revision++; this.host.runtime.save(context.flowId, state); }
  group(id: string): PackageGroup { return this.state(id).packages ?? fail("Define the package manifest before exact plan approval."); }
  private current(context: PackageContext): PackageGroup {
    const group = this.group(context.flowId);
    if (group.manifest_digest !== digest({ packages: group.manifest, plan_revision: group.plan_revision, acceptance_revision: group.acceptance_revision, base_commit: group.base_commit, repository_identity: group.repository_identity })) fail("Package manifest integrity failed.");
    if (group.plan_revision !== context.planRevision || group.acceptance_revision !== context.acceptanceRevision) fail("Package group belongs to an obsolete plan or acceptance revision.");
    if (repositoryIdentity(context.repo) !== group.repository_identity) fail("The package group's repository identity changed.");
    return group;
  }
  private approved(context: PackageContext): PackageGroup {
    const group = this.current(context); const approval = context.approval;
    if (!approval || approval.value !== (context.policy.approval_value ?? "approved") || approval.acceptance_revision !== group.acceptance_revision || approval.artifact_digest !== group.plan_revision || approval.package_manifest_digest !== group.manifest_digest) fail("Package execution requires exact approval of this plan and package manifest.");
    return group;
  }
  private entry(group: PackageGroup, id: string) { return group.manifest.find(item => item.id === id) ?? fail("Unknown work package."); }
  private verifyWorktree(context: PackageContext, group: PackageGroup, entry: WorkPackage) {
    const registered = git(context.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
    if (!registered.includes(entry.worktree) || realpathSync(entry.worktree) !== entry.worktree || realpathSync(git(entry.worktree, "rev-parse", "--show-toplevel")) !== entry.worktree || repositoryIdentity(entry.worktree) !== group.repository_identity) fail("The assigned Git worktree identity changed.");
    // The exact base remains pinned even when the worker creates commits.
    git(entry.worktree, "cat-file", "-e", `${group.base_commit}^{commit}`);
  }
  private capture(context: PackageContext, group: PackageGroup, entry: WorkPackage, snapshots: boolean): PackageFile[] {
    this.verifyWorktree(context, group, entry);
    const changed = [...git(entry.worktree, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", group.base_commit, "--").split("\0"), ...git(entry.worktree, "ls-files", "--others", "--exclude-standard", "-z").split("\0")].filter(Boolean);
    for (const path of changed) if (!entry.paths.some(prefix => scoped(path, prefix))) fail(`Package ${entry.id} changed a path outside its approved scope: ${path}`);
    for (const path of entry.deliverables) if (!existsSync(regular(entry.worktree, path))) {
      // An expected removal is an immutable delivery too. A typo that was
      // absent from the pinned base must not masquerade as a successful delete.
      if (!changed.includes(path)) fail(`Required package delivery is missing: ${path}`);
      try { git(entry.worktree, "cat-file", "-e", `${group.base_commit}:${path}`); }
      catch { fail(`Required package delivery is missing: ${path}`); }
    }
    const files = [...new Set([...changed, ...entry.deliverables])].sort().map(path => {
      normalizePath(path); const absolute = regular(entry.worktree, path);
      if (!existsSync(absolute)) return { path, sha256: null, mode: null };
      const stat = lstatSync(absolute); if (!stat.isFile()) fail("Package deliveries must be regular files; submodules and directories need explicit file deliveries.");
      const sha256 = artifactDigest(absolute); const mode = stat.mode & 0o100 ? 0o755 : 0o644;
      const snapshotPath = resolve(context.root, "blobs", sha256);
      if (snapshots) { mkdirSync(dirname(snapshotPath), { recursive: true }); if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, readFileSync(absolute), { flag: "wx", mode: 0o444 }); if (artifactDigest(snapshotPath) !== sha256) fail("Package artifact snapshot integrity failed."); }
      return { path, sha256, mode, ...(snapshots ? { snapshot_path: snapshotPath } : {}) };
    });
    return files;
  }
  private verifyDelivery(context: PackageContext, group: PackageGroup, entry: WorkPackage, branch: PackageBranch) {
    const dependencies = entry.depends_on.map(id => {
      const source = group.branches[id];
      if (source?.state !== "accepted" || !source.delivery) fail("Package delivery depends on an unaccepted or cancelled source.");
      return source.delivery.delivery_id;
    }).sort();
    if (digest(dependencies) !== digest(branch.dependency_delivery_ids ?? [])) fail("Package dependency deliveries changed after this generation started.");
    const delivery = branch.delivery ?? fail("A required package delivery is missing.");
    const { path, record_sha256, ...body } = delivery;
    if (digest(body) !== record_sha256 || digest(JSON.parse(readFileSync(path, "utf8"))) !== record_sha256) fail("Package delivery record integrity failed.");
    if (delivery.actor_id !== branch.agent_id || delivery.attempt !== branch.attempt || delivery.work_generation !== branch.work_generation || delivery.manifest_digest !== group.manifest_digest || delivery.plan_revision !== context.planRevision || delivery.acceptance_revision !== context.acceptanceRevision || digest(delivery.source_delivery_ids) !== digest(dependencies)) fail("Package delivery belongs to a stale owner, generation or plan.");
    for (const file of delivery.files) if (file.sha256 && (!file.snapshot_path || artifactDigest(file.snapshot_path) !== file.sha256)) fail("Package artifact snapshot integrity failed.");
    if (!branch.agent_id || this.host.agent(branch.agent_id).work_generation !== branch.work_generation) fail("Package owner advanced to a different work generation.");
    const current = this.capture(context, group, entry, false);
    if (digest(current) !== digest(delivery.files.map(({ snapshot_path: _, ...file }) => file))) fail("Package worktree changed after its immutable delivery.");
    return delivery;
  }
  condition(id: string) { const state = this.state(id); const group = state.packages; let joined = false; let integrated = false;
    try { const context = this.host.context(id); this.assertJoin(context); joined = true; this.assertIntegrated(context); integrated = true; } catch { /* A guard is false until every required proof is current. */ }
    return { joined, integrated, manifest_digest: group?.manifest_digest ?? null, integration_required: Boolean(group?.manifest.length), required_count: group?.manifest.filter(p => p.required).length ?? 0 }; }
  approval(context: PackageContext, manifestDigest: string | undefined) {
    const group = this.current(context);
    if (!manifestDigest || manifestDigest !== group.manifest_digest) fail("Exact plan approval must include the displayed package manifest digest.");
    return group.manifest_digest;
  }
  assertJoin(context: PackageContext): PackageGroup {
    const group = this.approved(context);
    for (const entry of group.manifest) {
      const branch = group.branches[entry.id]!;
      const agent = branch.agent_id ? this.host.agent(branch.agent_id) : null;
      if (agent && (!branch.launch_settled || !terminal(agent))) fail(`Package join is waiting for inactive workers: ${entry.id}`);
      if (entry.required && (branch.state !== "accepted" || !agent || agent.status !== "completed" || agent.unregistered_at)) fail(`Package join requires an accepted delivery from every required branch: ${entry.id}`);
      if (branch.state === "accepted") this.verifyDelivery(context, group, entry, branch);
    }
    return group;
  }
  assertIntegrated(context: PackageContext) {
    const group = this.assertJoin(context); if (!group.manifest.length) return;
    const integration = group.integration ?? fail("Consolidation requires a verified package integration receipt.");
    const { path, record_sha256, ...body } = integration;
    if (digest(body) !== record_sha256 || digest(JSON.parse(readFileSync(path, "utf8"))) !== record_sha256) fail("Package integration receipt integrity failed.");
    const { receipt, manifest } = this.host.verifyResult(context, integration.result_receipt_id);
    const deliveries = Object.values(group.branches).filter(b => b.state === "accepted").map(b => b.delivery!.delivery_id).sort();
    if (receipt.snapshot_sha256 !== integration.result_snapshot_sha256 || digest(deliveries) !== digest(integration.delivery_ids) || integration.manifest_digest !== group.manifest_digest) fail("Package integration is stale.");
    this.verifyConsolidation(context, group);
    this.verifyCheckpointCoverage(group, manifest);
  }
  private verifyCheckpointCoverage(group: PackageGroup, manifest: Record<string, unknown>) {
    if (manifest.base_commit !== group.base_commit) fail("Integration checkpoint must use the package group base commit.");
    const files = manifest.files as Record<string, { kind?: string; mode?: string | null; sha256?: string | null }> | undefined;
    for (const branch of Object.values(group.branches).filter(item => item.state === "accepted")) for (const file of branch.delivery!.files) {
      const captured = files?.[file.path];
      if (!captured || (file.sha256 === null ? captured.kind !== "deleted" || captured.sha256 !== null || captured.mode !== null : captured.kind !== "file" || captured.sha256 !== file.sha256 || captured.mode !== (file.mode === 0o755 ? "100755" : "100644"))) fail(`Integration checkpoint omits or differs from an accepted delivery: ${file.path}`);
    }
  }
  private verifyConsolidation(context: PackageContext, group: PackageGroup) {
    for (const branch of Object.values(group.branches).filter(b => b.state === "accepted")) for (const file of branch.delivery!.files) {
      const target = regular(context.repo, file.path);
      if (file.sha256 === null ? existsSync(target) : !existsSync(target) || !lstatSync(target).isFile() || artifactDigest(target) !== file.sha256 || (lstatSync(target).mode & 0o100 ? 0o755 : 0o644) !== file.mode) fail(`Consolidated result does not contain the accepted delivery: ${file.path}`);
    }
  }
  async execute(flowId: string, raw: FlowPackagesRequest): Promise<PackageGroup> {
    const request = flowPackagesRequestSchema.parse(raw); const context = this.host.context(flowId, request.operation !== "cancel");
    if (request.operation === "define") return this.host.store.immediateTransaction(() => {
      this.host.authorize(flowId, "define");
      if (context.stepId !== context.policy.manifest_step && context.config.steps[context.stepId ?? ""]?.decision?.key !== context.policy.approval_decision) fail("Package scope must be registered during manifest review or exact plan approval.");
      const previous = this.state(flowId).packages;
      const manifest = request.packages.map(entry => ({ ...entry, worktree: realpathSync(entry.worktree), paths: entry.paths.map(normalizePath).sort(), deliverables: entry.deliverables.map(normalizePath).sort(), depends_on: [...entry.depends_on].sort() })).sort((a,b) => a.id.localeCompare(b.id));
      const common = repositoryIdentity(context.repo); const base = git(context.repo, "rev-parse", "HEAD");
      const manifestDigest = digest({ packages: manifest, plan_revision: context.planRevision, acceptance_revision: context.acceptanceRevision, base_commit: base, repository_identity: common });
      if (previous?.manifest_digest === manifestDigest) return previous;
      if (previous && context.approval?.package_manifest_digest === previous.manifest_digest && previous.plan_revision === context.planRevision && previous.acceptance_revision === context.acceptanceRevision) fail("Approved package scope is immutable; revise the plan before changing it.");
      if (previous && Object.values(previous.branches).some(b => b.agent_id && !terminal(this.host.agent(b.agent_id)))) fail("Cancel and settle existing package workers before replacing the manifest.");
      const ids = new Set(manifest.map(p => p.id)); if (ids.size !== manifest.length) fail("Duplicate package IDs are not allowed.");
      const registered = git(context.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
      const roots = new Set<string>(); const paths: string[] = [];
      for (const entry of manifest) {
        if (!registered.includes(entry.worktree) || entry.worktree === realpathSync(context.repo) || roots.has(entry.worktree) || realpathSync(git(entry.worktree, "rev-parse", "--show-toplevel")) !== entry.worktree || repositoryIdentity(entry.worktree) !== common || git(entry.worktree, "rev-parse", "HEAD") !== base) fail("Each package needs a distinct Git worktree of the same repository at the approved base commit.");
        if (git(entry.worktree, "status", "--porcelain", "--untracked-files=all")) fail("Package worktrees must be clean when the manifest is defined.");
        if (context.config.roles?.[entry.role]?.backend !== "codex-thread") fail("Package workers require an explicitly configured codex-thread role.");
        roots.add(entry.worktree);
        for (const path of entry.paths) { if (paths.some(prior => scoped(path, prior) || scoped(prior, path))) fail("Parallel package write paths must be disjoint."); paths.push(path); }
        if (entry.deliverables.some(path => !entry.paths.some(prefix => scoped(path, prefix)))) fail("Package deliverables must be inside its approved write scope.");
        if (entry.depends_on.some(dep => !ids.has(dep) || dep === entry.id)) fail("Package dependencies must name other declared packages.");
      }
      const visited = new Set<string>(); const visiting = new Set<string>(); const visit = (id: string) => { if (visiting.has(id)) fail("Package dependency cycle."); if (visited.has(id)) return; visiting.add(id); for (const dep of manifest.find(p => p.id === id)!.depends_on) visit(dep); visiting.delete(id); visited.add(id); }; for (const id of ids) visit(id);
      const group: PackageGroup = { manifest, manifest_digest: manifestDigest, base_commit: base, repository_identity: common, plan_revision: context.planRevision, acceptance_revision: context.acceptanceRevision, branches: Object.fromEntries(manifest.map(entry => [entry.id, { attempt: 1, state: "pending" as const }])) };
      this.save(context, group); this.host.emit(context, "packages_defined", { manifest_digest: manifestDigest, package_count: manifest.length }); return group;
    });
    if (request.operation === "launch") { this.host.authorize(flowId, "manage"); return this.launch(context); }
    if (request.operation === "deliver") return this.host.store.immediateTransaction(() => {
      const group = this.approved(context); const entry = this.entry(group, request.package_id); const branch = group.branches[entry.id]!;
      const actor = this.host.authorize(flowId, "deliver", branch.agent_id);
      if (context.stepId !== context.policy.execution_step || request.attempt !== branch.attempt || actor !== branch.agent_id) fail("Package delivery belongs to an obsolete branch generation.");
      const agent = this.host.agent(actor); if (!branch.launch_settled || agent.unregistered_at || agent.work_generation !== branch.work_generation || ["failed", "stopped"].includes(agent.status) || !["running", "delivered", "accepted"].includes(branch.state)) fail("Package owner or work generation is no longer eligible to deliver.");
      const files = this.capture(context, group, entry, true);
      const body = { delivery_id: `package-${digest({ id: entry.id, attempt: branch.attempt, manifest: group.manifest_digest }).slice(0,32)}`, package_id: entry.id, attempt: branch.attempt, actor_id: actor, work_generation: agent.work_generation, manifest_digest: group.manifest_digest, plan_revision: context.planRevision, acceptance_revision: context.acceptanceRevision, source_delivery_ids: branch.dependency_delivery_ids ?? [], summary: request.summary, files };
      const record = digest(body); if (branch.delivery) { if (branch.delivery.record_sha256 !== record) fail("A conflicting immutable delivery already exists for this attempt."); this.verifyDelivery(context, group, entry, branch); return group; }
      const path = resolve(context.root, "deliveries", `${body.delivery_id}.json`); mkdirSync(dirname(path), { recursive: true }); if (!existsSync(path)) writeFileSync(path, JSON.stringify(body), { flag: "wx", mode: 0o444 });
      if (digest(JSON.parse(readFileSync(path, "utf8"))) !== record) fail("Conflicting durable package delivery record.");
      branch.delivery = { ...body, record_sha256: record, path }; branch.state = "delivered";
      this.host.store.createArtifact({ runId: context.runId, agentId: actor, label: `Package ${entry.id} delivery`, path });
      this.save(context, group); this.host.emit(context, "package_delivered", { package_id: entry.id, attempt: branch.attempt, delivery_id: body.delivery_id }); return group;
    });
    this.host.authorize(flowId, request.operation === "integrate" ? "integrate" : "manage");
    if (request.operation === "accept") {
      for (const item of request.deliveries) { const branch = this.group(flowId).branches[item.package_id]; if (branch?.agent_id) await this.host.refresh(branch.agent_id); }
      this.host.store.immediateTransaction(() => {
        const group = this.approved(this.host.context(flowId)); if (context.stepId !== context.policy.execution_step) fail("Package acceptance belongs to the execution phase.");
        const actor = this.host.authorize(flowId, "manage"); let changed = false;
        for (const item of request.deliveries) {
          const entry = this.entry(group, item.package_id); const branch = group.branches[entry.id]!;
          if (!branch.launch_settled || !branch.agent_id || this.host.agent(branch.agent_id).status !== "completed" || this.host.agent(branch.agent_id).unregistered_at || !["delivered", "accepted"].includes(branch.state) || branch.delivery?.delivery_id !== item.delivery_id) fail("Only a delivered, inactive successful branch can be accepted.");
          this.verifyDelivery(context, group, entry, branch);
          if (branch.state === "accepted" && (branch.acceptance?.actor_id !== actor || branch.acceptance.reason !== request.reason)) fail("A conflicting package acceptance already exists.");
          changed ||= branch.state !== "accepted"; branch.state = "accepted"; branch.acceptance ??= { actor_id: actor, reason: request.reason };
        }
        if (changed) { this.save(context, group); this.host.emit(context, "packages_accepted", { package_ids: request.deliveries.map(item => item.package_id) }); }
      });
      return this.launch(this.host.context(flowId));
    }
    if (request.operation === "cancel") {
      const cancelled = this.host.store.immediateTransaction(() => {
        const group = this.group(flowId); const branch = group.branches[request.package_id] ?? fail("Unknown work package.");
        if (request.attempt !== branch.attempt) fail("Cancellation targets an obsolete package attempt.");
        const ids = this.dependentClosure(group, request.package_id);
        let changed = false;
        for (const id of ids) { const current = group.branches[id]!; if (current.state !== "cancelled") { current.state = "cancelled"; current.reason = id === request.package_id ? request.reason : `Dependency ${request.package_id} cancelled: ${request.reason}`; changed = true; } }
        if (changed) { delete group.integration; this.save(context, group); }
        return ids.map(id => ({ id, agent_id: group.branches[id]!.agent_id }));
      });
      for (const item of cancelled) if (item.agent_id && !terminal(this.host.agent(item.agent_id))) await this.host.stop(item.agent_id);
      this.host.emit(context, "package_cancelled", { package_id: request.package_id, attempt: request.attempt, cancelled_packages: cancelled.map(item => item.id) }); return this.group(flowId);
    }
    if (request.operation === "retry") {
      if (context.stepId !== context.policy.execution_step) fail("Package retry belongs to the execution phase.");
      const group = this.approved(context); const branch = group.branches[request.package_id] ?? fail("Unknown work package.");
      if (request.attempt !== branch.attempt) { if (branch.attempt === request.attempt + 1 && branch.reason === request.reason) return this.launch(context); fail("Retry targets an obsolete package attempt."); }
      for (const id of this.dependentClosure(group, request.package_id)) { const agentId = group.branches[id]!.agent_id; if (agentId) await this.host.refresh(agentId); }
      this.host.store.immediateTransaction(() => {
        const current = this.approved(this.host.context(flowId)); const previous = current.branches[request.package_id]!;
        if (previous.attempt !== request.attempt) fail("Package generation changed during retry.");
        if (!["failed", "cancelled", "uncertain", "accepted", "delivered"].includes(previous.state)) fail("Retry requires an unsuccessful or previously delivered package.");
        const ids = this.dependentClosure(current, request.package_id);
        for (const id of ids) { const prior = current.branches[id]!; if (prior.agent_id && (!prior.launch_settled || !terminal(this.host.agent(prior.agent_id)))) fail("Cancel and settle dependent workers before retrying their source package."); }
        for (const id of ids) {
          const prior = current.branches[id]!;
          if (id !== request.package_id && prior.state === "pending") continue;
          current.branches[id] = { attempt: prior.attempt + 1, state: "pending", ...(prior.agent_id && ["completed", "failed"].includes(this.host.agent(prior.agent_id).status) && !this.host.agent(prior.agent_id).unregistered_at ? { agent_id: prior.agent_id } : {}), reason: id === request.package_id ? request.reason : `Dependency ${request.package_id} changed: ${request.reason}`, prior_attempts: [...(prior.prior_attempts ?? []), { ...prior, prior_attempts: undefined }] };
        }
        delete current.integration; this.save(context, current);
      }); return this.launch(this.host.context(flowId));
    }
    return this.host.store.immediateTransaction(() => {
      if (context.stepId !== context.policy.integration_step) fail("Package integration belongs to its configured integration phase.");
      const group = this.assertJoin(context); const { receipt, manifest } = this.host.verifyResult(context, request.result_receipt_id);
      this.verifyConsolidation(context, group);
      this.verifyCheckpointCoverage(group, manifest);
      const deliveryIds = Object.values(group.branches).filter(b => b.state === "accepted").map(b => b.delivery!.delivery_id).sort();
      const body = { receipt_id: `integration-${digest({ manifest: group.manifest_digest, deliveries: deliveryIds, result: receipt.receipt_id }).slice(0,32)}`, result_receipt_id: receipt.receipt_id, result_snapshot_sha256: receipt.snapshot_sha256!, delivery_ids: deliveryIds, manifest_digest: group.manifest_digest };
      const record = digest(body); if (group.integration?.record_sha256 === record) { this.assertIntegrated(context); return group; }
      const path = resolve(context.root, "integrations", `${body.receipt_id}.json`); mkdirSync(dirname(path), { recursive: true }); if (!existsSync(path)) writeFileSync(path, JSON.stringify(body), { flag: "wx", mode: 0o444 });
      if (digest(JSON.parse(readFileSync(path, "utf8"))) !== record) fail("Conflicting durable package integration record.");
      group.integration = { ...body, record_sha256: record, path }; this.save(context, group); this.host.emit(context, "packages_integrated", { receipt_id: body.receipt_id, delivery_ids: deliveryIds }); return group;
    });
  }
  private dependentClosure(group: PackageGroup, packageId: string): string[] {
    const ids = new Set([packageId]);
    for (let changed = true; changed;) { changed = false; for (const entry of group.manifest) if (!ids.has(entry.id) && entry.depends_on.some(dep => ids.has(dep))) { ids.add(entry.id); changed = true; } }
    return [...ids];
  }
  private async launch(context: PackageContext): Promise<PackageGroup> {
    const ready = this.host.store.immediateTransaction(() => {
      const group = this.approved(this.host.context(context.flowId));
      if (context.stepId !== context.policy.execution_step) fail("Package launch belongs to the execution phase.");
      const selected: Array<{ entry: WorkPackage; branch: PackageBranch }> = []; let changed = false;
      for (const entry of group.manifest) {
        const branch = group.branches[entry.id]!;
        if (branch.state === "invoking") { const agent = branch.agent_id && this.host.agent(branch.agent_id); if (agent && agent.backend_handle && agent.work_generation !== branch.work_generation && this.host.store.listEvents({ agentId: agent.agent_id, type: "agent.started", limit: 1 })[0]?.event_id && this.host.store.listEvents({ agentId: agent.agent_id, type: "agent.started", limit: 1 })[0]!.event_id !== branch.prior_start_event_id) { branch.state = "running"; branch.launch_settled = true; branch.work_generation = agent.work_generation; changed = true; } else if (!branch.launch_lease_expires_at || Date.parse(branch.launch_lease_expires_at) <= Date.now()) { branch.state = "uncertain"; branch.reason = "Interrupted launch has no durable backend handle; do not repeat uncertain work."; changed = true; } }
        if (branch.state !== "pending" || !entry.depends_on.every(dep => group.branches[dep]?.state === "accepted")) continue;
        this.verifyWorktree(context, group, entry);
        for (const dependency of entry.depends_on) this.verifyDelivery(context, group, this.entry(group, dependency), group.branches[dependency]!);
        const agent = branch.agent_id ? this.host.agent(branch.agent_id) : this.host.register(context, entry); branch.agent_id = agent.agent_id; branch.parent_agent_id = context.parentAgentId; branch.step_id = context.policy.execution_step; branch.prior_start_event_id = this.host.store.listEvents({ agentId: agent.agent_id, type: "agent.started", limit: 1 })[0]?.event_id ?? null; branch.work_generation = agent.work_generation; branch.dependency_delivery_ids = entry.depends_on.map(id => group.branches[id]!.delivery!.delivery_id).sort(); branch.state = "invoking"; branch.launch_settled = false; branch.launch_lease_expires_at = new Date(Date.now() + 300_000).toISOString(); changed = true; selected.push({ entry, branch: { ...branch } });
      }
      if (changed) { delete group.integration; this.save(context, group); }
      return selected;
    });
    const results = await Promise.allSettled(ready.map(async ({ entry, branch }) => {
      try {
        const agent = await this.host.start(context, entry, branch);
        this.host.store.immediateTransaction(() => {
          const group = this.group(context.flowId); const current = group.branches[entry.id]!;
          if (current.attempt !== branch.attempt || current.agent_id !== agent.agent_id) return;
          current.launch_settled = Boolean(agent.backend_handle);
          if (current.state !== "invoking") { this.save(context, group); return; }
          current.state = agent.backend_handle ? "running" : "uncertain"; current.work_generation = agent.work_generation;
          this.save(context, group); this.host.emit(context, "package_started", { package_id: entry.id, attempt: current.attempt, agent_id: agent.agent_id, state: current.state });
        });
      } catch (error) {
        this.host.store.immediateTransaction(() => { const group = this.group(context.flowId); const current = group.branches[entry.id]!; if (current.attempt !== branch.attempt || current.state !== "invoking") return; const agent = this.host.agent(current.agent_id!); current.state = "uncertain"; current.launch_settled = false; current.reason = error instanceof Error ? error.message : "Package start failed."; this.save(context, group); this.host.emit(context, "package_blocked", { package_id: entry.id, reason: current.reason }); });
      }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return this.group(context.flowId);
  }
  reconcile(agent: AgentRecord) {
    if (!terminal(agent)) return;
    for (const instance of this.host.store.listFlowInstances({ runId: agent.run_id })) {
      const state = this.host.runtime.get(instance.flow_instance_id); const group = state?.packages; if (!state || !group) continue;
      for (const [id, branch] of Object.entries(group.branches)) if (branch.agent_id === agent.agent_id && !["failed", "cancelled", "accepted"].includes(branch.state)) {
        if (agent.status === "completed" && branch.delivery) continue;
        branch.state = "failed"; branch.reason = "Package worker terminated without an eligible immutable delivery.";
        state.revision++; this.host.runtime.save(instance.flow_instance_id, state);
        this.host.emit(this.host.context(instance.flow_instance_id, false), "package_blocked", { package_id: id, agent_id: agent.agent_id, reason: branch.reason });
      }
    }
  }
}
