"use client";

import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import {
  Bot,
  Braces,
  Clock3,
  FileImage,
  FileText,
  Files,
  Image as ImageIcon,
  ListTree,
  MessageSquareText,
  ScrollText,
  TerminalSquare,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { artifactImageUrl, fetchAgentLog, fetchAgentMessages } from "@/lib/api";
import { compactId, formatDateTime, safeJson } from "@/lib/format";
import { agentFlowSteps, artifactReferencesFlowStep, eventReferencesFlowStep, flowStepOrdinal } from "@/lib/flow-steps";
import type { AgentLogTail, AgentMessage, ArtifactRecord, DashboardSnapshot, EventRecord, FlowStepInstanceRecord } from "@/lib/types";
import { EmptyState } from "./ui";

type Tab = "chat" | "events" | "artifacts" | "logs";
const INITIAL_MESSAGE_LIMIT = 48;
const MESSAGE_LOAD_STEP = 48;
const MAX_VISIBLE_MESSAGES = 42;
const MAX_REQUESTED_MESSAGES = 1000;

export function WorkspacePanel({
  snapshot,
  selectedAgentId,
  selectedStepInstanceId,
  liveLog
}: {
  snapshot: DashboardSnapshot;
  selectedAgentId: string | null;
  selectedStepInstanceId: string | null;
  liveLog: AgentLogTail | null;
}) {
  const [tab, setTab] = useState<Tab>("chat");
  const [messageLimit, setMessageLimit] = useState(INITIAL_MESSAGE_LIMIT);
  const agent = snapshot.agents.find((candidate) => candidate.agent_id === selectedAgentId) ?? snapshot.agents[0] ?? null;
  const agentId = agent?.agent_id ?? null;
  const flowSteps = agentFlowSteps(snapshot, agentId);
  const selectedStep =
    flowSteps.find((step) => step.step_instance_id === selectedStepInstanceId) ?? flowSteps[0] ?? null;
  const scopedEvents = useMemo(
    () => filterEventsForSelection(snapshot.latest_events, agentId, selectedStep?.step_instance_id ?? null),
    [agentId, selectedStep?.step_instance_id, snapshot.latest_events]
  );
  const scopedArtifacts = useMemo(
    () => filterArtifactsForSelection(snapshot, agentId, selectedStep?.step_instance_id ?? null),
    [agentId, selectedStep?.step_instance_id, snapshot]
  );

  useEffect(() => {
    setMessageLimit(INITIAL_MESSAGE_LIMIT);
  }, [agentId, selectedStep?.step_instance_id]);

  const messages = useQuery({
    enabled: Boolean(agentId),
    queryKey: ["messages", agentId, messageLimit],
    queryFn: () => fetchAgentMessages(agentId!, messageLimit),
    refetchInterval: 6000
  });
  const log = useQuery({
    enabled: Boolean(agentId),
    queryKey: ["log", agentId],
    queryFn: () => fetchAgentLog(agentId!, 24000),
    refetchInterval: liveLog?.agent_id === agentId ? false : 4500
  });
  const activeLog = liveLog?.agent_id === agentId ? liveLog : log.data ?? null;

  return (
    <section className="workspace-panel flex h-full min-h-0 flex-col bg-white">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-black/8 bg-white/72 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-ink-900">{agent?.title ?? "Select an agent"}</div>
          <div className="truncate text-[11px] text-ink-400">
            {agent ? (
              <>
                {compactId(agent.agent_id)}
                {selectedStep ? ` · instance #${flowStepOrdinal(snapshot, selectedStep)} · ${selectedStep.step_id}` : ""}
              </>
            ) : (
              "No thread selected"
            )}
          </div>
        </div>
        <div className="workspace-tabs flex shrink-0 items-center gap-1">
          <TabButton active={tab === "chat"} icon={MessageSquareText} label="Chat" onClick={() => setTab("chat")} />
          <TabButton active={tab === "events"} icon={ListTree} label="Events" onClick={() => setTab("events")} />
          <TabButton active={tab === "artifacts"} icon={Files} label="Artifacts" onClick={() => setTab("artifacts")} />
          <TabButton active={tab === "logs"} icon={ScrollText} label="Logs" onClick={() => setTab("logs")} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "chat" ? (
          <ChatView
            agentId={agentId}
            artifacts={scopedArtifacts}
            events={scopedEvents}
            log={activeLog}
            selectedStep={selectedStep}
            messages={messages.data ?? []}
            onRequestOlder={() => setMessageLimit((value) => Math.min(MAX_REQUESTED_MESSAGES, value + MESSAGE_LOAD_STEP))}
            requestedLimit={messageLimit}
          />
        ) : tab === "events" ? (
          <EventsTable events={scopedEvents} />
        ) : tab === "artifacts" ? (
          <ArtifactsView artifacts={scopedArtifacts} />
        ) : (
          <LogView log={activeLog} />
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: typeof MessageSquareText;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={[
        "workspace-tab-button inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
        active ? "border-ink-900 bg-ink-900 text-white" : "border-black/10 bg-white text-ink-500 hover:text-ink-900"
      ].join(" ")}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-3.5" />
      <span className="workspace-tab-label whitespace-nowrap">{label}</span>
    </button>
  );
}

function filterEventsForSelection(
  events: EventRecord[],
  agentId: string | null,
  stepInstanceId: string | null
): EventRecord[] {
  const agentEvents = agentId ? events.filter((event) => event.agent_id === agentId || !event.agent_id) : events;
  return stepInstanceId ? agentEvents.filter((event) => eventReferencesFlowStep(event, stepInstanceId)) : agentEvents;
}

function filterArtifactsForSelection(
  snapshot: DashboardSnapshot,
  agentId: string | null,
  stepInstanceId: string | null
): ArtifactRecord[] {
  if (stepInstanceId) {
    return snapshot.artifacts.filter((artifact) => artifactReferencesFlowStep(snapshot, artifact, stepInstanceId));
  }
  const agentArtifacts = agentId
    ? snapshot.artifacts.filter((artifact) => artifact.agent_id === agentId)
    : snapshot.artifacts;
  return agentArtifacts;
}

function scopeMessagesToStep(messages: AgentMessage[], stepInstanceId: string | null): AgentMessage[] {
  if (!stepInstanceId) {
    return messages;
  }
  const scoped = messages.filter((message) => messageReferencesFlowStep(message, stepInstanceId));
  return scoped.length > 0 ? scoped : messages;
}

function messageReferencesFlowStep(message: AgentMessage, stepInstanceId: string): boolean {
  return unknownRecordContainsStep(message.metadata, stepInstanceId);
}

function unknownRecordContainsStep(value: unknown, stepInstanceId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => unknownRecordContainsStep(item, stepInstanceId));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "step_instance_id" || key === "stepInstanceId") && nested === stepInstanceId) {
      return true;
    }
    if (unknownRecordContainsStep(nested, stepInstanceId)) {
      return true;
    }
  }
  return false;
}

