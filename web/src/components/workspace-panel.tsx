"use client";

import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import rehypeHighlight from "rehype-highlight";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
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
import { isValidElement, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { artifactImageUrl, fetchAgentLog, fetchAgentMessages } from "@/lib/api";
import { compactId, formatDateTime, safeJson } from "@/lib/format";
import { agentFlowSteps, artifactReferencesFlowStep, eventReferencesFlowStep, flowStepOrdinal } from "@/lib/flow-steps";
import { buildFlowEvidenceView } from "@/lib/flow-evidence";
import { shouldTryMcpApp } from "@/lib/mcp-app";
import type { AgentLogTail, AgentMessage, ArtifactRecord, DashboardSnapshot, EventRecord, FlowStepInstanceRecord } from "@/lib/types";
import {
  MAX_AGENT_MESSAGE_LIMIT,
  agentLogQueryKey,
  agentMessagesQueryKey,
  workspaceRefreshPolicy
} from "@/lib/workspace-refresh-policy";
import { EmptyState } from "./ui";
import { FlowEvidenceDetails } from "./flow-evidence";

type Tab = "chat" | "events" | "artifacts" | "logs";
const MAX_VISIBLE_MESSAGES = 42;

export function WorkspacePanel({
  compact = false,
  snapshot,
  selectedAgentId,
  selectedStepInstanceId,
  liveLog,
  connectionError = null,
  messageLimit,
  onRequestOlderMessages
}: {
  compact?: boolean;
  snapshot: DashboardSnapshot;
  selectedAgentId: string | null;
  selectedStepInstanceId: string | null;
  liveLog: AgentLogTail | null;
  connectionError?: Error | null;
  messageLimit: number;
  onRequestOlderMessages: () => void;
}) {
  const [tab, setTab] = useState<Tab>("chat");
  const agent = snapshot.agents.find((candidate) => candidate.agent_id === selectedAgentId) ?? snapshot.agents[0] ?? null;
  const agentId = agent?.agent_id ?? null;
  const flowSteps = agentFlowSteps(snapshot, agentId);
  const selectedStep =
    flowSteps.find((step) => step.step_instance_id === selectedStepInstanceId) ?? flowSteps[0] ?? null;
  const evidence = buildFlowEvidenceView(snapshot, { stepInstanceId: selectedStep?.step_instance_id });
  const currentPhaseEvidence = buildFlowEvidenceView(snapshot, { flowInstanceId: selectedStep?.flow_instance_id });
  const visibleEvidence = currentPhaseEvidence?.decision || currentPhaseEvidence?.continuation ? currentPhaseEvidence : evidence;
  const scopedEvents = useMemo(
    () => filterEventsForSelection(snapshot.latest_events, agentId, selectedStep?.step_instance_id ?? null),
    [agentId, selectedStep?.step_instance_id, snapshot.latest_events]
  );
  const scopedArtifacts = useMemo(
    () => filterArtifactsForSelection(snapshot, agentId, selectedStep?.step_instance_id ?? null),
    [agentId, selectedStep?.step_instance_id, snapshot]
  );

  const refreshPolicy = workspaceRefreshPolicy({
    mcpMode: shouldTryMcpApp(),
    hasAgent: Boolean(agentId),
    hasLiveLog: liveLog?.agent_id === agentId
  });

  const messages = useQuery({
    enabled: refreshPolicy.messagesEnabled,
    queryKey: agentMessagesQueryKey(agentId, messageLimit),
    queryFn: () => fetchAgentMessages(agentId!, messageLimit),
    // A larger history request keeps this agent's last page during an outage;
    // never carry another agent's transcript across a selection change.
    placeholderData: (previous, query) => query?.queryKey[1] === agentId ? previous : undefined,
    refetchInterval: refreshPolicy.messagesRefetchInterval
  });
  const log = useQuery({
    enabled: refreshPolicy.logEnabled,
    queryKey: agentLogQueryKey(agentId),
    queryFn: () => fetchAgentLog(agentId!, 24000),
    refetchInterval: refreshPolicy.logRefetchInterval
  });
  const activeLog = liveLog?.agent_id === agentId ? liveLog : log.data ?? null;
  const messageError = messages.error instanceof Error ? messages.error : messages.error ? new Error(String(messages.error)) : null;
  const logError = log.error instanceof Error ? log.error : log.error ? new Error(String(log.error)) : null;
  const messageReady = messages.status === "success";
  const logReady = !refreshPolicy.logEnabled || log.status === "success" || activeLog !== null;
  const chatLoading = Boolean(agentId) && !connectionError && !messageError && !logError && (!messageReady || !logReady);

  return (
    <section className="workspace-panel flex h-full min-h-0 flex-col bg-white" data-compact={compact ? "true" : "false"}>
      {!compact ? (
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
      ) : null}
      {visibleEvidence?.available ? <div className="shrink-0 px-3 py-2"><FlowEvidenceDetails view={visibleEvidence} /></div> : null}
      <div className="min-h-0 flex-1">
        {tab === "chat" ? (
          <div className="agent-chat h-full min-h-0">
            <ChatView
              agentId={agentId}
              artifacts={scopedArtifacts}
              events={scopedEvents}
              log={activeLog}
              selectedStep={selectedStep}
              messages={messages.data ?? []}
              onRequestOlder={onRequestOlderMessages}
              requestedLimit={messageLimit}
              compact
              error={connectionError ?? messageError ?? logError}
              loading={chatLoading}
              showSidecar={false}
            />
          </div>
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
  requestedLimit,
  compact,
  error,
  loading,
  showSidecar
}: {
  agentId: string | null;
  artifacts: ArtifactRecord[];
  events: EventRecord[];
  log: AgentLogTail | null;
  selectedStep: FlowStepInstanceRecord | null;
  messages: AgentMessage[];
  onRequestOlder: () => void;
  requestedLimit: number;
  compact: boolean;
  error: Error | null;
  loading: boolean;
  showSidecar: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousAgentRef = useRef<string | null>(null);
  const previousBlockCountRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const [windowStart, setWindowStart] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scopedMessages = scopeMessagesToStep(messages, selectedStep?.step_instance_id ?? null);
  const normalizedTurns = normalizeMessages(scopedMessages);
  const messagesAreLogFallback = scopedMessages.length > 0 && scopedMessages.every((message) => message.metadata?.source === "opencode-log-tail");
  const usingStructuredMessages = normalizedTurns.length > 0 && !messagesAreLogFallback;
  const logBlocks = log && log.tail ? parseLogTail(log.tail) : [];
  const blocks = usingStructuredMessages ? normalizedTurns : logBlocks.length > 0 ? logBlocks : normalizedTurns;
  const agentArtifacts = artifacts;
  const agentEvents = events.slice(0, 6);
  const maxWindowStart = Math.max(0, blocks.length - MAX_VISIBLE_MESSAGES);
  const hasMoreServerHistory = messages.length >= requestedLimit && requestedLimit < MAX_AGENT_MESSAGE_LIMIT;
  const visibleStart = Math.min(windowStart, maxWindowStart);
  const visibleBlocks = blocks.slice(visibleStart, visibleStart + MAX_VISIBLE_MESSAGES);
  const hiddenBefore = visibleStart;
  const hiddenAfter = Math.max(0, blocks.length - visibleStart - visibleBlocks.length);
  const todoItems = extractTodoItems(blocks);

  const scheduleScrollToBottom = (behavior: ScrollBehavior = "auto") => {
    // The message list and the Todo overlay both change height after a new
    // turn renders, so wait two frames before measuring the final scrollHeight.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (!node) {
          return;
        }
        node.scrollTo({ top: node.scrollHeight, behavior });
        isAtBottomRef.current = true;
        setShowScrollToBottom(false);
      });
    });
  };

  useEffect(() => {
    const previousAgentId = previousAgentRef.current;
    const previousBlockCount = previousBlockCountRef.current;
    const agentChanged = previousAgentId !== agentId;
    const firstLoad = previousBlockCount === 0 && blocks.length > 0;
    const historyShrank = blocks.length < previousBlockCount;
    const newBlocksArrived = blocks.length > previousBlockCount;

    if (agentChanged || firstLoad || historyShrank) {
      setWindowStart(maxWindowStart);
      isAtBottomRef.current = true;
      setShowScrollToBottom(false);
      scheduleScrollToBottom();
    } else if (newBlocksArrived && isAtBottomRef.current) {
      setWindowStart(maxWindowStart);
      scheduleScrollToBottom("smooth");
    } else if (windowStart > maxWindowStart) {
      setWindowStart(maxWindowStart);
    }

    previousAgentRef.current = agentId;
    previousBlockCountRef.current = blocks.length;
  }, [agentId, blocks.length, maxWindowStart, windowStart]);

  if (blocks.length === 0 && error) {
    // Connection state belongs in the compact header, never over the chat.
    return null;
  }

  if (blocks.length === 0 && loading) {
    return <EmptyState detail="Loading messages and runtime output." title="Loading thread" />;
  }

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

  const jumpToLatest = () => {
    setWindowStart(maxWindowStart);
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);
    scheduleScrollToBottom("smooth");
  };

  return (
    <div className="thread-grid h-full min-h-0" data-has-todo={todoItems.length > 0 ? "true" : "false"}>
      <div
        className="agent-scroll min-h-0 overflow-auto border-r border-black/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.88),rgba(249,250,251,0.72))] p-4"
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
          isAtBottomRef.current = atBottom;
          setShowScrollToBottom(!atBottom && node.scrollHeight > node.clientHeight + 48);
          if (node.scrollTop < 48) {
            showOlder();
          } else if (atBottom) {
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
            <TurnBlock artifacts={artifacts} compact={compact} key={`${turn.id}-${index}`} turn={turn} />
          ))}
          <HistoryWindowControl
            count={hiddenAfter}
            label="Show newer messages"
            onClick={showNewer}
            visible={hiddenAfter > 0}
          />
        </div>
      </div>
      {showScrollToBottom ? (
        <button
          aria-label="Jump to latest message"
          className="codex-scroll-to-bottom"
          onClick={jumpToLatest}
          title="Jump to latest message"
          type="button"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
      {showSidecar ? (
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
      ) : null}
      {todoItems.length > 0 ? <TodoOverlay items={todoItems} /> : null}
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

interface TodoItem {
  id: string;
  label: string;
  status: "completed" | "active" | "pending";
}

function extractTodoItems(blocks: RenderThreadTurn[]): TodoItem[] {
  const items = new Map<string, TodoItem>();
  for (const turn of blocks) {
    for (const part of turn.parts) {
      const text = part.text;
      for (const record of todoRecordsFromText(text)) {
        const id = record.id || record.label;
        if (id) {
          items.set(id, record);
        }
      }
    }
  }
  return [...items.values()];
}

function todoRecordsFromText(text: string): TodoItem[] {
  const records: TodoItem[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*)?(?:\[\s*([xX✓✔])\s*\]|\[\s*[-~]\s*\]|\[\s*\])\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    records.push({
      id: match[2],
      label: match[2],
      status: match[1] ? "completed" : "pending"
    });
  }

  const inputStart = text.search(/\binput\s*:/i);
  const jsonStart = inputStart >= 0 ? text.indexOf("{", inputStart) : text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      collectTodoRecords(JSON.parse(text.slice(jsonStart, jsonEnd + 1)), records);
    } catch {
      // Tool output is best-effort; malformed or truncated JSON should not
      // prevent the conversation from rendering.
    }
  }
  return records;
}

