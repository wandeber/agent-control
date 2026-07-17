import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ControllerError } from "./errors.js";
import { hashToken } from "./identity.js";
import { isBridgeGrantId, isOrchestratorActionId } from "./ids.js";
import { credentialsRoot } from "./paths.js";
import type {
  BridgeCredential,
  BridgeGrantRecord,
  CredentialCleanupDiagnostic,
  OrchestratorActionClaimedEnvelope,
  OrchestratorActionRecord,
  PublicActionClaimRef,
  PublicBridgeGrantRef
} from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BRIDGE_TOKEN_RE = /^acb_[A-Za-z0-9_-]+$/;
const ACTION_TOKEN_RE = /^aca_[A-Za-z0-9_-]+$/;
const TEMP_FILE_RE = /^\.tmp-[0-9a-f]{32}$/;

const bridgeCredentialRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("bridge"),
    bridge_grant_id: z.string().refine(isBridgeGrantId),
    run_id: z.string().min(1),
    orchestrator_agent_id: z.string().min(1),
    owner_task_identity: z.string().min(1).nullable(),
    owner_task_path: z.string().min(1),
    expires_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    bridge_token: z.string().regex(BRIDGE_TOKEN_RE)
  })
  .strict();

const actionClaimRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("action_claim"),
    action_id: z.string().refine(isOrchestratorActionId),
    run_id: z.string().min(1),
    orchestrator_agent_id: z.string().min(1),
    claim_attempt: z.number().int().positive(),
    lease_expires_at: z.string().datetime(),
    action_token: z.string().regex(ACTION_TOKEN_RE)
  })
  .strict();

type BridgeCredentialRecord = z.infer<typeof bridgeCredentialRecordSchema>;
type ActionClaimRecord = z.infer<typeof actionClaimRecordSchema>;

export interface LocalCredentialAuthority {
  getBridgeGrant(bridgeGrantId: string): BridgeGrantRecord | null;
  getOrchestratorAction(actionId: string): OrchestratorActionRecord | null;
}

interface BridgeResolutionInput {
  bridgeGrantId?: string | null;
  runId: string;
  orchestratorAgentId: string;
  ownerTaskIdentity?: string | null;
  ownerTaskPath: string;
}

/**
 * Stores the two short-lived root-bridge secrets outside stdout. The SQLite
 * store remains authoritative for revocation, scope and token rotation; this
 * service only releases a local token after the on-disk record, requested
 * binding and current SQLite authority all agree.
 *
 * Every filesystem operation is deliberately confined to one direct child of
 * credentials/bridges or credentials/action-claims. Existing symlinks and
 * unexpected file types are rejected before they can be read or chmodded.
 */
export class LocalCredentialStore {
  private readonly root: string;
  private readonly bridgesDirectory: string;
  private readonly actionClaimsDirectory: string;

  constructor(
    private readonly authority: LocalCredentialAuthority,
    root = credentialsRoot()
  ) {
    this.root = resolve(root);
    this.bridgesDirectory = resolve(this.root, "bridges");
    this.actionClaimsDirectory = resolve(this.root, "action-claims");
    if (
      dirname(this.bridgesDirectory) !== this.root ||
      dirname(this.actionClaimsDirectory) !== this.root
    ) {
      throw credentialStoreError("credential_store_unsafe_path", "Unsafe credential directory layout.");
    }
  }

  assertReady(): void {
    this.ensureHierarchy("bridge");
    this.ensureHierarchy("action_claim");
  }

