import type { AgentDefinition, AgentDefinitionConfigureResult } from "./agent-definitions";
import { completeAgentPatch } from "./agent-definitions";

export type AgentSaveState = "saved" | "saving" | "unsaved";

export function flushDeferredAgentSaves<Timer extends number | ReturnType<typeof setTimeout>>(
  timers: Map<string, Timer>,
  findDefinition: (definitionId: string) => AgentDefinition | undefined,
  enqueue: (definition: AgentDefinition) => void
): void {
  const definitionIds = [...timers.keys()];
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const definitionId of definitionIds) {
    const definition = findDefinition(definitionId);
    if (definition) enqueue(definition);
  }
}

interface QueuedDefinition {
  definition: AgentDefinition;
  version: number;
  position?: number;
}

interface AgentDefinitionSaveQueueOptions {
  save: (definition: AgentDefinition, expectedRevision: string, position?: number) => Promise<AgentDefinitionConfigureResult>;
  onSaved: (result: AgentDefinitionConfigureResult, preserveDefinitionIds: Set<string>, savedDefinitionId: string) => void;
  onError: (error: unknown) => void;
  onStateChange: (state: AgentSaveState) => void;
}

/** Serializes catalog-CAS updates while retaining only the newest draft per definition. */
export class AgentDefinitionSaveQueue {
  private revision: string;
  private readonly pending = new Map<string, QueuedDefinition>();
  private readonly versions = new Map<string, number>();
  private inFlight: QueuedDefinition | null = null;
  private paused = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(initialRevision: string, private readonly options: AgentDefinitionSaveQueueOptions) {
    this.revision = initialRevision;
  }

  enqueue(definition: AgentDefinition, position?: number): void {
    const version = (this.versions.get(definition.definition_id) ?? 0) + 1;
    this.versions.set(definition.definition_id, version);
    const alreadyPending = this.pending.get(definition.definition_id);
    this.pending.set(definition.definition_id, { definition, version, position: position ?? alreadyPending?.position });
    if (this.paused) {
      this.options.onStateChange("unsaved");
      return;
    }
    void this.pump();
  }

  setRevision(revision: string): void {
    this.revision = revision;
  }

  reset(revision: string): void {
    if (this.inFlight) throw new Error("Cannot reset the save queue while a save is in flight.");
    this.revision = revision;
    this.pending.clear();
    this.paused = false;
    this.options.onStateChange("saved");
  }

  retry(): void {
    if (!this.pending.size) return;
    this.paused = false;
    void this.pump();
  }

  rebase(revision: string): void {
    this.revision = revision;
    this.paused = false;
    void this.pump();
  }

  whenIdle(): Promise<void> {
    if (this.paused) return Promise.reject(new Error("Unsaved agent changes must be retried before launch."));
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  pendingDrafts(): Map<string, AgentDefinition> {
    return new Map([...this.pending].map(([id, queued]) => [id, queued.definition]));
  }

  get busy(): boolean {
    return Boolean(this.inFlight) || this.pending.size > 0;
  }

  get saving(): boolean {
    return Boolean(this.inFlight);
  }

  private async pump(): Promise<void> {
    if (this.inFlight || this.paused) return;
    const next = this.pending.entries().next().value as [string, QueuedDefinition] | undefined;
    if (!next) {
      this.options.onStateChange("saved");
      this.resolveWaiters();
      return;
    }
    const [definitionId, queued] = next;
    this.pending.delete(definitionId);
    this.inFlight = queued;
    this.options.onStateChange("saving");
    try {
      const result = await this.options.save(queued.definition, this.revision, queued.position);
      this.revision = result.revision;
      this.inFlight = null;
      this.options.onSaved(result, new Set(this.pending.keys()), definitionId);
      await this.pump();
    } catch (error) {
      this.inFlight = null;
      // A newer queued draft already contains this failed change. Otherwise
      // put the failed snapshot back so retry never drops the user's edit.
      const newer = this.pending.get(definitionId);
      if (!newer) this.pending.set(definitionId, queued);
      else if (newer.position === undefined && queued.position !== undefined) this.pending.set(definitionId, { ...newer, position: queued.position });
      this.paused = true;
      this.options.onStateChange("unsaved");
      this.options.onError(error);
      this.rejectWaiters(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

export function saveDefinitionUpdate(definition: AgentDefinition, expectedRevision: string, position?: number) {
  return {
    operation: "update" as const,
    expected_revision: expectedRevision,
    definition_id: definition.definition_id,
    patch: completeAgentPatch(definition),
    ...(position === undefined ? {} : { position })
  };
}
