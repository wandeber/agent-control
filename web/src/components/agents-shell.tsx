"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Copy,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Trash2,
  Unplug
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  configureAgentDefinition,
  deleteAgentDefinition,
  fetchAgentDefinitions,
  fetchAgentDefinitionInventory,
  launchAgentDefinition
} from "@/lib/api";
import {
  AgentDefinitionApiError,
  applyAgentPatch,
  capabilitySelections,
  changedAgentPatch,
  createAgentDraft,
  editableAgent,
  filterCapabilityRows,
  hasAgentPatch,
  mcpRows,
  pluginRows,
  selectAgentModel,
  skillRows,
  uniqueAgentName,
  type AgentCatalogResult,
  type AgentDefinition,
  type AgentDefinitionConfigureResult,
  type AgentDefinitionInventoryResult,
  type CapabilityRow,
  type McpSelection,
  type PluginSelection,
  type SkillSelection
} from "@/lib/agent-definitions";
import { AgentDefinitionSaveQueue, flushDeferredAgentSaves, saveDefinitionUpdate, type AgentSaveState } from "@/lib/agent-definition-save-queue";
import { useConsoleSelection } from "./console-selection";
import { SettingsLayout, type SettingsSection } from "./settings-navigation";

type CapabilityTab = "plugins" | "skills" | "mcp_servers";

interface SaveIssue {
  message: string;
  conflict: boolean;
  autosave: boolean;
}