  persistBridgeCredential(credential: BridgeCredential): PublicBridgeGrantRef {
    const record: BridgeCredentialRecord = {
      version: 1,
      kind: "bridge",
      bridge_grant_id: credential.bridge_grant_id,
      run_id: credential.run_id,
      orchestrator_agent_id: credential.orchestrator_agent_id,
      owner_task_identity: credential.owner_task_identity,
      owner_task_path: credential.owner_task_path,
      expires_at: credential.expires_at,
      created_at: credential.created_at,
      bridge_token: credential.bridge_token
    };
    const parsed = bridgeCredentialRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw credentialStoreError("credential_store_invalid_record", "Invalid bridge credential record.", {
        kind: "bridge",
        id: credential.bridge_grant_id
      });
    }
    this.assertBridgeAuthority(parsed.data);
    this.writeCredential("bridge", parsed.data.bridge_grant_id, parsed.data);
    return publicBridgeGrantRef(parsed.data);
  }

  persistActionClaim(
    claim: OrchestratorActionClaimedEnvelope,
    action: OrchestratorActionRecord
  ): PublicActionClaimRef {
    if (
      action.action_id !== claim.action_id ||
      action.run_id !== claim.run_id ||
      action.orchestrator_agent_id !== claim.orchestrator_agent_id ||
      action.status !== "claimed" ||
      !action.claim_lease_expires_at ||
      action.claim_attempt < 1 ||
      action.action_token_hash !== hashToken(claim.action_token)
    ) {
      throw credentialStoreError("credential_store_invalid_record", "Invalid action claim binding.", {
        kind: "action_claim",
        id: claim.action_id
      });
    }
    const record: ActionClaimRecord = {
      version: 1,
      kind: "action_claim",
      action_id: claim.action_id,
      run_id: claim.run_id,
      orchestrator_agent_id: claim.orchestrator_agent_id,
      claim_attempt: action.claim_attempt,
      lease_expires_at: action.claim_lease_expires_at,
      action_token: claim.action_token
    };
    const parsed = actionClaimRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw credentialStoreError("credential_store_invalid_record", "Invalid action claim record.", {
        kind: "action_claim",
        id: claim.action_id
      });
    }
    this.assertActionAuthority(parsed.data);
    this.writeCredential("action_claim", parsed.data.action_id, parsed.data);
    return publicActionClaimRef(parsed.data);
  }

  /** Resolve an explicit grant, or the only grant matching run/orchestrator/thread. */
  resolveBridgeToken(input: BridgeResolutionInput): string {
    const record = input.bridgeGrantId
      ? this.readBridgeCredential(input.bridgeGrantId)
      : this.findUniqueBridgeCredential(input);
    this.assertBridgeExpectedBinding(record, input);
    this.assertBridgeAuthority(record);
    return record.bridge_token;
  }

  findBridgeToken(input: Omit<BridgeResolutionInput, "bridgeGrantId">): string | null {
    const records = this.findActiveBridgeCredentials(input);
    if (records.length === 0) {
      return null;
    }
    if (records.length > 1) {
      throw credentialStoreError(
        "credential_store_invalid_record",
        "Multiple local bridge credentials match; pass --bridge-grant explicitly."
      );
    }
    const record = records[0]!;
    this.assertBridgeExpectedBinding(record, input);
    this.assertBridgeAuthority(record);
    return record.bridge_token;
  }

  resolveActionToken(input: {
    actionId: string;
    runId: string;
    orchestratorAgentId: string;
  }): string {
    const record = this.readActionClaim(input.actionId);
    if (
      record.run_id !== input.runId ||
      record.orchestrator_agent_id !== input.orchestratorAgentId
    ) {
      throw credentialStoreError("credential_store_invalid_record", "Action claim binding mismatch.", {
        kind: "action_claim",
        id: input.actionId
      });
    }
    this.assertActionAuthority(record);
    return record.action_token;
  }

  /**
   * Delete credentials only after their authoritative SQLite rows have been
   * purged or revoked. Cleanup never weakens the successful database result:
   * unsafe or malformed files are left untouched and reported without secret
   * content.
   */
  cleanupCredentials(input: {
    bridges?: BridgeGrantRecord[];
    actions?: OrchestratorActionRecord[];
  }): CredentialCleanupDiagnostic[] {
    const diagnostics: CredentialCleanupDiagnostic[] = [];
    for (const grant of input.bridges ?? []) {
      const diagnostic = this.cleanupBridgeCredential(grant);
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }
    for (const action of input.actions ?? []) {
      const diagnostic = this.cleanupActionClaim(action);
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }
    return diagnostics;
  }

  /** Bounded startup hygiene for credentials whose SQLite authority vanished. */
  cleanupStaleCredentials(limit = 100): CredentialCleanupDiagnostic[] {
    const diagnostics: CredentialCleanupDiagnostic[] = [];
    let remaining = Math.max(0, limit);
    for (const kind of ["bridge", "action_claim"] as const) {
      if (remaining === 0) {
        break;
      }
      let entries: string[];
      try {
        const directory = this.ensureHierarchy(kind);
        entries = readdirSync(directory)
          .filter((name) => name.endsWith(".json") || TEMP_FILE_RE.test(name))
          .slice(0, remaining);
      } catch {
        diagnostics.push({ kind, id: "credentials", code: "credential_cleanup_failed" });
        continue;
      }
      remaining -= entries.length;
      for (const name of entries) {
        if (TEMP_FILE_RE.test(name)) {
          try {
            const directory = kind === "bridge" ? this.bridgesDirectory : this.actionClaimsDirectory;
            const temporary = directChildPath(directory, name);
            safeLstatRegularFile(temporary);
            unlinkSync(temporary);
          } catch (error) {
            diagnostics.push(cleanupDiagnostic(kind, name, error));
          }
          continue;
        }
        const id = name.slice(0, -".json".length);
        try {
          if (kind === "bridge") {
            if (!isBridgeGrantId(id)) {
              throw credentialStoreError("credential_store_invalid_record", "Invalid bridge credential filename.");
            }
            const record = this.readBridgeCredential(id);
            const authority = this.authority.getBridgeGrant(id);
            if (!authority || authority.revoked_at || bridgeGrantExpired(authority)) {
              this.removeCredentialFile(kind, id);
              continue;
            }
            this.assertBridgeAuthority(record);
          } else {
            if (!isOrchestratorActionId(id)) {
              throw credentialStoreError("credential_store_invalid_record", "Invalid action claim filename.");
            }
            const record = this.readActionClaim(id);
            const authority = this.authority.getOrchestratorAction(id);
            if (!authority) {
              this.removeCredentialFile(kind, id);
              continue;
            }
            this.assertActionAuthority(record);
          }
        } catch (error) {
          diagnostics.push(cleanupDiagnostic(kind, id, error));
        }
      }
    }
    return diagnostics;
  }

  private findUniqueBridgeCredential(input: BridgeResolutionInput): BridgeCredentialRecord {
    const matches = this.findActiveBridgeCredentials(input);
    if (matches.length === 0) {
      throw credentialStoreError("credential_store_invalid_record", "No matching local bridge credential exists.");
    }
    if (matches.length > 1) {
      throw credentialStoreError(
        "credential_store_invalid_record",
        "Multiple local bridge credentials match; pass --bridge-grant explicitly."
      );
    }
    return matches[0]!;
  }

  /**
   * Infer only from credentials whose binding matches exactly and whose
   * database authority is still active. Revoked or expired records cannot make
   * an otherwise unique active grant ambiguous; malformed active bindings still
   * fail closed through assertBridgeAuthority.
   */
  private findActiveBridgeCredentials(input: BridgeResolutionInput): BridgeCredentialRecord[] {
    return this.listBridgeCredentialRecords()
      .filter(
        (record) =>
          record.run_id === input.runId &&
          record.orchestrator_agent_id === input.orchestratorAgentId &&
          record.owner_task_path === input.ownerTaskPath &&
          (input.ownerTaskIdentity === undefined ||
            input.ownerTaskIdentity === null ||
            record.owner_task_identity === input.ownerTaskIdentity)
      )
      .filter((record) => this.hasActiveBridgeAuthority(record));
  }

  private hasActiveBridgeAuthority(record: BridgeCredentialRecord): boolean {
    const grant = this.authority.getBridgeGrant(record.bridge_grant_id);
    if (!grant || grant.revoked_at || bridgeGrantExpired(grant)) {
      try {
        this.removeCredentialFile("bridge", record.bridge_grant_id);
      } catch {
        // An inactive authority excludes the record even if cleanup cannot run.
      }
      return false;
    }
    this.assertBridgeAuthority(record);
    return true;
  }

  private listBridgeCredentialRecords(): BridgeCredentialRecord[] {
    const directory = this.ensureHierarchy("bridge");
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const id = name.slice(0, -".json".length);
        if (!isBridgeGrantId(id)) {
          throw credentialStoreError("credential_store_invalid_record", "Invalid bridge credential filename.");
        }
        return this.readBridgeCredential(id);
      });
  }

  private readBridgeCredential(bridgeGrantId: string): BridgeCredentialRecord {
    if (!isBridgeGrantId(bridgeGrantId)) {
      throw credentialStoreError("credential_store_unsafe_path", "Invalid bridge grant id.");
    }
    const value = this.readCredentialJson("bridge", bridgeGrantId);
    const parsed = bridgeCredentialRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.bridge_grant_id !== bridgeGrantId) {
      throw credentialStoreError("credential_store_invalid_record", "Invalid bridge credential record.", {
        kind: "bridge",
        id: bridgeGrantId
      });
    }
    return parsed.data;
  }

  private readActionClaim(actionId: string): ActionClaimRecord {
    if (!isOrchestratorActionId(actionId)) {
      throw credentialStoreError("credential_store_unsafe_path", "Invalid orchestrator action id.");
    }
    const value = this.readCredentialJson("action_claim", actionId);
    const parsed = actionClaimRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.action_id !== actionId) {
      throw credentialStoreError("credential_store_invalid_record", "Invalid action claim record.", {
        kind: "action_claim",
        id: actionId
      });
    }
    return parsed.data;
  }

  private readCredentialJson(kind: "bridge" | "action_claim", id: string): unknown {
    const path = this.credentialPath(kind, id);
    let before: Stats;
    try {
      before = safeLstatRegularFile(path);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw credentialStoreError("credential_store_invalid_record", "Credential record was not found.", {
          kind,
          id,
          missing: true
        });
      }
      throw error;
    }
    const descriptor = openNoFollow(path, constants.O_RDONLY);
    try {
      const after = fstatSync(descriptor);
      if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        (after.mode & 0o777) !== PRIVATE_FILE_MODE
      ) {
        throw credentialStoreError("credential_store_unsafe_path", "Credential file changed during open.");
      }
      const text = readFileSync(descriptor, { encoding: "utf8" });
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw credentialStoreError("credential_store_invalid_record", "Credential file contains invalid JSON.");
      }
    } finally {
      closeSync(descriptor);
    }
  }

  private writeCredential(
    kind: "bridge" | "action_claim",
    id: string,
    value: BridgeCredentialRecord | ActionClaimRecord
  ): void {
    const directory = this.ensureHierarchy(kind);
    const destination = this.credentialPath(kind, id);
    const temporaryName = `.tmp-${randomBytes(16).toString("hex")}`;
    if (!TEMP_FILE_RE.test(temporaryName)) {
      throw credentialStoreError("credential_store_unsafe_path", "Invalid credential temporary filename.");
    }
    const temporary = directChildPath(directory, temporaryName);
    let descriptor: number | null = null;
    let temporaryExists = false;
    try {
      descriptor = openNoFollow(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE
      );
      temporaryExists = true;
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;

      // A regular target may be replaced atomically, but a symlink or special
      // file is always rejected. The private directory prevents cross-user
      // replacement between this check and rename.
      try {
        safeLstatRegularFile(destination);
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
      renameSync(temporary, destination);
      temporaryExists = false;
      const installed = safeLstatRegularFile(destination);
      if ((installed.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw credentialStoreError("credential_store_unsafe_path", "Credential file mode is not private.");
      }
      fsyncDirectory(directory);
    } finally {
      if (descriptor !== null) {
        closeSync(descriptor);
      }
      if (temporaryExists) {
        try {
          unlinkSync(temporary);
        } catch {
          // The original safe-write error remains authoritative.
        }
      }
    }
  }

  private credentialPath(kind: "bridge" | "action_claim", id: string): string {
    if (kind === "bridge" ? !isBridgeGrantId(id) : !isOrchestratorActionId(id)) {
      throw credentialStoreError("credential_store_unsafe_path", "Invalid credential id.");
    }
    const directory = this.ensureHierarchy(kind);
    return directChildPath(directory, `${id}.json`);
  }

  private ensureHierarchy(kind: "bridge" | "action_claim"): string {
    const controlHome = dirname(this.root);
    // The control home can already contain public runtime assets and user
    // configuration, so credential setup must not silently change its mode.
    // A newly-created home is still made private; only the credentials subtree
    // and its children are required to remain exactly 0700 on every access.
    ensurePrivateDirectory(controlHome, true, false);
    ensurePrivateDirectory(this.root, false);
    const directory = kind === "bridge" ? this.bridgesDirectory : this.actionClaimsDirectory;
    ensurePrivateDirectory(directory, false);
    return directory;
  }

  private assertBridgeExpectedBinding(record: BridgeCredentialRecord, input: BridgeResolutionInput): void {
    if (
      record.run_id !== input.runId ||
      record.orchestrator_agent_id !== input.orchestratorAgentId ||
      record.owner_task_path !== input.ownerTaskPath ||
      (input.ownerTaskIdentity !== undefined &&
        input.ownerTaskIdentity !== null &&
        record.owner_task_identity !== input.ownerTaskIdentity)
    ) {
      throw credentialStoreError("credential_store_invalid_record", "Bridge credential binding mismatch.", {
        kind: "bridge",
        id: record.bridge_grant_id
      });
    }
  }

  private assertBridgeAuthority(record: BridgeCredentialRecord): void {
    const grant = this.authority.getBridgeGrant(record.bridge_grant_id);
    if (!grant || grant.revoked_at || bridgeGrantExpired(grant)) {
      try {
        this.removeCredentialFile("bridge", record.bridge_grant_id);
      } catch {
        // Invalid SQLite authority is decisive even if best-effort cleanup fails.
      }
      throw credentialStoreError("credential_store_invalid_record", "Bridge credential has no active authority.", {
        kind: "bridge",
        id: record.bridge_grant_id
      });
    }
    if (
      grant.run_id !== record.run_id ||
      grant.orchestrator_agent_id !== record.orchestrator_agent_id ||
      grant.owner_task_identity !== record.owner_task_identity ||
      grant.owner_task_path !== record.owner_task_path ||
      grant.created_at !== record.created_at ||
      grant.expires_at !== record.expires_at ||
      grant.token_hash !== hashToken(record.bridge_token)
    ) {
      throw credentialStoreError("credential_store_invalid_record", "Bridge credential authority mismatch.", {
        kind: "bridge",
        id: record.bridge_grant_id
      });
    }
  }

  private assertActionAuthority(record: ActionClaimRecord): void {
    const action = this.authority.getOrchestratorAction(record.action_id);
    if (!action) {
      try {
        this.removeCredentialFile("action_claim", record.action_id);
      } catch {
        // The absent SQLite authority remains decisive.
      }
      throw credentialStoreError("credential_store_invalid_record", "Action claim has no authority.", {
        kind: "action_claim",
        id: record.action_id
      });
    }
    if (
      action.run_id !== record.run_id ||
      action.orchestrator_agent_id !== record.orchestrator_agent_id ||
      action.claim_attempt !== record.claim_attempt ||
      action.claim_lease_expires_at !== record.lease_expires_at ||
      action.action_token_hash !== hashToken(record.action_token) ||
      !["claimed", "succeeded", "failed"].includes(action.status)
    ) {
      throw credentialStoreError("credential_store_invalid_record", "Action claim authority mismatch.", {
        kind: "action_claim",
        id: record.action_id
      });
    }
  }

  private cleanupBridgeCredential(grant: BridgeGrantRecord): CredentialCleanupDiagnostic | null {
    try {
      const record = this.readBridgeCredential(grant.bridge_grant_id);
      if (
        record.run_id !== grant.run_id ||
        record.orchestrator_agent_id !== grant.orchestrator_agent_id
      ) {
        throw credentialStoreError("credential_store_invalid_record", "Bridge cleanup binding mismatch.");
      }
      this.removeCredentialFile("bridge", grant.bridge_grant_id);
      return null;
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      return cleanupDiagnostic("bridge", grant.bridge_grant_id, error);
    }
  }

  private cleanupActionClaim(action: OrchestratorActionRecord): CredentialCleanupDiagnostic | null {
    try {
      const record = this.readActionClaim(action.action_id);
      if (
        record.run_id !== action.run_id ||
        record.orchestrator_agent_id !== action.orchestrator_agent_id
      ) {
        throw credentialStoreError("credential_store_invalid_record", "Action cleanup binding mismatch.");
      }
      this.removeCredentialFile("action_claim", action.action_id);
      return null;
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      return cleanupDiagnostic("action_claim", action.action_id, error);
    }
  }

  private removeCredentialFile(kind: "bridge" | "action_claim", id: string): void {
    const path = this.credentialPath(kind, id);
    safeLstatRegularFile(path);
    unlinkSync(path);
  }
}

function publicBridgeGrantRef(record: BridgeCredentialRecord): PublicBridgeGrantRef {
  return {
    bridge_grant_id: record.bridge_grant_id,
    run_id: record.run_id,
    orchestrator_agent_id: record.orchestrator_agent_id,
    owner_task_identity: record.owner_task_identity,
    owner_task_path: record.owner_task_path,
    created_at: record.created_at,
    expires_at: record.expires_at
  };
}

function publicActionClaimRef(record: ActionClaimRecord): PublicActionClaimRef {
  return {
    action_id: record.action_id,
    run_id: record.run_id,
    orchestrator_agent_id: record.orchestrator_agent_id,
    claim_attempt: record.claim_attempt,
    lease_expires_at: record.lease_expires_at
  };
}

function ensurePrivateDirectory(
  path: string,
  recursive: boolean,
  enforcePrivateMode = true
): void {
  let created = false;
  try {
    const initial = lstatSync(path);
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      throw credentialStoreError("credential_store_unsafe_path", "Credential directory is unsafe.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    mkdirSync(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  }

  const descriptor = openNoFollow(path, constants.O_RDONLY | directoryFlag());
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) {
      throw credentialStoreError("credential_store_unsafe_path", "Credential path is not a directory.");
    }
    if (created || enforcePrivateMode) {
      fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    }
  } finally {
    closeSync(descriptor);
  }
}

function safeLstatRegularFile(path: string): Stats {
  const stat = lstatSync(path) as Stats;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw credentialStoreError("credential_store_unsafe_path", "Credential path is not a regular file.");
  }
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw credentialStoreError("credential_store_unsafe_path", "Credential file mode is not private.");
  }
  return stat;
}