function collectTodoRecords(value: unknown, records: TodoItem[], path = "todo"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTodoRecords(item, records, `${path}-${index}`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const label = firstString(record.step, record.content, record.label, record.title, record.text, record.description);
  if (label) {
    const id = firstString(record.id, record.todo_id, record.todoId) ?? label;
    records.push({ id, label, status: normalizeTodoStatus(record.status, record.completed) });
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key.toLowerCase().includes("todo") || key === "items" || key === "tasks" || key === "plan") {
      collectTodoRecords(nested, records, `${path}-${key}`);
    }
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeTodoStatus(status: unknown, completed: unknown): TodoItem["status"] {
  if (completed === true || /^(?:complete|completed|done)$/i.test(String(status ?? ""))) {
    return "completed";
  }
  if (/^(?:active|in[_ -]?progress|running|doing)$/i.test(String(status ?? ""))) {
    return "active";
  }
  return "pending";
}

function TodoOverlay({ items }: { items: TodoItem[] }) {
  const completed = items.filter((item) => item.status === "completed").length;
  return (
    <aside className="codex-todo-panel" aria-label="Todo list">
      <div className="codex-todo-heading">
        <span>TODO</span>
        <span>
          {completed}/{items.length}
        </span>
      </div>
      <div className="codex-todo-items">
        {items.map((item) => (
          <div className={`codex-todo-item codex-todo-item-${item.status}`} key={item.id}>
            <span aria-hidden="true" className="codex-todo-marker">
              {item.status === "completed" ? "✓" : item.status === "active" ? "•" : "○"}
            </span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </aside>
  );
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

function TurnBlock({ artifacts, compact, turn }: { artifacts: ArtifactRecord[]; compact: boolean; turn: RenderThreadTurn }) {
  if (compact) {
    return <CodexTurnBlock artifacts={artifacts} turn={turn} />;
  }

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

/**
 * Keep the worker-only surface close to Codex's conversation grammar: prompts
 * are bubbles, assistant prose has no repeated role label, and tools or
 * reasoning are compact disclosure rows.
 */
function CodexTurnBlock({ artifacts, turn }: { artifacts: ArtifactRecord[]; turn: RenderThreadTurn }) {
  if (turn.role === "user") {
    return (
      <article className="codex-user-turn">
        <div className="codex-user-bubble">
          {turn.parts.map((part, index) => (
            <TurnPart artifacts={artifacts} inverted key={`${part.id ?? index}-${index}`} part={part} />
          ))}
        </div>
      </article>
    );
  }

  return (
    <article className="codex-assistant-turn">
      {turn.parts.map((part, index) => {
        const isTool = part.kind === "tool";
        const isReasoning = part.kind === "reasoning";
        if (!isTool && !isReasoning) {
          return <RichText artifacts={artifacts} key={`${part.id ?? index}-${index}`} text={part.text} />;
        }

        return (
          <details className="codex-activity-row" key={`${part.id ?? index}-${index}`}>
            <summary>
              <span aria-hidden="true" className="codex-activity-chevron">
                ›
              </span>
              <span className="codex-activity-label">{activityLabel(part, isReasoning)}</span>
              <span className="codex-activity-preview">{activityPreview(part.text)}</span>
            </summary>
            <div className="codex-activity-content">
              <RichText artifacts={artifacts} text={part.text} />
            </div>
          </details>
        );
      })}
    </article>
  );
}

function activityLabel(part: RenderMessagePart, isReasoning: boolean): string {
  if (isReasoning) {
    return "Razonamiento";
  }
  const text = part.text.toLowerCase();
  if (text.includes("todo")) {
    return "Lista Todo actualizada";
  }
  if (text.includes("command") || text.includes("exec")) {
    return "Comandos ejecutados";
  }
  return "Herramienta";
}

function activityPreview(text: string): string {
  const preview = text
    .replace(/^\s*(tool|status|title|input|output|error):\s*/gim, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!preview) {
    return "";
  }
  return preview.length > 110 ? `${preview.slice(0, 110)}…` : preview;
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
  inverted = false,
  part
}: {
  artifacts: ArtifactRecord[];
  inverted?: boolean;
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
          <RichText artifacts={artifacts} inverted={inverted} text={part.text} />
        </details>
      ) : (
        <RichText artifacts={artifacts} inverted={inverted} text={part.text} />
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
  const components = useMemo<Components>(() => createMarkdownComponents(artifactByPath), [artifactByPath]);
  const markdown = normalizeMarkdownSource(text);

  return (
    <div className={["chat-prose text-xs leading-5", inverted ? "text-white/88" : "text-ink-700"].join(" ")}>
      <ReactMarkdown components={components} rehypePlugins={[rehypeHighlight]} remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function renderMarkdownBlocks(text: string): ReactNode[] {
  return text.split(/\n{2,}/).map((block, index) => {
    const lines = block.split(/\r?\n/).map((line) => line.trimEnd());
    const firstLine = lines[0]?.trim() ?? "";
    if (/^#{1,4}\s+/.test(firstLine)) {
      const heading = firstLine.replace(/^#{1,4}\s+/, "");
      return (
        <h3 className="mb-2 text-[0.92rem] font-semibold leading-6" key={`heading-${index}`}>
          {renderInlineMarkdown(heading)}
        </h3>
      );
    }

    if (lines.length > 0 && lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
      return (
        <ul className="mb-2 list-disc space-y-1 pl-5" key={`list-${index}`}>
          {lines.map((line, itemIndex) => (
            <li key={`${itemIndex}-${line.slice(0, 20)}`}>{renderInlineMarkdown(line.replace(/^\s*[-*+]\s+/, ""))}</li>
          ))}
        </ul>
      );
    }

    if (lines.length > 0 && lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      return (
        <ol className="mb-2 list-decimal space-y-1 pl-5" key={`ordered-list-${index}`}>
          {lines.map((line, itemIndex) => (
            <li key={`${itemIndex}-${line.slice(0, 20)}`}>{renderInlineMarkdown(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>
          ))}
        </ol>
      );
    }

    return (
      <p className="mb-2 whitespace-pre-wrap" key={`paragraph-${index}`}>
        {renderInlineMarkdown(block)}
      </p>
    );
  });
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^\s)]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push(text.slice(cursor, start));
    }
    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={`strong-${start}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={`code-${start}`}>{token.slice(1, -1)}</code>);
    } else {
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(token);
      if (link) {
        const href = safeMarkdownHref(link[2]);
        nodes.push(
          href ? (
            <a href={href} key={`link-${start}`} rel="noreferrer" target="_blank">
              {link[1]}
            </a>
          ) : (
            link[1]
          )
        );
      } else {
        nodes.push(token);
      }
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function normalizeMarkdownSource(text: string): string {
  // OpenCode logs can contain ANSI cursor/color sequences. They are control
  // data, not Markdown, and otherwise leak into the visible conversation.
  return text
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function createMarkdownComponents(artifactByPath: Map<string, ArtifactRecord>): Components {
  return {
    a({ children, href }) {
      const safeHref = typeof href === "string" ? safeMarkdownHref(href) : null;
      return safeHref ? (
        <a href={safeHref} rel="noreferrer" target="_blank">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    code({ children, className }) {
      return <code className={className}>{children}</code>;
    },
    img({ alt, src }) {
      const path = typeof src === "string" ? src : "";
      const artifact = artifactByPath.get(path);
      const resolvedSrc = artifact ? artifactImageUrl(artifact.artifact_id) : path;
      if (!resolvedSrc) {
        return null;
      }
      return (
        <a className="chat-image-link" href={resolvedSrc} rel="noreferrer" target="_blank">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={alt ?? path} className="chat-image" src={resolvedSrc} />
        </a>
      );
    },
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children;
      if (isValidElement<{ children?: ReactNode; className?: string }>(child)) {
        const className = child.props.className ?? "";
        const language = /language-([\w+-]+)/.exec(className)?.[1]?.toLowerCase();
        if (language === "mermaid") {
          return <MermaidBlock chart={String(child.props.children ?? "").replace(/\n$/, "")} />;
        }
        return (
          <div className="chat-code-shell">
            {language ? <div className="chat-code-language">{language}</div> : null}
            <pre>{children}</pre>
          </div>
        );
      }
      return <pre>{children}</pre>;
    },
    table({ children }) {
      return (
        <div className="chat-table-wrap">
          <table>{children}</table>
        </div>
      );
    }
  };
}

function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mermaidId = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ securityLevel: "strict", startOnLoad: false, theme: "dark" });
        const result = await mermaid.render(mermaidId, chart);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = result.svg;
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Mermaid diagram could not be rendered.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chart, mermaidId]);

  if (error) {
    return (
      <div className="chat-code-shell chat-mermaid-error">
        <div className="chat-code-language">mermaid · {error}</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return <div aria-label="Mermaid diagram" className="chat-mermaid" ref={containerRef} />;
}

function safeMarkdownHref(value: string): string | null {
  if (value.startsWith("/") || value.startsWith("#")) {
    return value;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
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
