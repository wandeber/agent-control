"use client";

import { Background, Controls, ReactFlow, applyNodeChanges, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { Bot, Check, FileText, GitBranch, Search, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildFlowDefinitionGraph, type FlowVisualNode } from "@/lib/flow-graph";
import { flowDiagramEdges, flowDiagramPositions, routeFlowDiagram, visibleFlowDiagramEdges, PHASE_HEIGHT, PHASE_WIDTH } from "@/lib/flow-diagram";
import { shouldTryMcpApp } from "@/lib/mcp-app";
import { useFlowPreview, type FlowDefinition, type FlowPromptPreview } from "@/lib/flow-preview";
import { useConsoleSelection } from "./console-selection";
import { PhaseEdgeOverlay } from "./flow-phase-graph";

export function FlowsShell() {
  const { selectedFlowId, setSelectedFlowId, projectDir, registerRefresh, setConnection } = useConsoleSelection();
  const { data, definition, connection, refresh } = useFlowPreview(projectDir, selectedFlowId);
  const [query, setQuery] = useState("");
  const [stepId, setStepId] = useState<string | null>(null);
  const [tab, setTab] = useState("instructions");
  useEffect(() => registerRefresh(refresh), [refresh, registerRefresh]);
  useEffect(() => setConnection(connection), [connection, setConnection]);
  const flowKey = `${projectDir}:${definition?.config.id ?? selectedFlowId}`;
  useEffect(() => { setStepId(null); setTab("instructions"); }, [flowKey]);
  const selectedStep = definition && stepId && definition.config.steps[stepId] ? stepId : definition?.config.initial_step ?? null;
  const step = selectedStep ? definition?.config.steps[selectedStep] : null;
  const role = step?.role ? definition?.config.roles?.[step.role] : null;
  const prompts = selectedStep ? definition?.prompts[selectedStep] ?? [] : [];
  const phaseCount = Object.keys(definition?.config.steps ?? {}).length;
  const agentCount = Object.keys(definition?.config.roles ?? {}).length;
  const chooseFlow = (id: string) => {
    setSelectedFlowId(id);
    if (!shouldTryMcpApp()) {
      const url = new URL(window.location.href); url.searchParams.set("flow_id", id);
      window.history.replaceState(window.history.state, "", url.href);
    }
  };
  const flows = data?.flows.filter(flow => `${flow.flow_id ?? flow.directory_name} ${flow.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? [];

  return <main className="flows-shell">
    <aside className="flow-library agent-scroll" aria-label="Flow catalog">
      <label className="flow-search"><Search size={15} /><input aria-label="Search flows" placeholder="Search flows" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {data?.catalogs.map(catalog => {
        const entries = flows.filter(flow => flow.catalog_id === catalog.catalog_id);
        if (!entries.length) return null;
        return <section key={catalog.catalog_id}><h2>{catalog.name}</h2>{entries.map(flow => {
          const id = flow.flow_id ?? flow.directory_name;
          return <button key={flow.config_path} className="flow-library-item" aria-pressed={id === (selectedFlowId ?? data.selected_flow_id)} onClick={() => chooseFlow(id)}>
            <Workflow size={16} /><span><strong>{id}</strong><small>{flow.description ?? (flow.valid ? "Flow definition" : "Draft in progress")}</small></span>
          </button>;
        })}</section>;
      })}
      {data && !flows.length ? <p className="flow-muted">{query ? "No matching flows." : "Create a flow with Codex to see it here."}</p> : null}
      <p className="flow-library-hint">Create or edit flows with Codex. Saved changes appear here automatically.</p>
    </aside>
    <section className="flow-preview-main">
      <header className="flow-preview-heading"><div><h1>{definition?.config.id ?? selectedFlowId ?? "Choose a flow"}</h1><p>{definition?.config.description ?? "Explore phases, agent instructions and routes before running a flow."}</p></div><span className="flow-preview-badge">Source preview</span></header>
      {data?.error ? <details className="flow-draft-notice"><summary>{definition ? "Draft in progress · showing the last valid version" : "Draft in progress"}</summary><p>{data.error}</p></details> : null}
      {definition ? <div className="flow-preview-workspace">
        <DefinitionGraph key={flowKey} definition={definition} selectedStepId={selectedStep} onSelect={setStepId} />
        <aside className="flow-definition-details agent-scroll" aria-label="Phase details">
          <div className="flow-phase-heading"><span className="flow-eyebrow">Phase</span><h2>{selectedStep?.replaceAll("_", " ")}</h2><p>{step?.description}</p>
            <div className="flow-model-summary"><Bot size={16} /><span>{step?.execution === "coordinator" ? (step.decision?.authority === "user" ? "User decision" : "Coordinator decision") : `${step?.role ?? "Agent"} · ${role?.model ?? "Provider default"}${role?.reasoning_effort ? ` · ${role.reasoning_effort}` : ""}`}</span></div>
          </div>
          <div className="flow-detail-tabs" role="tablist" aria-label="Phase information">
            {[["instructions", "Instructions"], ["routes", "Relations"], ["source", "Definition"]].map(([id,label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
          </div>
          {tab === "instructions" ? <div className="flow-instructions" role="tabpanel">
            <PromptSection title="Phase instructions" prompts={prompts.filter(prompt => prompt.scope === "step")} />
            <PromptSection title={`Agent prompt${step?.role ? ` · ${step.role}` : ""}`} prompts={prompts.filter(prompt => prompt.scope === "role")} description={role?.description} />
          </div> : tab === "routes" ? <div className="flow-instructions" role="tabpanel">
            {step?.decision ? <section><h3>Decision</h3><p>{step.decision.key} · {step.decision.authority ?? "coordinator"} · {step.decision.owner ?? "orchestrator"}</p></section> : null}
            <Relations definition={definition} stepId={selectedStep!} onSelect={setStepId} />
            <section><h3>Inputs</h3>{Object.keys(step?.inputs ?? {}).length ? Object.entries(step!.inputs!).map(([key, value]) => <p key={key}>{key} → {value.artifact}{value.required ? " · required" : ""}</p>) : <p className="flow-muted">No declared inputs.</p>}</section>
            <section><h3>Outputs</h3>{Object.keys(step?.outputs ?? {}).length ? Object.entries(step!.outputs!).map(([key, value]) => <p key={key}>{key} → {value.artifact}{value.required ? " · required" : ""}</p>) : <p className="flow-muted">No declared outputs.</p>}</section>
          </div> : <div className="flow-instructions" role="tabpanel"><section><h3><FileText size={15} /> Flow source</h3><p className="flow-file-path">{definition.config_path}</p><p className="flow-muted">Effective configuration includes project model overrides. Editing these sources does not change an existing run.</p><pre>{JSON.stringify({ phase: step, agent: role }, null, 2)}</pre></section></div>}
        </aside>
      </div> : <div className="flow-preview-empty"><Workflow size={36} /><p>{connection === "connecting" ? "Loading flows…" : connection === "offline" ? "Offline" : "Your flow will appear here as Codex creates it."}</p><span>Project flows live in .agents/flows/&lt;flow-id&gt;/flow.yaml</span></div>}
      <footer className="flow-preview-footer"><span>{projectDir ?? data?.project_dir ?? "Shared flow catalogs"}</span><span>{definition ? `${phaseCount} ${phaseCount === 1 ? "phase" : "phases"} · ${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : "No run required"}</span></footer>
    </section>
  </main>;
}

function PromptSection({ title, prompts, description }: { title: string; prompts: FlowPromptPreview[]; description?: string }) {
  return <section><h3>{title}</h3>{description ? <p>{description}</p> : null}{prompts.length ? prompts.map((prompt, index) => <div key={`${prompt.owner_id}:${index}`}>
    {prompt.path ? <details className="flow-source-path"><summary>Prompt file</summary><span>{prompt.path}</span></details> : null}
    {prompt.error ? <p className="flow-muted">{prompt.error}</p> : <div className="chat-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{prompt.text ?? ""}</ReactMarkdown></div>}
  </div>) : <p className="flow-muted">No separate prompt declared.</p>}</section>;
}

function Relations({ definition, stepId, onSelect }: { definition: FlowDefinition; stepId: string; onSelect: (id: string) => void }) {
  const graph = buildFlowDefinitionGraph(definition.config);
  const node = graph.nodes.find(value => value.stepId === stepId);
  const edges = graph.edges.filter(edge => edge.source === node?.id || edge.target === node?.id);
  return <section><h3>Routes</h3>{edges.length ? edges.map((edge,index) => {
    const source = graph.nodes.find(value => value.id === edge.source);
    const target = graph.nodes.find(value => value.id === edge.target);
    return <div className="flow-route-detail" key={`${edge.id}:${index}`}><button onClick={() => { if (source?.stepId) onSelect(source.stepId); }}>{source?.title}</button><span> → </span><button onClick={() => { if (target?.stepId) onSelect(target.stepId); }}>{target?.title}</button><p>{edge.label}</p></div>;
  }) : <p className="flow-muted">No declared routes.</p>}</section>;
}

type DefinitionNode = Node<FlowVisualNode & { modelLabel: string; chosen: boolean; choose: () => void } & Record<string, unknown>, "definition">;
const definitionNodeTypes = { definition: DefinitionNodeCard };
function DefinitionNodeCard({ data }: NodeProps<DefinitionNode>) {
  return <button className="flow-definition-node" data-selected={data.chosen} onClick={data.choose} title={data.description ?? data.title}>
    <div>{data.kind === "finish" ? <Check size={16} /> : <Workflow size={16} />}<strong>{data.title}</strong></div>
    <span>{data.role ?? (data.kind === "finish" ? "End of flow" : data.subtitle)}</span>
    {data.kind === "step" ? <small>{data.modelLabel}</small> : null}
  </button>;
}

function DefinitionGraph({ definition, selectedStepId, onSelect }: { definition: FlowDefinition; selectedStepId: string | null; onSelect: (id: string) => void }) {
  const model = useMemo(() => buildFlowDefinitionGraph(definition.config), [definition]);
  const [nodes, setNodes] = useState<DefinitionNode[]>([]);
  const [allRoutes, setAllRoutes] = useState(false);
  const [ready, setReady] = useState(false);
  const flow = useRef<ReactFlowInstance<DefinitionNode, Edge> | null>(null);
  const fitted = useRef(false);
  const canvas = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const positions = flowDiagramPositions(model.nodes);
    setNodes(previous => model.nodes.map(node => {
      const step = node.stepId ? definition.config.steps[node.stepId] : undefined;
      const role = node.role ? definition.config.roles?.[node.role] : undefined;
      return { id: node.id, type: "definition", position: previous.find(value => value.id === node.id)?.position ?? positions.get(node.id)!,
        data: { ...node, chosen: node.stepId === selectedStepId, choose: () => { if (node.stepId) onSelect(node.stepId); },
          modelLabel: step?.execution === "coordinator" ? (step.decision?.authority === "user" ? "User decision" : "Coordinator") : `${role?.model ?? "Provider default"}${role?.reasoning_effort ? ` · ${role.reasoning_effort}` : ""}` } };
    }));
  }, [model, definition, selectedStepId, onSelect]);
  useEffect(() => {
    if (!ready || !nodes.length || fitted.current) return;
    const timer = setTimeout(() => {
      // Start at a readable scale. Fit-all remains an explicit action for long flows.
      const width = canvas.current?.clientWidth ?? 500;
      void flow.current?.setViewport({ x: Math.max(40, (width - PHASE_WIDTH * 0.85) / 2), y: 60, zoom: 0.85 });
      fitted.current = true;
    }, 80);
    return () => clearTimeout(timer);
  }, [ready, nodes.length]);
  const edges = useMemo(() => flowDiagramEdges(model.nodes, model.edges), [model]);
  const focused = model.nodes.find(node => node.stepId === selectedStepId)?.id ?? null;
  const routes = useMemo(() => routeFlowDiagram(visibleFlowDiagramEdges(edges, focused, allRoutes), nodes.map(node => ({ id: node.id, position: node.position, width: PHASE_WIDTH, height: PHASE_HEIGHT, kind: node.data.kind }))), [edges, focused, allRoutes, nodes]);
  const onNodesChange = useCallback((changes: Parameters<typeof applyNodeChanges<DefinitionNode>>[0]) => setNodes(current => applyNodeChanges(changes, current)), []);
  return <div ref={canvas} className="flow-definition-canvas" aria-label="Flow definition diagram">
    <button className="flow-routes-toggle" aria-pressed={allRoutes} onClick={() => setAllRoutes(value => !value)}><GitBranch size={14} />{allRoutes ? "All routes" : "Selected phase routes"}</button>
    <ReactFlow<DefinitionNode, Edge> nodes={nodes} edges={[]} nodeTypes={definitionNodeTypes} onNodesChange={onNodesChange} onInit={instance => { flow.current = instance; setReady(true); }} minZoom={0.15} maxZoom={1.6} proOptions={{ hideAttribution: true }}>
      <PhaseEdgeOverlay routes={routes} /><Background gap={22} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