function ChatView({
  agentId,
  artifacts,
  events,
  log,
  selectedStep,
  messages,
  onRequestOlder,
  requestedLimit
}: {
  agentId: string | null;
  artifacts: ArtifactRecord[];
  events: EventRecord[];
  log: AgentLogTail | null;
  selectedStep: FlowStepInstanceRecord | null;
  messages: AgentMessage[];
  onRequestOlder: () => void;
  requestedLimit: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousAgentRef = useRef<string | null>(null);
  const previousBlockCountRef = useRef(0);
  const [windowStart, setWindowStart] = useState(0);
  const scopedMessages = scopeMessagesToStep(messages, selectedStep?.step_instance_id ?? null);
  const normalizedTurns = normalizeMessages(scopedMessages);
  const messagesAreLogFallback = scopedMessages.length > 0 && scopedMessages.every((message) => message.metadata?.source === "opencode-log-tail");
  const usingStructuredMessages = normalizedTurns.length > 0 && !messagesAreLogFallback;
  const logBlocks = log && log.tail ? parseLogTail(log.tail) : [];
  const blocks = usingStructuredMessages ? normalizedTurns : logBlocks.length > 0 ? logBlocks : normalizedTurns;
  const agentArtifacts = artifacts;
  const agentEvents = events.slice(0, 6);
  const maxWindowStart = Math.max(0, blocks.length - MAX_VISIBLE_MESSAGES);
  const hasMoreServerHistory = messages.length >= requestedLimit && requestedLimit < MAX_REQUESTED_MESSAGES;
  const visibleStart = Math.min(windowStart, maxWindowStart);
  const visibleBlocks = blocks.slice(visibleStart, visibleStart + MAX_VISIBLE_MESSAGES);
  const hiddenBefore = visibleStart;
  const hiddenAfter = Math.max(0, blocks.length - visibleStart - visibleBlocks.length);

  useEffect(() => {
    const previousAgentId = previousAgentRef.current;
    const previousBlockCount = previousBlockCountRef.current;
    const agentChanged = previousAgentId !== agentId;
    const firstLoad = previousBlockCount === 0 && blocks.length > 0;
    const historyShrank = blocks.length < previousBlockCount;

    if (agentChanged || firstLoad || historyShrank) {
      setWindowStart(maxWindowStart);
    } else if (windowStart > maxWindowStart) {
      setWindowStart(maxWindowStart);
    }

    previousAgentRef.current = agentId;
    previousBlockCountRef.current = blocks.length;
  }, [agentId, blocks.length, maxWindowStart, windowStart]);

  if (blocks.length === 0) {
    return <EmptyState detail="No messages or log tail are available for this agent yet." title="Quiet thread" />;
  }

  const showOlder = () => {
    if (visibleStart > 0) {
      setWindowStart(Math.max(0, visibleStart - Math.floor(MAX_VISIBLE_MESSAGES * 0.75)));
      return;
    }
    if (hasMoreServerHistory) {
      onRequestOlder();
    }
  };

  const showNewer = () => {
    setWindowStart(Math.min(maxWindowStart, visibleStart + Math.floor(MAX_VISIBLE_MESSAGES * 0.75)));
  };

  return (
    <div className="thread-grid h-full min-h-0">
      <div
        className="agent-scroll min-h-0 overflow-auto border-r border-black/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.88),rgba(249,250,251,0.72))] p-4"
        onScroll={(event) => {
          const node = event.currentTarget;
          if (node.scrollTop < 48) {
            showOlder();
          } else if (node.scrollHeight - node.scrollTop - node.clientHeight < 48) {
            showNewer();
          }
        }}
        ref={scrollRef}
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          <HistoryWindowControl
            count={hiddenBefore}
            label={hasMoreServerHistory && visibleStart === 0 ? "Load older thread history" : "Show older loaded messages"}
            onClick={showOlder}
            visible={hiddenBefore > 0 || hasMoreServerHistory}
          />
          {visibleBlocks.map((turn, index) => (
            <TurnBlock artifacts={artifacts} key={`${turn.id}-${index}`} turn={turn} />
          ))}
          <HistoryWindowControl
            count={hiddenAfter}
            label="Show newer messages"
            onClick={showNewer}
            visible={hiddenAfter > 0}
          />
        </div>
      </div>
      <ThreadSidecar
        artifacts={agentArtifacts}
        events={agentEvents}
        loadedCount={blocks.length}
        log={log}
        requestedLimit={requestedLimit}
        selectedStep={selectedStep}
        source={usingStructuredMessages ? "structured" : blocks.length > 0 ? "log" : "empty"}
        visibleCount={visibleBlocks.length}
      />
    </div>
  );
}

function HistoryWindowControl({
  count,
  label,
  onClick,
  visible
}: {
  count: number;
  label: string;
  onClick: () => void;
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }
  return (
    <button
      className="mx-auto inline-flex items-center gap-2 rounded-md border border-black/10 bg-white/84 px-3 py-1.5 text-[11px] font-medium text-ink-500 shadow-hairline transition hover:border-black/20 hover:text-ink-900"
      onClick={onClick}
      type="button"
    >
      {label}
      {count > 0 ? <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px]">{count}</span> : null}
    </button>
  );
}

interface RenderThreadTurn {
  id: string;
  role: string;
  created_at?: string;
  parts: RenderMessagePart[];
}

interface RenderMessagePart {
  id?: string;
  role: string;
  text: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  kind?: "message" | "tool" | "reasoning" | "log";
}

function normalizeMessages(messages: AgentMessage[]): RenderThreadTurn[] {
  const turns: RenderThreadTurn[] = [];
  const turnIndex = new Map<string, RenderThreadTurn>();

  messages.forEach((message, index) => {
    const role = normalizeRenderRole(message.role);
    const part: RenderMessagePart = {
      id: message.id ?? `message-${index}`,
      role,
      text: typeof message.text === "string" ? message.text : safeJson(message),
      created_at: typeof message.created_at === "string" ? message.created_at : undefined,
      metadata: message.metadata,
      kind: inferKind(message)
    };

    if (part.text.trim().length === 0) {
      return;
    }

    const key = messageTurnKey(message, index);
    const existing = turnIndex.get(key);
    if (existing) {
      existing.parts.push(part);
      existing.created_at = earliestDate(existing.created_at, part.created_at);
      existing.role = preferredTurnRole(existing.role, part.role);
      return;
    }

    const turn: RenderThreadTurn = {
      id: key,
      role: part.role,
      created_at: part.created_at,
      parts: [part]
    };
    turnIndex.set(key, turn);
    turns.push(turn);
  });

  return turns;
}

function messageTurnKey(message: AgentMessage, index: number): string {
  const metadataMessageId = stringMetadataField(message.metadata, "messageId");
  const metadataSessionId = stringMetadataField(message.metadata, "sessionId");
  if (metadataMessageId) {
    return metadataSessionId ? `${metadataSessionId}:${metadataMessageId}` : metadataMessageId;
  }
  return typeof message.id === "string" ? message.id : `message-${index}`;
}

function stringMetadataField(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function earliestDate(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function preferredTurnRole(current: string, next: string): string {
  if (current === "tool" && next !== "tool") return next;
  return current;
}

function normalizeRenderRole(role: unknown): string {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return "assistant";
}

function inferKind(message: AgentMessage): RenderMessagePart["kind"] {
  const metadata = message.metadata ?? {};
  const text = typeof message.text === "string" ? message.text : "";
  if (metadata.type === "tool" || /tool|function/i.test(String(metadata.kind ?? ""))) return "tool";
  if (metadata.type === "reasoning" || /reasoning/i.test(String(metadata.kind ?? ""))) return "reasoning";
  if (/^\s*\{[\s\S]*"tool"/i.test(text)) return "tool";
  return "message";
}

function parseLogTail(tail: string): RenderThreadTurn[] {
  const chunks = tail
    .split(/\n(?=(?:\\[[0-9:. -]+\\]|INFO|ERROR|WARN|Tool|tool|assistant|user|reasoning))/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(-18);
  return chunks.map((chunk, index) => {
    const role = /error|warn/i.test(chunk) ? "system" : /user/i.test(chunk.slice(0, 40)) ? "user" : "assistant";
    return {
      id: `log-${index}`,
      role,
      parts: [
        {
          id: `log-${index}-part`,
          role,
          text: chunk,
          kind: /tool|function|exec|command/i.test(chunk.slice(0, 220))
            ? "tool"
            : /reasoning|thought/i.test(chunk.slice(0, 220))
              ? "reasoning"
              : "log"
        }
      ]
    };
  });
}

function TurnBlock({ artifacts, turn }: { artifacts: ArtifactRecord[]; turn: RenderThreadTurn }) {
  if (turn.role === "user") {
    return <PromptTurnBlock artifacts={artifacts} turn={turn} />;
  }

  const onlyPart = turn.parts.length === 1 ? turn.parts[0] : null;
  const Icon = onlyPart?.kind === "tool" ? Wrench : turn.role === "user" ? TerminalSquare : turn.role === "system" ? Braces : Bot;
  return (
    <article className="group/turn flex gap-3 rounded-md px-2 py-2 transition hover:bg-black/[0.025]">
      <TurnRail icon={Icon} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-xs font-semibold text-ink-900">{roleLabel(turn.role)}</span>
          {turn.created_at ? <span className="text-[11px] text-ink-300">{formatDateTime(turn.created_at)}</span> : null}
        </div>
        <div className="flex flex-col gap-2">
          {turn.parts.map((part, index) => (
            <TurnPart artifacts={artifacts} key={`${part.id ?? index}-${index}`} part={part} />
          ))}
        </div>
      </div>
    </article>
  );
}

function PromptTurnBlock({ artifacts, turn }: { artifacts: ArtifactRecord[]; turn: RenderThreadTurn }) {
  return (
    <article className="flex justify-end py-2">
      <div className="group/turn flex max-w-[min(38rem,76%)] flex-row-reverse gap-3 rounded-md bg-black/[0.04] px-2 py-2">
        <TurnRail icon={TerminalSquare} />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-baseline justify-end gap-2">
            {turn.created_at ? <span className="text-[11px] text-ink-300">{formatDateTime(turn.created_at)}</span> : null}
            <span className="text-xs font-semibold text-ink-900">user</span>
          </div>
          <div className="flex flex-col gap-2 text-left">
            {turn.parts.map((part, index) => (
              <PromptPart artifacts={artifacts} key={`${part.id ?? index}-${index}`} part={part} />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function TurnRail({
  icon: Icon
}: {
  icon: typeof Bot;
}) {
  return (
    <div className="mt-0.5 size-8 shrink-0">
      <div className="grid size-8 place-items-center rounded-md bg-ink-900 text-white shadow-hairline">
        <Icon className="size-4" strokeWidth={1.8} />
      </div>
    </div>
  );
}

function PromptPart({ artifacts, part }: { artifacts: ArtifactRecord[]; part: RenderMessagePart }) {
  if (!isLongPrompt(part.text)) {
    return <TurnPart artifacts={artifacts} part={part} />;
  }

  return (
    <details className="rounded-md border border-black/8 bg-white/54 px-2 py-1.5">
      <summary className="cursor-pointer text-xs font-medium text-ink-700">
        Prompt sent to agent
        <span className="ml-2 font-normal text-ink-400">{promptPreview(part.text)}</span>
      </summary>
      <div className="mt-2">
        <TurnPart artifacts={artifacts} part={part} />
      </div>
    </details>
  );
}

function isLongPrompt(text: string): boolean {
  return (
    text.length > 1400 ||
    /Runtime Contract|Reporting Contract|step_instance_id|flow report|result schema/i.test(text)
  );
}

function promptPreview(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "";
  }
  return firstLine.length > 96 ? `${firstLine.slice(0, 96)}...` : firstLine;
}

function TurnPart({
  artifacts,
  part
}: {
  artifacts: ArtifactRecord[];
  part: RenderMessagePart;
}) {
  const isTool = part.kind === "tool";
  const isReasoning = part.kind === "reasoning";
  const isAttachment = isReasoning || isTool;
  const metadata = partMetadata(part);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const attachmentTone = isTool
    ? "border-blue-300 bg-blue-50/58 text-blue-900"
    : "border-amber-300 bg-amber-50/58 text-amber-900";

  useEffect(() => {
    if (!metadataOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setMetadataOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMetadataOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [metadataOpen]);

  const handleMetadataShortcut = (event: MouseEvent<HTMLDivElement>) => {
    if (!metadata || !event.ctrlKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setMetadataOpen(true);
  };

  return (
    <div
      className="relative"
      data-has-metadata={metadata ? "true" : undefined}
      onClick={handleMetadataShortcut}
      onContextMenu={handleMetadataShortcut}
      ref={rootRef}
    >
      {isAttachment ? (
        <details className={["border-l-2 py-1 pl-3", attachmentTone].join(" ")}>
          <summary className="cursor-pointer text-xs font-medium">{isReasoning ? "Reasoning" : "Tool call"}</summary>
          <RichText artifacts={artifacts} text={part.text} />
        </details>
      ) : (
        <RichText artifacts={artifacts} text={part.text} />
      )}
      {metadata && metadataOpen ? (
        <pre className="absolute right-0 top-6 z-30 max-h-64 w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-md border border-black/10 bg-ink-900 p-2 text-[10px] leading-4 text-white shadow-lg">
          {safeJson(metadata)}
        </pre>
      ) : null}
    </div>
  );
}

function roleLabel(role: string): string {
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  if (role === "user") return "user";
  return "assistant";
}

function partMetadata(part: RenderMessagePart): Record<string, unknown> | null {
  if (!part.metadata || Object.keys(part.metadata).length === 0) {
    return null;
  }

  return part.metadata;
}

function RichText({ artifacts, inverted = false, text }: { artifacts: ArtifactRecord[]; inverted?: boolean; text: string }) {
  const imagePaths = [...text.matchAll(/!\[[^\]]*]\(([^)]+)\)|((?:\/[^\s)]+)\.(?:png|jpe?g|gif|webp))/gi)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean);
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const codeFence = text.includes("```");
  if (codeFence) {
    return <CodeFence text={text} />;
  }
  return (
    <div className={["chat-prose text-xs leading-5", inverted ? "text-white/88" : "text-ink-700"].join(" ")}>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p className="mb-2 whitespace-pre-wrap" key={`${paragraph.slice(0, 20)}-${index}`}>
          {paragraph}
        </p>
      ))}
      {imagePaths.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {imagePaths.slice(0, 4).map((path) => {
            const artifact = artifactByPath.get(path);
            const src = artifact ? artifactImageUrl(artifact.artifact_id) : path;
            return (
              <a className="group overflow-hidden rounded-lg border border-black/10 bg-white" href={src} key={path} target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={path} className="aspect-video w-full object-cover transition group-hover:scale-[1.02]" src={src} />
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ThreadSidecar({
  artifacts,
  events,
  loadedCount,
  log,
  requestedLimit,
  selectedStep,
  source,
  visibleCount
}: {
  artifacts: ArtifactRecord[];
  events: EventRecord[];
  loadedCount: number;
  log: AgentLogTail | null;
  requestedLimit: number;
  selectedStep: FlowStepInstanceRecord | null;
  source: "structured" | "log" | "empty";
  visibleCount: number;
}) {
  const imageArtifacts = artifacts.filter((artifact) => isImageArtifact(artifact.path)).slice(0, 4);
  return (
    <aside className="thread-sidecar agent-scroll min-h-0 overflow-auto bg-white/70 p-3">
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-black/10 bg-white p-3 shadow-hairline">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink-800">
            <Clock3 className="size-3.5 text-ink-400" />
            Live Tail
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-ink-500">
            {selectedStep ? (
              <>
                <span>instance</span>
                <span className="truncate text-right font-medium text-ink-800">{selectedStep.step_id}</span>
              </>
            ) : null}
            <span>visible</span>
            <span className="text-right font-medium text-ink-800">{visibleCount}</span>
            <span>loaded</span>
            <span className="text-right font-medium text-ink-800">{loadedCount}</span>
            <span>requested</span>
            <span className="text-right font-medium text-ink-800">{requestedLimit}</span>
            <span>bytes</span>
            <span className="text-right font-medium text-ink-800">{log?.bytes ?? 0}</span>
            <span>source</span>
            <span className="truncate text-right font-medium text-ink-800">
              {source === "structured" ? "OpenCode messages" : source === "log" ? "runtime log" : "waiting"}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-3 shadow-hairline">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink-800">
            <ImageIcon className="size-3.5 text-ink-400" />
            Inline Media
          </div>
          {imageArtifacts.length === 0 ? (
            <div className="rounded-md border border-dashed border-black/10 bg-canvas-50 px-2 py-2 text-[11px] text-ink-400">
              No image artifacts for this agent.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {imageArtifacts.map((artifact) => (
                <a
                  className="group overflow-hidden rounded-md border border-black/10 bg-canvas-50"
                  href={artifactImageUrl(artifact.artifact_id)}
                  key={artifact.artifact_id}
                  target="_blank"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt={artifact.label} className="aspect-square w-full object-cover transition group-hover:scale-[1.03]" src={artifactImageUrl(artifact.artifact_id)} />
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-3 shadow-hairline">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink-800">
            <ListTree className="size-3.5 text-ink-400" />
            Recent Events
          </div>
          <div className="flex flex-col gap-1.5">
            {events.length === 0 ? (
              <div className="rounded-md border border-dashed border-black/10 bg-canvas-50 px-2 py-2 text-[11px] text-ink-400">
                No recent events.
              </div>
            ) : (
              events.map((event) => (
                <div className="rounded-md border border-black/8 bg-canvas-50 px-2 py-1.5" key={event.event_id}>
                  <div className="truncate text-[11px] font-semibold text-ink-700">{event.type}</div>
                  <div className="text-[10px] text-ink-400">{formatDateTime(event.created_at)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function CodeFence({ text }: { text: string }) {
  return (
    <div className="chat-prose text-xs leading-5 text-ink-700">
      {text.split(/```/).map((part, index) =>
        index % 2 === 1 ? (
          <pre key={index}>
            <code>{part.replace(/^[a-zA-Z0-9_-]+\n/, "")}</code>
          </pre>
        ) : (
          <p className="mb-2 whitespace-pre-wrap" key={index}>
            {part}
          </p>
        )
      )}
    </div>
  );
}

function EventsTable({ events }: { events: EventRecord[] }) {
  const rows = events;
  const columns = useMemo<ColumnDef<EventRecord>[]>(
    () => [
      { header: "Time", accessorFn: (row) => formatDateTime(row.created_at) },
      { header: "Type", accessorKey: "type" },
      { header: "Agent", accessorFn: (row) => (row.agent_id ? compactId(row.agent_id) : "run") },
      { header: "Payload", accessorFn: (row) => safeJson(row.payload).slice(0, 160) }
    ],
    []
  );
  const table = useReactTable({ columns, data: rows, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="agent-scroll h-full overflow-auto p-3">
      <table className="w-full border-separate border-spacing-0 text-left text-xs">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th className="sticky top-0 border-b border-black/10 bg-white/95 px-2 py-2 text-[11px] uppercase tracking-[0.08em] text-ink-400" key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr className="hover:bg-canvas-50" key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td className="max-w-[28rem] border-b border-black/5 px-2 py-2 align-top text-ink-600" key={cell.id}>
                  <span className="line-clamp-2">{flexRender(cell.column.columnDef.cell, cell.getContext())}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactsView({ artifacts }: { artifacts: ArtifactRecord[] }) {
  const rows = artifacts;
  if (rows.length === 0) {
    return <EmptyState detail="Registered artifacts and supported image previews appear here." title="No artifacts" />;
  }
  return (
    <div className="agent-scroll grid h-full auto-rows-min grid-cols-1 gap-3 overflow-auto p-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((artifact) => (
        <div className="rounded-lg border border-black/10 bg-white p-3 shadow-hairline" key={artifact.artifact_id}>
          <div className="flex items-start gap-2">
            {isImageArtifact(artifact.path) ? (
              <FileImage className="mt-0.5 size-4 shrink-0 text-ink-400" />
            ) : (
              <FileText className="mt-0.5 size-4 shrink-0 text-ink-400" />
            )}
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-ink-800">{artifact.label}</div>
              <div className="truncate text-[11px] text-ink-400">{artifact.path}</div>
            </div>
          </div>
          {isImageArtifact(artifact.path) ? (
            <a
              className="mt-3 block overflow-hidden rounded-md border border-black/8 bg-canvas-50"
              href={artifactImageUrl(artifact.artifact_id)}
              target="_blank"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={artifact.label} className="aspect-video w-full object-cover" src={artifactImageUrl(artifact.artifact_id)} />
            </a>
          ) : (
            <div className="mt-3 rounded-md border border-dashed border-black/10 bg-canvas-50 px-3 py-2 text-[11px] leading-4 text-ink-500">
              Registered file artifact. Use the path above to inspect it from the local machine.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function isImageArtifact(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path);
}

function LogView({ log }: { log: AgentLogTail | null }) {
  if (!log?.tail) {
    return <EmptyState detail="The selected backend has not exposed a log tail yet." title="No live log" />;
  }
  return (
    <div className="agent-scroll h-full overflow-auto bg-[#10151a] p-3">
      <pre className="whitespace-pre-wrap text-xs leading-5 text-[#d8e6e1]">{log.tail}</pre>
    </div>
  );
}
