import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSubagentAdapter } from "../src/adapters/codex-subagent-adapter.js";
import { ManualAdapter } from "../src/adapters/manual-adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { ControllerError } from "../src/core/errors.js";
import { createController } from "../src/core/factory.js";
import { hashToken } from "../src/core/identity.js";
import { LocalCredentialStore } from "../src/core/local-credential-store.js";
import { credentialsRoot } from "../src/core/paths.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

describe("local root-bridge credential store", () => {
  let tmp: string;
  let store: SqliteStore;
  let credentialStore: LocalCredentialStore;
  let controller: AgentController;
  let oldAdminKey: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-control-credentials-"));
    oldAdminKey = process.env.AGENT_CONTROL_ADMIN_KEY;
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_local_credential_test";
    store = new SqliteStore(join(tmp, "state.sqlite"));
    credentialStore = new LocalCredentialStore(store, join(tmp, "home", "credentials"));
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());
    registry.register(new CodexSubagentAdapter());
    controller = new AgentController(store, registry, credentialStore);
  });

  afterEach(() => {
    store.close();
    if (oldAdminKey === undefined) {
      delete process.env.AGENT_CONTROL_ADMIN_KEY;
    } else {
      process.env.AGENT_CONTROL_ADMIN_KEY = oldAdminKey;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes strict private bridge and action-claim records without exposing tokens", async () => {
    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    const publicGrant = credentialStore.persistBridgeCredential(credential);
    expect(publicGrant).toMatchObject({ bridge_grant_id: credential.bridge_grant_id });
    expect(publicGrant).not.toHaveProperty("bridge_token");

    const bridgeDirectory = join(tmp, "home", "credentials", "bridges");
    const bridgePath = join(bridgeDirectory, `${credential.bridge_grant_id}.json`);
    expect(statSync(join(tmp, "home")).mode & 0o777).toBe(0o700);
    expect(statSync(join(tmp, "home", "credentials")).mode & 0o777).toBe(0o700);
    expect(statSync(bridgeDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(bridgePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(bridgeDirectory)).toEqual([`${credential.bridge_grant_id}.json`]);
    expect(Object.keys(readJson(bridgePath)).sort()).toEqual(
      [
        "bridge_grant_id",
        "bridge_token",
        "created_at",
        "expires_at",
        "kind",
        "orchestrator_agent_id",
        "owner_task_identity",
        "owner_task_path",
        "run_id",
        "version"
      ].sort()
    );
    expect(
      credentialStore.resolveBridgeToken({
        bridgeGrantId: credential.bridge_grant_id,
        runId: launched.login.run.run_id,
        orchestratorAgentId: launched.login.agent.agent_id,
        ownerTaskIdentity: "thread-secure-root",
        ownerTaskPath: "/root"
      })
    ).toBe(credential.bridge_token);

    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: credential.bridge_token
    });
    const claim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken: credential.bridge_token
    });
    if (!("action_token" in claim)) {
      throw new Error("Expected a claimed action.");
    }
    const action = store.getOrchestratorAction(claim.action_id)!;
    const publicClaim = credentialStore.persistActionClaim(claim, action);
    expect(publicClaim).toMatchObject({ action_id: action.action_id, claim_attempt: 1 });
    expect(publicClaim).not.toHaveProperty("action_token");
    const claimDirectory = join(tmp, "home", "credentials", "action-claims");
    const claimPath = join(claimDirectory, `${action.action_id}.json`);
    expect(statSync(claimDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(claimPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(readJson(claimPath)).sort()).toEqual(
      [
        "action_id",
        "action_token",
        "claim_attempt",
        "kind",
        "lease_expires_at",
        "orchestrator_agent_id",
        "run_id",
        "version"
      ].sort()
    );
    expect(
      credentialStore.resolveActionToken({
        actionId: action.action_id,
        runId: action.run_id,
        orchestratorAgentId: action.orchestrator_agent_id
      })
    ).toBe(claim.action_token);
  });

  it("rolls back native flow initialization when local bridge persistence fails", () => {
    const blockedCredentialRoot = join(tmp, "blocked-credential-root");
    writeFileSync(blockedCredentialRoot, "not a directory", "utf8");
    const isolatedRegistry = new AdapterRegistry();
    isolatedRegistry.register(new ManualAdapter());
    isolatedRegistry.register(new CodexSubagentAdapter());
    const transactionalCredentialStore = new LocalCredentialStore(store, blockedCredentialRoot);
    const transactionalController = new AgentController(
      store,
      isolatedRegistry,
      transactionalCredentialStore
    );
    const login = transactionalController.orchestratorLogin({
      adminKey: "ack_local_credential_test",
      title: "Transactional credential orchestrator",
      repoDir: "/repo",
      backend: "manual"
    });
    const startInput = {
      config: nativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-transactional-root",
      ownerTaskPath: "/root",
      bridgeCredentialDelivery: "local" as const
    };

    expect(() => transactionalController.startFlow(startInput)).toThrow();
    expect(store.db.prepare("select count(*) as count from flows").get()).toMatchObject({ count: 0 });
    expect(store.db.prepare("select count(*) as count from flow_instances").get()).toMatchObject({ count: 0 });
    expect(store.db.prepare("select count(*) as count from bridge_grants").get()).toMatchObject({ count: 0 });
    expect(
      store.db.prepare("select count(*) as count from events where type = 'flow.started'").get()
    ).toMatchObject({ count: 0 });

    // The same request must be retryable after the local filesystem problem is
    // fixed; no unusable flow/grant from the failed attempt may be reused.
    rmSync(blockedCredentialRoot, { force: true });
    const retried = transactionalController.startFlow(startInput);
    expect(retried).toMatchObject({
      reused: false,
      bridge_grant: {
        bridge_grant_id: expect.stringMatching(/^bridge_/),
        owner_task_identity: "thread-transactional-root"
      }
    });
    expect(retried.bridge_credential).toBeUndefined();
    expect(
      existsSync(
        join(
          blockedCredentialRoot,
          "bridges",
          `${retried.bridge_grant!.bridge_grant_id}.json`
        )
      )
    ).toBe(true);
  });

  it("preserves an existing Agent Control home mode while privatizing credential directories", () => {
    const controlHome = join(tmp, "home");
    mkdirSync(controlHome, { mode: 0o755 });
    chmodSync(controlHome, 0o755);

    const launched = launchNativeFlow();
    credentialStore.persistBridgeCredential(launched.start.bridge_credential!);

    expect(statSync(controlHome).mode & 0o777).toBe(0o755);
    expect(statSync(join(controlHome, "credentials")).mode & 0o777).toBe(0o700);
    expect(statSync(join(controlHome, "credentials", "bridges")).mode & 0o777).toBe(0o700);
  });

  it("enforces the owner task path for explicit and inferred active grants", () => {
    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    credentialStore.persistBridgeCredential(credential);
    const binding = {
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      ownerTaskIdentity: null,
      ownerTaskPath: "/root"
    };

    expect(
      credentialStore.resolveBridgeToken({
        ...binding,
        bridgeGrantId: credential.bridge_grant_id
      })
    ).toBe(credential.bridge_token);
    expect(credentialStore.resolveBridgeToken(binding)).toBe(credential.bridge_token);
    expectCredentialError(
      () =>
        credentialStore.resolveBridgeToken({
          ...binding,
          bridgeGrantId: credential.bridge_grant_id,
          ownerTaskPath: "/root/other"
        }),
      "credential_store_invalid_record"
    );
    expectCredentialError(
      () => credentialStore.resolveBridgeToken({ ...binding, ownerTaskPath: "/root/other" }),
      "credential_store_invalid_record"
    );

    const secondToken = `acb_${"b".repeat(32)}`;
    const secondGrant = store.createBridgeGrant({
      runId: binding.runId,
      orchestratorAgentId: binding.orchestratorAgentId,
      ownerTaskIdentity: "thread-secure-root",
      ownerTaskPath: binding.ownerTaskPath,
      tokenHash: hashToken(secondToken)
    });
    credentialStore.persistBridgeCredential({
      bridge_grant_id: secondGrant.bridge_grant_id,
      bridge_token: secondToken,
      run_id: secondGrant.run_id,
      orchestrator_agent_id: secondGrant.orchestrator_agent_id,
      owner_task_identity: secondGrant.owner_task_identity,
      owner_task_path: secondGrant.owner_task_path,
      created_at: secondGrant.created_at,
      expires_at: secondGrant.expires_at
    });
    expect(() => credentialStore.resolveBridgeToken(binding)).toThrowError(/Multiple local bridge credentials/);

    store.revokeBridgeGrant(secondGrant.bridge_grant_id);
    expect(credentialStore.resolveBridgeToken(binding)).toBe(credential.bridge_token);
    expect(
      existsSync(
        join(
          tmp,
          "home",
          "credentials",
          "bridges",
          `${secondGrant.bridge_grant_id}.json`
        )
      )
    ).toBe(false);
  });

  it("rejects traversal, separators, malformed JSON, unknown keys, kinds, and embedded ids", () => {
    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    credentialStore.persistBridgeCredential(credential);
    const binding = {
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      ownerTaskIdentity: "thread-secure-root",
      ownerTaskPath: "/root"
    };

    for (const id of ["../bridge_deadbeef", "bridge_aaaaaaaaaaaaaaaaaaaa/child", "bridge_%2e%2e", "bridge_aaaaaaaaaaaaaaaaaaaa\\child"]) {
      expectCredentialError(
        () => credentialStore.resolveBridgeToken({ ...binding, bridgeGrantId: id }),
        "credential_store_unsafe_path"
      );
    }
    for (const id of ["../action_deadbeef", "action_aaaaaaaaaaaaaaaaaaaa/child", "action_%2e%2e", "action_aaaaaaaaaaaaaaaaaaaa\\child"]) {
      expectCredentialError(
        () =>
          credentialStore.resolveActionToken({
            actionId: id,
            runId: binding.runId,
            orchestratorAgentId: binding.orchestratorAgentId
          }),
        "credential_store_unsafe_path"
      );
    }

    const bridgePath = join(tmp, "home", "credentials", "bridges", `${credential.bridge_grant_id}.json`);
    const original = readJson(bridgePath);
    const invalidRecords: unknown[] = [
      "{not-json",
      { ...original, unexpected: true },
      { ...original, kind: "action_claim" },
      { ...original, bridge_grant_id: "bridge_aaaaaaaaaaaaaaaaaaaa" }
    ];
    for (const invalid of invalidRecords) {
      writeFileSync(
        bridgePath,
        typeof invalid === "string" ? invalid : `${JSON.stringify(invalid)}\n`,
        "utf8"
      );
      expectCredentialError(
        () =>
          credentialStore.resolveBridgeToken({
            ...binding,
            bridgeGrantId: credential.bridge_grant_id
          }),
        "credential_store_invalid_record"
      );
    }
    writeFileSync(bridgePath, `${JSON.stringify(original)}\n`, "utf8");
    chmodSync(bridgePath, 0o644);
    expectCredentialError(
      () =>
        credentialStore.resolveBridgeToken({
          ...binding,
          bridgeGrantId: credential.bridge_grant_id
        }),
      "credential_store_unsafe_path"
    );
  });

  it("rejects symlinked credential files and directories without reading their targets", async () => {
    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    credentialStore.persistBridgeCredential(credential);
    const bridgePath = join(
      tmp,
      "home",
      "credentials",
      "bridges",
      `${credential.bridge_grant_id}.json`
    );
    const outside = join(tmp, "outside-secret.json");
    writeFileSync(outside, JSON.stringify({ bridge_token: "must-not-be-read" }), "utf8");
    rmSync(bridgePath);
    symlinkSync(outside, bridgePath);
    expectCredentialError(
      () =>
        credentialStore.resolveBridgeToken({
          bridgeGrantId: credential.bridge_grant_id,
          runId: launched.login.run.run_id,
          orchestratorAgentId: launched.login.agent.agent_id,
          ownerTaskPath: "/root"
        }),
      "credential_store_unsafe_path"
    );
    expect(readFileSync(outside, "utf8")).toContain("must-not-be-read");
    const purge = await controller.runPurge(launched.login.run.run_id, {
      dryRun: false,
      force: true,
      deleteRuntimeFiles: false
    });
    expect(purge.credential_cleanup_diagnostics).toEqual([
      {
        kind: "bridge",
        id: credential.bridge_grant_id,
        code: "credential_cleanup_failed"
      }
    ]);
    expect(store.getBridgeGrant(credential.bridge_grant_id)).toBeNull();

    const unsafeRoot = join(tmp, "unsafe-home", "credentials");
    const outsideDirectory = join(tmp, "outside-directory");
    mkdirSync(unsafeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(outsideDirectory, { mode: 0o700 });
    symlinkSync(outsideDirectory, join(unsafeRoot, "bridges"), "dir");
    const unsafeStore = new LocalCredentialStore(store, unsafeRoot);
    expectCredentialError(
      () =>
        unsafeStore.resolveBridgeToken({
          bridgeGrantId: credential.bridge_grant_id,
          runId: launched.login.run.run_id,
          orchestratorAgentId: launched.login.agent.agent_id,
          ownerTaskPath: "/root"
        }),
      "credential_store_unsafe_path"
    );
  });

  it("cleans valid credentials after revoke and authoritative purges", async () => {
    const revokedLaunch = launchNativeFlow();
    const revokedCredential = revokedLaunch.start.bridge_credential!;
    credentialStore.persistBridgeCredential(revokedCredential);
    const revokedPath = join(
      tmp,
      "home",
      "credentials",
      "bridges",
      `${revokedCredential.bridge_grant_id}.json`
    );
    const revoked = controller.revokeBridgeGrant(revokedCredential.bridge_grant_id);
    expect(revoked.credential_cleanup_diagnostics).toEqual([]);
    expect(existsSync(revokedPath)).toBe(false);

    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    credentialStore.persistBridgeCredential(credential);
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: credential.bridge_token
    });
    const claim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken: credential.bridge_token
    });
    if (!("action_token" in claim)) {
      throw new Error("Expected a claimed action.");
    }
    credentialStore.persistActionClaim(claim, store.getOrchestratorAction(claim.action_id)!);

    const result = await controller.runPurge(launched.login.run.run_id, {
      dryRun: false,
      force: true,
      deleteRuntimeFiles: false
    });
    expect(result.credential_cleanup_diagnostics).toEqual([]);
    expect(
      existsSync(join(tmp, "home", "credentials", "bridges", `${credential.bridge_grant_id}.json`))
    ).toBe(false);
    expect(
      existsSync(join(tmp, "home", "credentials", "action-claims", `${claim.action_id}.json`))
    ).toBe(false);
  });

  it("keeps malformed files during cleanup while preserving the successful SQLite purge", async () => {
    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    credentialStore.persistBridgeCredential(credential);
    const bridgePath = join(
      tmp,
      "home",
      "credentials",
      "bridges",
      `${credential.bridge_grant_id}.json`
    );
    writeFileSync(bridgePath, `${JSON.stringify({ ...readJson(bridgePath), unexpected: true })}\n`, "utf8");

    const result = await controller.runPurge(launched.login.run.run_id, {
      dryRun: false,
      force: true,
      deleteRuntimeFiles: false
    });
    expect(result.credential_cleanup_diagnostics).toEqual([
      {
        kind: "bridge",
        id: credential.bridge_grant_id,
        code: "credential_store_invalid_record"
      }
    ]);
    expect(existsSync(bridgePath)).toBe(true);
    expect(store.getBridgeGrant(credential.bridge_grant_id)).toBeNull();
  });

  it("performs bounded cleanup when valid credentials lose their SQLite authority", () => {
    const launched = launchNativeFlow();
    const credential = launched.start.bridge_credential!;
    credentialStore.persistBridgeCredential(credential);
    const bridgePath = join(
      tmp,
      "home",
      "credentials",
      "bridges",
      `${credential.bridge_grant_id}.json`
    );
    store.db.prepare("delete from bridge_grants where bridge_grant_id = ?").run(credential.bridge_grant_id);
    expect(credentialStore.cleanupStaleCredentials(1)).toEqual([]);
    expect(existsSync(bridgePath)).toBe(false);

    const abandonedTemporary = join(
      tmp,
      "home",
      "credentials",
      "bridges",
      `.tmp-${"a".repeat(32)}`
    );
    writeFileSync(abandonedTemporary, "abandoned-secret", { encoding: "utf8", mode: 0o600 });
    expect(credentialStore.cleanupStaleCredentials(1)).toEqual([]);
    expect(existsSync(abandonedTemporary)).toBe(false);
  });

  it("isolates startup credential cleanup for separate overridden databases in one home", () => {
    const previousHome = process.env.AGENT_CONTROL_HOME;
    const previousDb = process.env.AGENT_CONTROL_DB;
    const sharedHome = join(tmp, "shared-control-home");
    const databaseA = join(tmp, "authority-a.sqlite");
    const databaseB = join(tmp, "authority-b.sqlite");
    let runtimeA: ReturnType<typeof createController> | undefined;
    let runtimeB: ReturnType<typeof createController> | undefined;
    let reopenedA: ReturnType<typeof createController> | undefined;

    try {
      process.env.AGENT_CONTROL_HOME = sharedHome;
      delete process.env.AGENT_CONTROL_DB;
      expect(credentialsRoot()).toBe(join(sharedHome, "credentials"));

      process.env.AGENT_CONTROL_DB = databaseA;
      const rootA = credentialsRoot();
      runtimeA = createController();
      const credentialA = createPersistedNativeCredential(runtimeA, "A");
      const pathA = join(rootA, "bridges", `${credentialA.bridge_grant_id}.json`);
      expect(existsSync(pathA)).toBe(true);
      runtimeA.store.close();
      runtimeA = undefined;

      process.env.AGENT_CONTROL_DB = databaseB;
      const rootB = credentialsRoot();
      expect(rootB).not.toBe(rootA);
      runtimeB = createController();
      expect(existsSync(pathA)).toBe(true);
      const credentialB = createPersistedNativeCredential(runtimeB, "B");
      const pathB = join(rootB, "bridges", `${credentialB.bridge_grant_id}.json`);
      expect(existsSync(pathB)).toBe(true);
      runtimeB.store.close();
      runtimeB = undefined;

      process.env.AGENT_CONTROL_DB = databaseA;
      reopenedA = createController();
      expect(existsSync(pathA)).toBe(true);
      expect(existsSync(pathB)).toBe(true);
      reopenedA.store.close();
      reopenedA = undefined;
    } finally {
      runtimeA?.store.close();
      runtimeB?.store.close();
      reopenedA?.store.close();
      if (previousHome === undefined) {
        delete process.env.AGENT_CONTROL_HOME;
      } else {
        process.env.AGENT_CONTROL_HOME = previousHome;
      }
      if (previousDb === undefined) {
        delete process.env.AGENT_CONTROL_DB;
      } else {
        process.env.AGENT_CONTROL_DB = previousDb;
      }
    }
  });

  function launchNativeFlow() {
    const login = controller.orchestratorLogin({
      adminKey: "ack_local_credential_test",
      title: `Root credential orchestrator ${Date.now()} ${Math.random()}`,
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: nativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-secure-root",
      ownerTaskPath: "/root"
    });
    return { login, start };
  }

  function createPersistedNativeCredential(
    runtime: ReturnType<typeof createController>,
    suffix: string
  ) {
    const login = runtime.controller.orchestratorLogin({
      adminKey: "ack_local_credential_test",
      title: `Isolated credential orchestrator ${suffix}`,
      repoDir: "/repo",
      backend: "manual"
    });
    const start = runtime.controller.startFlow({
      config: nativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: `thread-isolated-${suffix.toLowerCase()}`,
      ownerTaskPath: "/root"
    });
    const credential = start.bridge_credential!;
    runtime.credentialStore.persistBridgeCredential(credential);
    return credential;
  }
});

function nativeConfig() {
  return {
    id: "secure-native-bridge-flow",
    initial_step: "work",
    roles: { worker: { backend: "codex-subagent" } },
    steps: {
      work: {
        role: "worker",
        prompt: "Perform the secure local credential test.",
        on: { reported: { finish: true } }
      }
    }
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function expectCredentialError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).details).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected credential error ${code}.`);
}
