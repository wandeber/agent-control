"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentMessages } from "@/lib/api";
import { ChatView } from "./workspace-panel";

/** Fetch only after a deliberate hover; keep the preview open while reading it. */
export function AgentChatPreview({ agentId, children }: { agentId: string; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const clear = () => clearTimeout(timer.current);
  const open = () => {
    clear();
    timer.current = setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 448)), top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 388)) });
    }, 600);
  };
  const close = () => { clear(); timer.current = setTimeout(() => setPosition(null), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  const messages = useQuery({ queryKey: ["agent-message-preview", agentId, 12], queryFn: () => fetchAgentMessages(agentId, 12), enabled: Boolean(position), staleTime: 15_000, refetchOnWindowFocus: false, retry: false });
  return <>
    <div ref={anchor} tabIndex={0} className="nodrag" aria-label="Preview recent messages" onMouseEnter={open} onMouseMove={() => { if (!position) open(); }} onMouseLeave={close} onFocus={open} onBlur={close} onKeyDown={(event) => { if (event.key === "Escape") { clear(); setPosition(null); } }}>
      {children}
    </div>
    {position && createPortal(<div role="dialog" aria-label="Recent agent messages" className="agent-control-app fixed z-[100] flex h-[380px] max-h-[calc(100vh-16px)] w-[440px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border shadow-xl" style={{ ...position, height: "min(380px, calc(100vh - 16px))", background: "var(--panel-solid)", color: "var(--foreground)", borderColor: "var(--line)" }} onMouseEnter={clear} onMouseLeave={close} onFocus={clear} onBlur={close} onKeyDown={(event) => { if (event.key === "Escape") setPosition(null); }}>
      <div className="px-3 py-2 text-xs font-semibold">Recent messages</div>
      <div className="agent-chat min-h-0 flex-1">
        {messages.error && !messages.data ? <p className="p-3 text-xs">Messages unavailable.</p> : <ChatView agentId={agentId} messages={messages.data ?? []} artifacts={[]} events={[]} log={null} selectedStep={null} requestedLimit={12} compact showSidecar={false} loading={messages.isLoading} error={null} />}
      </div>
    </div>, document.body)}
  </>;
}