function directChildPath(directory: string, filename: string): string {
  const base = resolve(directory);
  const candidate = resolve(base, filename);
  if (dirname(candidate) !== base) {
    throw credentialStoreError("credential_store_unsafe_path", "Credential path escaped its directory.");
  }
  return candidate;
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    return openSync(path, flags | noFollow, mode);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw error;
    }
    throw credentialStoreError("credential_store_unsafe_path", "Credential path could not be opened safely.");
  }
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openNoFollow(directory, constants.O_RDONLY | directoryFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function bridgeGrantExpired(grant: BridgeGrantRecord): boolean {
  return Boolean(grant.expires_at && Date.parse(grant.expires_at) <= Date.now());
}

function cleanupDiagnostic(
  kind: "bridge" | "action_claim",
  id: string,
  error: unknown
): CredentialCleanupDiagnostic {
  const code =
    error instanceof ControllerError && error.details.code === "credential_store_invalid_record"
      ? "credential_store_invalid_record"
      : "credential_cleanup_failed";
  return { kind, id, code };
}

function credentialStoreError(
  code: "credential_store_unsafe_path" | "credential_store_invalid_record",
  message: string,
  details: Record<string, unknown> = {}
): ControllerError {
  return new ControllerError(message, "tool_error", { ...details, code });
}

function isMissingPathError(error: unknown): boolean {
  if (error instanceof ControllerError && error.details.missing === true) {
    return true;
  }
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