export function AgentsShell({ onNavigate }: { onNavigate: (section: SettingsSection) => void }) {
  const { projectDir, selectionHydrated, registerRefresh, selectRun, setConnection, setSelectedAgentId } = useConsoleSelection();
  const [catalog, setCatalog] = useState<AgentCatalogResult | null>(null);
  const [inventory, setInventory] = useState<AgentDefinitionInventoryResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [tab, setTab] = useState<CapabilityTab>("plugins");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [orphanedDrafts, setOrphanedDrafts] = useState<AgentDefinition[]>([]);
  const [saveState, setSaveState] = useState<AgentSaveState>("saved");
  const [issue, setIssue] = useState<SaveIssue | null>(null);
  const catalogRef = useRef<AgentCatalogResult | null>(null);
  const baselineRef = useRef(new Map<string, AgentDefinition>());
  const loadGeneration = useRef(0);
  const dirtyIds = useRef(new Set<string>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const commitCatalog = useCallback((next: AgentCatalogResult) => {
    catalogRef.current = next;
    setCatalog(next);
    setSelectedId(current => current && next.agents.some(agent => agent.definition_id === current)
      ? current
      : null);
  }, []);

  const queue = useMemo(() => new AgentDefinitionSaveQueue("", {
    save: async (definition, expectedRevision) => await configureAgentDefinition(saveDefinitionUpdate(definition, expectedRevision)),
    onSaved: (result, pendingIds, savedId) => {
      if (!pendingIds.has(savedId) && !saveTimers.current.has(savedId)) {
        dirtyIds.current.delete(savedId);
      }
      const currentAgents = catalogRef.current?.agents ?? [];
      const local = new Map(currentAgents.map(agent => [agent.definition_id, agent]));
      const server = new Map(result.agents.map(agent => [agent.definition_id, agent]));
      baselineRef.current = server;
      const nextAgents = dirtyIds.current.size
        ? [
            ...currentAgents.filter(agent => server.has(agent.definition_id)).map(agent => dirtyIds.current.has(agent.definition_id) ? agent : server.get(agent.definition_id)!),
            ...result.agents.filter(agent => !local.has(agent.definition_id))
          ]
        : result.agents;
      commitCatalog({ schema_version: 1, revision: result.revision, agents: nextAgents });
      setIssue(null);
    },
    onError: error => {
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: true });
    },
    onStateChange: state => setSaveState(state === "saved" && dirtyIds.current.size ? "saving" : state)
  }), [commitCatalog]);

  const flushScheduledSaves = useCallback(() => {
    flushDeferredAgentSaves(
      saveTimers.current,
      definitionId => catalogRef.current?.agents.find(agent => agent.definition_id === definitionId),
      definition => queue.enqueue(definition)
    );
  }, [queue]);

  const loadInitial = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const catalogLoaded = Boolean(catalogRef.current);
    setLoading(!catalogLoaded);
    setRefreshing(catalogLoaded);
    setConnection("connecting");
    try {
      if (catalogLoaded) {
        const nextInventory = await fetchAgentDefinitionInventory(projectDir, false);
        if (generation !== loadGeneration.current) return;
        setInventory(nextInventory);
        setConnection("live");
        return;
      }
      const [nextCatalog, nextInventory] = await Promise.all([
        fetchAgentDefinitions(),
        fetchAgentDefinitionInventory(projectDir, false)
      ]);
      if (generation !== loadGeneration.current) return;
      queue.reset(nextCatalog.revision);
      baselineRef.current = new Map(nextCatalog.agents.map(agent => [agent.definition_id, agent]));
      dirtyIds.current.clear();
      commitCatalog(nextCatalog);
      setInventory(nextInventory);
      setIssue(null);
      setConnection("live");
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: false });
      setConnection("offline");
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [commitCatalog, projectDir, queue, setConnection]);

  useEffect(() => {
    if (!selectionHydrated) return;
    void loadInitial();
    return () => { loadGeneration.current += 1; };
  }, [loadInitial, selectionHydrated]);
  useEffect(() => () => flushScheduledSaves(), [flushScheduledSaves]);

  const refreshAndReapply = useCallback(async () => {
    if (actionBusy || queue.saving) return;
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    setConnection("connecting");
    const local = new Map(catalogRef.current?.agents.map(agent => [agent.definition_id, agent]) ?? []);
    const baseline = new Map(baselineRef.current);
    const draftIds = new Set([...dirtyIds.current, ...queue.pendingDrafts().keys()]);
    for (const timer of saveTimers.current.values()) clearTimeout(timer);
    saveTimers.current.clear();
    try {
      const [remote, nextInventory] = await Promise.all([
        fetchAgentDefinitions(),
        fetchAgentDefinitionInventory(projectDir, true)
      ]);
      if (generation !== loadGeneration.current) return;
      queue.reset(remote.revision);
      const remoteIds = new Set(remote.agents.map(agent => agent.definition_id));
      const retryIds = new Set<string>();
      const missingDrafts: AgentDefinition[] = [];
      const reapplied = remote.agents.map(remoteAgent => {
        if (!draftIds.has(remoteAgent.definition_id)) return remoteAgent;
        const localDraft = local.get(remoteAgent.definition_id);
        const confirmed = baseline.get(remoteAgent.definition_id);
        if (!localDraft || !confirmed) return remoteAgent;
        const patch = changedAgentPatch(localDraft, confirmed);
        if (hasAgentPatch(patch)) retryIds.add(remoteAgent.definition_id);
        else dirtyIds.current.delete(remoteAgent.definition_id);
        return applyAgentPatch(remoteAgent, patch);
      });
      for (const definitionId of draftIds) {
        if (remoteIds.has(definitionId)) continue;
        const draft = local.get(definitionId);
        if (draft) missingDrafts.push(draft);
        dirtyIds.current.delete(definitionId);
      }
      baselineRef.current = new Map(remote.agents.map(agent => [agent.definition_id, agent]));
      commitCatalog({ ...remote, agents: reapplied });
      setInventory(nextInventory);
      setOrphanedDrafts(previous => mergeDrafts(previous, missingDrafts));
      setIssue(null);
      setConnection("live");
      for (const agent of reapplied) if (retryIds.has(agent.definition_id)) queue.enqueue(agent);
      if (!retryIds.size) setSaveState("saved");
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: false });
      setConnection("offline");
    } finally {
      if (generation === loadGeneration.current) setRefreshing(false);
    }
  }, [actionBusy, commitCatalog, projectDir, queue, setConnection]);

  useEffect(() => registerRefresh(() => { void refreshAndReapply(); }), [refreshAndReapply, registerRefresh]);

  const selected = catalog?.agents.find(agent => agent.definition_id === selectedId) ?? null;
  const selectedModel = selected ? inventory?.models.find(model => model.id === selected.model && model.model_provider === selected.model_provider) : undefined;
  const requestedEffort = Boolean(selectedModel?.run_validation_required && !selectedModel.supported_reasoning_efforts.some(effort => effort.trim()));
  const filteredAgents = catalog?.agents.filter(agent => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${agent.name} ${agent.description} ${agent.model}`.toLocaleLowerCase().includes(needle);
  }) ?? [];
  const unavailableEnabled = selected && inventory
    ? [...pluginRows(selected, inventory), ...skillRows(selected, inventory), ...mcpRows(selected, inventory)].filter(row => row.enabled && !row.available && !row.required).length
    : 0;

  const scheduleSave = useCallback((definition: AgentDefinition, immediate: boolean) => {
    dirtyIds.current.add(definition.definition_id);
    setSaveState("saving");
    const previous = saveTimers.current.get(definition.definition_id);
    if (previous) clearTimeout(previous);
    saveTimers.current.delete(definition.definition_id);
    if (immediate) {
      queue.enqueue(definition);
      return;
    }
    const timer = setTimeout(() => {
      saveTimers.current.delete(definition.definition_id);
      const latest = catalogRef.current?.agents.find(agent => agent.definition_id === definition.definition_id);
      if (latest) queue.enqueue(latest);
    }, 420);
    saveTimers.current.set(definition.definition_id, timer);
  }, [queue]);

  const updateSelected = useCallback((change: (definition: AgentDefinition) => AgentDefinition, immediate = false) => {
    const current = catalogRef.current;
    if (!current || !selectedId) return;
    const existing = current.agents.find(agent => agent.definition_id === selectedId);
    if (!existing) return;
    const next = change(existing);
    commitCatalog({ ...current, agents: current.agents.map(agent => agent.definition_id === selectedId ? next : agent) });
    scheduleSave(next, immediate);
  }, [commitCatalog, scheduleSave, selectedId]);

  const applyMutation = useCallback((result: AgentDefinitionConfigureResult, nextSelection?: string) => {
    dirtyIds.current.clear();
    queue.setRevision(result.revision);
    baselineRef.current = new Map(result.agents.map(agent => [agent.definition_id, agent]));
    commitCatalog({ schema_version: 1, revision: result.revision, agents: result.agents });
    if (nextSelection) setSelectedId(nextSelection);
    setIssue(null);
  }, [commitCatalog, queue]);

  const createAgent = async () => {
    if (!catalog || !inventory) return;
    setActionBusy(true);
    try {
      const result = await configureAgentDefinition({ operation: "create", expected_revision: catalog.revision, patch: createAgentDraft(inventory, catalog.agents) });
      applyMutation(result, result.definition.definition_id);
    } catch (error) {
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: false });
    } finally { setActionBusy(false); }
  };

  const duplicateAgent = async () => {
    if (!catalog || !selected) return;
    setActionBusy(true);
    try {
      const name = uniqueAgentName(`${selected.name} copy`, catalog.agents);
      const result = await configureAgentDefinition({ operation: "duplicate", expected_revision: catalog.revision, source_id: selected.definition_id, patch: { name } });
      applyMutation(result, result.definition.definition_id);
    } catch (error) {
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: false });
    } finally { setActionBusy(false); }
  };

  const deleteAgent = async () => {
    if (!catalog || !selected) return;
    setActionBusy(true);
    try {
      const result = await deleteAgentDefinition(selected.definition_id, catalog.revision);
      dirtyIds.current.delete(selected.definition_id);
      queue.setRevision(result.revision);
      baselineRef.current = new Map(result.agents.map(agent => [agent.definition_id, agent]));
      commitCatalog({ schema_version: 1, revision: result.revision, agents: result.agents });
      setDeleteConfirm(false);
      setIssue(null);
    } catch (error) {
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: false });
    } finally { setActionBusy(false); }
  };

  const recoverDeletedDraft = async (draft: AgentDefinition) => {
    const current = catalogRef.current;
    if (!current) return;
    setActionBusy(true);
    try {
      const patch = { ...editableAgent(draft), name: uniqueAgentName(draft.name, current.agents) };
      const result = await configureAgentDefinition({ operation: "create", expected_revision: current.revision, patch });
      applyMutation(result, result.definition.definition_id);
      setOrphanedDrafts(drafts => drafts.filter(item => item.definition_id !== draft.definition_id));
    } catch (error) {
      const parsed = toApiError(error);
      setIssue({ message: parsed.message, conflict: parsed.isConflict, autosave: false });
    } finally { setActionBusy(false); }
  };

  const flushPendingSaves = async () => {
    flushScheduledSaves();
    await queue.whenIdle();
  };

  const launchAgent = async () => {
    if (!selected) return;
    if (!launchPrompt.trim()) {
      setLaunchError("Enter a task for this agent.");
      return;
    }
    setLaunching(true);
    setLaunchError(null);
    try {
      await flushPendingSaves();
      const result = await launchAgentDefinition({ definition_id: selected.definition_id, prompt: launchPrompt.trim(), ...(projectDir ? { repo_dir: projectDir } : {}) });
      setLaunchOpen(false);
      setLaunchPrompt("");
      selectRun(result.run_id);
      setSelectedAgentId(result.agent_id);
      try { window.location.hash = "/subagents"; } catch { /* Keep the selection if the host URL is opaque. */ }
    } catch (error) {
      setLaunchError(toApiError(error).message);
    } finally { setLaunching(false); }
  };

  const showList = () => {
    flushScheduledSaves();
    setSelectedId(null);
    setDeleteConfirm(false);
    setLaunchOpen(false);
    setLaunchPrompt("");
    setLaunchError(null);
  };
  const navigateSettings = (section: SettingsSection) => {
    showList();
    if (section !== "agents") onNavigate(section);
  };

  const blocked = actionBusy || saveState !== "saved";
  // Section navigation stays available while inventory loads or needs a retry.
  if (!catalog || !inventory) return <SettingsLayout section="agents" onSelect={navigateSettings}>
    {loading && !catalog ? <ScreenState icon={<Bot size={34} />} title="Loading personal agents…" detail="Reading the catalog and current Codex inventory." />
      : <ScreenState icon={<Unplug size={34} />} title="Agents unavailable" detail={issue?.message ?? "The catalog could not be loaded."} action={<button className="agent-secondary-button" onClick={() => void loadInitial()}>Try again</button>} />}
  </SettingsLayout>;

  return <SettingsLayout section="agents" onSelect={navigateSettings}>
    <section className="agent-editor">
      {orphanedDrafts.length ? <div className="agent-orphaned-drafts" role="alert"><AlertTriangle size={16} /><div><strong>{orphanedDrafts.length === 1 ? "A local draft was deleted elsewhere" : `${orphanedDrafts.length} local drafts were deleted elsewhere`}</strong><p>The edited data is preserved here and has not been written back under a stale ID.</p>{orphanedDrafts.map(draft => <div className="agent-orphaned-row" key={draft.definition_id}><span>{draft.name}</span><button className="agent-secondary-button" disabled={blocked} onClick={() => void recoverDeletedDraft(draft)}>Restore as new</button></div>)}</div></div> : null}
      {selected ? <>
        <header className="agent-editor-header">
          <div className="agent-editor-title"><button type="button" className="settings-back" aria-label="Back to agents" onClick={showList}><ArrowLeft size={17} /><span>Agents</span></button><span className="agent-avatar agent-avatar-large"><Bot size={19} /></span><div><span className="agents-eyebrow">Reusable configuration</span><h2>{selected.name}</h2></div></div>
          <div className="agent-editor-actions">
            <SaveStatus state={saveState} />
            <button className="agent-primary-button" type="button" disabled={actionBusy || launching} onClick={() => { setLaunchOpen(true); setDeleteConfirm(false); setLaunchError(null); }}><Play size={13} />Run</button>
            <button className="agent-secondary-button" type="button" disabled={blocked} onClick={() => void duplicateAgent()}><Copy size={14} />Copy</button>
            <button className="agent-icon-button agent-danger-button" type="button" aria-label={`Delete ${selected.name}`} title={`Delete ${selected.name}`} disabled={blocked} onClick={() => { setDeleteConfirm(true); setLaunchOpen(false); }}><Trash2 size={15} /></button>
          </div>
        </header>

        {launchOpen ? <div className="agent-launch" role="dialog" aria-label={`Run ${selected.name}`}><div className="agent-launch-heading"><div><strong>Run {selected.name}</strong><p>{projectDir ?? "Current Agent Control project"}</p></div><button className="agent-secondary-button" disabled={launching} onClick={() => setLaunchOpen(false)}>Cancel</button></div><textarea autoFocus value={launchPrompt} aria-label="Task prompt" placeholder="Describe the task for this agent…" onChange={event => { setLaunchPrompt(event.target.value); setLaunchError(null); }} />{launchError ? <p className="agent-launch-error" role="alert">{launchError}</p> : null}<div className="agent-launch-footer"><span>Uses the saved provider, model, effort, and capabilities.</span><button className="agent-primary-button" disabled={launching || !launchPrompt.trim()} onClick={() => void launchAgent()}>{launching ? <span className="agent-spinner" /> : <Play size={13} />}{launching ? "Starting…" : "Start agent"}</button></div></div> : null}
        {deleteConfirm ? <div className="agent-confirm" role="alertdialog" aria-label={`Delete ${selected.name}`}><div><strong>Delete “{selected.name}”?</strong><p>This removes the saved definition. Existing workers are unchanged.</p></div><div><button className="agent-secondary-button" onClick={() => setDeleteConfirm(false)}>Cancel</button><button className="agent-primary-button agent-delete-confirm" disabled={blocked} onClick={() => void deleteAgent()}>Delete agent</button></div></div> : null}
        {issue ? <IssueBanner issue={issue} onRetry={issue.autosave && !issue.conflict ? () => { setIssue(null); queue.retry(); } : undefined} onRefresh={() => void refreshAndReapply()} /> : null}
        {!inventory.runtime.compatible ? <div className="agent-runtime-warning" role="status"><AlertTriangle size={16} /><span><strong>Unsupported Codex runtime</strong>{inventory.runtime.compatibility_reason ? ` — ${inventory.runtime.compatibility_reason}` : ""}</span></div> : null}
        {unavailableEnabled ? <div className="agent-runtime-warning" role="status"><AlertTriangle size={16} /><span>{unavailableEnabled} enabled {unavailableEnabled === 1 ? "capability is" : "capabilities are"} unavailable. Disable or restore them before launching this agent.</span></div> : null}

        <div className="agent-editor-scroll agent-scroll">
          <section className="agent-form-section" aria-labelledby="agent-identity-heading">
            <div className="agent-section-heading"><div><span className="agents-eyebrow">Identity</span><h3 id="agent-identity-heading">Instructions and model</h3></div><button className="agent-secondary-button" type="button" disabled={refreshing || queue.saving} onClick={() => void refreshAndReapply()}>{refreshing ? <span className="agent-spinner" /> : <RefreshCw size={14} />}Refresh inventory</button></div>
            <div className="agent-form-grid">
              <Field label="Name" className="agent-field-name"><input value={selected.name} aria-label="Agent name" onChange={event => updateSelected(agent => ({ ...agent, name: event.target.value }))} /></Field>
              <Field label="Description" className="agent-field-description"><input value={selected.description} aria-label="Agent description" placeholder="What this agent is best at" onChange={event => updateSelected(agent => ({ ...agent, description: event.target.value }))} /></Field>
              <Field label="Provider"><select value={selected.model_provider} aria-label="Model provider" onChange={event => {
                const providerId = event.target.value;
                const nextModel = inventory.models.find(model => (model.available || model.run_validation_required) && model.model_provider === providerId) ?? inventory.models.find(model => model.model_provider === providerId);
                updateSelected(agent => selectAgentModel(agent, nextModel, providerId), true);
              }}>{withCurrentProvider(inventory, selected.model_provider).map(provider => <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.name ?? provider.id}{provider.available ? "" : " (unavailable)"}</option>)}</select></Field>
              <Field label="Model" hint={selectedModel?.run_validation_required ? "Validated when launched" : undefined}><select value={selected.model} aria-label="Model" onChange={event => {
                const model = inventory.models.find(item => item.id === event.target.value && item.model_provider === selected.model_provider);
                updateSelected(agent => selectAgentModel(agent, model), true);
              }}>{withCurrentModel(inventory, selected).filter(model => model.model_provider === selected.model_provider).map(model => <option key={`${model.model_provider}:${model.id}`} value={model.id} disabled={!model.available && !model.run_validation_required}>{model.display_name ?? model.id}{model.run_validation_required ? " (validated at launch)" : model.available ? "" : " (unavailable)"}</option>)}</select></Field>
              <Field label="Reasoning effort" hint={requestedEffort ? "Requested · validated at launch" : undefined}>{requestedEffort
                ? <input key={`${selected.definition_id}:${selected.model_provider}:${selected.model}:${selected.reasoning_effort}`} defaultValue={selected.reasoning_effort} aria-label="Requested reasoning effort" placeholder="Required" onBlur={event => {
                    const effort = event.currentTarget.value.trim();
                    if (!effort) {
                      event.currentTarget.value = selected.reasoning_effort;
                      return;
                    }
                    if (effort !== selected.reasoning_effort) updateSelected(agent => ({ ...agent, reasoning_effort: effort }), true);
                  }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
                : <select value={selected.reasoning_effort} aria-label="Reasoning effort" onChange={event => updateSelected(agent => ({ ...agent, reasoning_effort: event.target.value }), true)}>{effortsFor(inventory, selected).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select>}</Field>
              <Field label="Instructions" className="agent-field-full"><textarea value={selected.instructions} aria-label="Agent instructions" placeholder="Describe how this agent should work…" onChange={event => updateSelected(agent => ({ ...agent, instructions: event.target.value }))} /></Field>
            </div>
            <details className="agent-advanced"><summary>Advanced</summary><div><Field label="Skill catalog token budget" hint="Optional · 1–10,000"><input type="number" min={1} max={10000} value={selected.skills_catalog_token_budget ?? ""} placeholder="Inherited" aria-label="Skill catalog token budget" onChange={event => {
              const raw = event.target.value;
              updateSelected(agent => setBudget(agent, raw));
            }} /></Field><p>Limits the skill catalog metadata included for this agent. Leave empty to inherit the runtime default.</p></div></details>
          </section>

          <section className="agent-capabilities" aria-labelledby="agent-capabilities-heading">
            <div className="agent-section-heading"><div><span className="agents-eyebrow">Capabilities</span><h3 id="agent-capabilities-heading">Available to this agent</h3></div><span className="agent-inventory-meta">{formatRuntimeVersion(inventory.runtime.version)} · {formatRefreshTime(inventory.refreshed_at)}</span></div>
            <div className="agent-capability-tabs" role="tablist" aria-label="Agent capabilities">
              {(["plugins", "skills", "mcp_servers"] as const).map(kind => {
                const rows = rowsFor(kind, selected, inventory);
                const Icon = kind === "plugins" ? Sparkles : kind === "skills" ? Bot : Server;
                return <button key={kind} role="tab" aria-selected={tab === kind} onClick={() => setTab(kind)}><Icon size={14} />{kind === "mcp_servers" ? "MCP" : titleCase(kind)}<span>{rows.filter(row => row.enabled).length}</span></button>;
              })}
            </div>
            <div className="agent-capability-toolbar">
              <label className="agent-capability-search"><Search size={14} /><input aria-label={`Search ${tab === "mcp_servers" ? "MCP servers" : tab}`} placeholder={`Search ${tab === "mcp_servers" ? "MCP servers" : tab}`} value={capabilityQuery} onChange={event => setCapabilityQuery(event.target.value)} /></label>
              {capabilityQuery.trim() ? <span>Clear search to reorder</span> : <span>Configuration order</span>}
            </div>
            <CapabilityList
              kind={tab}
              rows={rowsFor(tab, selected, inventory)}
              query={capabilityQuery}
              disabled={actionBusy}
              onChange={rows => updateSelected(agent => replaceCapabilities(agent, tab, rows), true)}
            />
          </section>
        </div>
      </> : <section className="settings-catalog agent-scroll" aria-label="Personal agent catalog"><div className="settings-catalog-inner">
        <header className="settings-catalog-heading"><div><h1>Agents</h1><p>Reusable agents, each with their own instructions and capabilities.</p></div><button className="agent-primary-button" type="button" disabled={blocked} onClick={() => void createAgent()}><Plus size={15} />Create agent</button></header>
        {issue ? <IssueBanner issue={issue} onRetry={issue.autosave && !issue.conflict ? () => { setIssue(null); queue.retry(); } : undefined} onRefresh={() => void refreshAndReapply()} /> : null}
        <div className="settings-catalog-toolbar"><label className="settings-search"><Search size={15} /><input aria-label="Search agents" placeholder="Search agents" value={query} onChange={event => setQuery(event.target.value)} /></label><span>{catalog.agents.length} {catalog.agents.length === 1 ? "agent" : "agents"}</span>{saveState !== "saved" ? <SaveStatus state={saveState} /> : null}</div>
        <div className="settings-entry-list">
          {filteredAgents.map(agent => {
            const model = inventory.models.find(item => item.id === agent.model && item.model_provider === agent.model_provider);
            return <article key={agent.definition_id} className="settings-entry">
              <button type="button" className="settings-entry-main" onClick={() => setSelectedId(agent.definition_id)}><span className="agent-avatar agent-avatar-large" aria-hidden="true"><Bot size={19} /></span><span className="settings-entry-copy"><span className="settings-entry-title"><strong title={agent.name}>{agent.name}</strong><small>{model?.display_name ?? agent.model ?? "Provider default"}{agent.reasoning_effort ? ` · ${agent.reasoning_effort}` : ""}</small></span><span className="settings-entry-description">{agent.description}</span></span></button>
              <button type="button" className="agent-secondary-button" aria-label={`Configure ${agent.name}`} onClick={() => setSelectedId(agent.definition_id)}>Configure</button>
            </article>;
          })}
        </div>
        {!filteredAgents.length ? <div className="settings-list-empty">{query ? "No matching agents." : "Create your first agent to choose its model, instructions, and plugins."}</div> : null}
      </div></section>}
    </section>
  </SettingsLayout>;
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return <label className={`agent-field ${className ?? ""}`}><span>{label}{hint ? <small>{hint}</small> : null}</span>{children}</label>;
}

function CapabilityList({ kind, rows, query, disabled, onChange }: { kind: CapabilityTab; rows: CapabilityRow[]; query: string; disabled: boolean; onChange: (rows: CapabilityRow[]) => void }) {
  const update = (index: number, next: CapabilityRow) => onChange(rows.map((row, current) => current === index ? next : row));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  if (!rows.length) return <div className="agent-capability-empty">No {kind === "mcp_servers" ? "MCP servers" : kind} were found in this inventory.</div>;
  const visibleRows = filterCapabilityRows(rows, query);
  const filtered = Boolean(query.trim());
  if (!visibleRows.length) return <div className="agent-capability-empty">No capabilities match “{query.trim()}”.</div>;
  return <div className="agent-capability-list" role="tabpanel">
    {visibleRows.map(row => {
      const index = rows.findIndex(candidate => candidate.id === row.id);
      const toggleDisabled = disabled || row.required || (!row.available && !row.enabled);
      return <div className="agent-capability-row" data-available={row.available} key={row.id}>
        <span className="agent-capability-icon" aria-hidden="true">{kind === "plugins" ? <Sparkles size={15} /> : kind === "skills" ? <Bot size={15} /> : <Server size={15} />}</span>
        <div className="agent-capability-copy"><div><strong>{row.name}</strong>{row.required ? <span className="agent-row-badge"><LockKeyhole size={10} />Required</span> : null}{!row.available ? <span className="agent-row-badge agent-row-unavailable">Unavailable</span> : null}</div><p>{row.description || row.id}</p>{row.meta ? <small>{row.meta}</small> : null}</div>
        <div className="agent-row-order">
          <button type="button" aria-label={`Move ${row.name} up`} title={filtered ? "Clear search to reorder" : "Move up"} disabled={disabled || filtered || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
          <button type="button" aria-label={`Move ${row.name} down`} title={filtered ? "Clear search to reorder" : "Move down"} disabled={disabled || filtered || index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
        </div>
        <button className="agent-switch" data-checked={row.enabled} role="switch" aria-checked={row.enabled} aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`} disabled={toggleDisabled} onClick={() => update(index, { ...row, enabled: !row.enabled })}><span /></button>
      </div>;
    })}
  </div>;
}

function SaveStatus({ state }: { state: AgentSaveState }) {
  return <span className="agent-save-status" data-state={state}>{state === "saving" ? <span className="agent-spinner" /> : <span className="agent-save-dot" />}{state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Unsaved"}</span>;
}

function IssueBanner({ issue, onRetry, onRefresh }: { issue: SaveIssue; onRetry?: () => void; onRefresh: () => void }) {
  return <div className="agent-save-issue" role="alert"><AlertTriangle size={16} /><div><strong>{issue.conflict ? "Catalog changed elsewhere" : issue.autosave ? "Changes are not saved" : "Catalog action failed"}</strong><p>{issue.message}</p></div><div>{onRetry ? <button className="agent-secondary-button" onClick={onRetry}>Retry</button> : null}<button className="agent-secondary-button" onClick={onRefresh}>{issue.conflict || issue.autosave ? "Refresh and reapply" : "Refresh"}</button></div></div>;
}

function ScreenState({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail: string; action?: React.ReactNode }) {
  return <section className="agents-screen-state"><span>{icon}</span><h1>{title}</h1><p>{detail}</p>{action}</section>;
}

function rowsFor(kind: CapabilityTab, definition: AgentDefinition, inventory: AgentDefinitionInventoryResult): CapabilityRow[] {
  return kind === "plugins" ? pluginRows(definition, inventory) : kind === "skills" ? skillRows(definition, inventory) : mcpRows(definition, inventory);
}

function replaceCapabilities(definition: AgentDefinition, kind: CapabilityTab, rows: CapabilityRow[]): AgentDefinition {
  const selections = capabilitySelections(kind, rows);
  if (kind === "plugins") return { ...definition, plugins: selections as PluginSelection[] };
  if (kind === "skills") return { ...definition, skills: selections as SkillSelection[] };
  return { ...definition, mcp_servers: selections as McpSelection[] };
}

function effortsFor(inventory: AgentDefinitionInventoryResult, definition: AgentDefinition): string[] {
  const supported = inventory.models.find(model => model.id === definition.model && model.model_provider === definition.model_provider)?.supported_reasoning_efforts.filter(effort => effort.trim()) ?? [];
  return supported.includes(definition.reasoning_effort) ? supported : definition.reasoning_effort ? [definition.reasoning_effort, ...supported] : supported;
}

function withCurrentProvider(inventory: AgentDefinitionInventoryResult, current: string) {
  return inventory.providers.some(provider => provider.id === current) ? inventory.providers : [{ id: current, available: false }, ...inventory.providers];
}

function withCurrentModel(inventory: AgentDefinitionInventoryResult, definition: AgentDefinition) {
  return inventory.models.some(model => model.id === definition.model && model.model_provider === definition.model_provider)
    ? inventory.models
    : [{ id: definition.model, model_provider: definition.model_provider, supported_reasoning_efforts: [definition.reasoning_effort], available: false, catalog_available: false, run_validation_required: false }, ...inventory.models];
}

function setBudget(definition: AgentDefinition, raw: string): AgentDefinition {
  const { skills_catalog_token_budget: _removed, ...rest } = definition;
  return raw ? { ...rest, skills_catalog_token_budget: Math.max(1, Math.min(10000, Number.parseInt(raw, 10) || 1)) } : rest;
}

function formatRefreshTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "inventory loaded" : `updated ${parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatRuntimeVersion(value: string): string {
  const version = value.trim();
  return /^codex(?:-cli)?(?:\s|$)/i.test(version) ? version : `Codex ${version}`;
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function toApiError(error: unknown): AgentDefinitionApiError {
  if (error instanceof AgentDefinitionApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AgentDefinitionApiError(message, /\bconflict\b|stale revision/i.test(message) ? "conflict" : "unknown");
}

function mergeDrafts(existing: AgentDefinition[], incoming: AgentDefinition[]): AgentDefinition[] {
  const drafts = new Map(existing.map(draft => [draft.definition_id, draft]));
  for (const draft of incoming) drafts.set(draft.definition_id, draft);
  return [...drafts.values()];
}
