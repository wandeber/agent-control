"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Shield, X } from "lucide-react";
import { requestAgentAccess } from "@/lib/api";
import type { AccessPolicy, AgentAccessSnapshot } from "@/lib/types";

const updates = new Map<string, AgentAccessSnapshot>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const sandboxLabel = (type: unknown) => type === "readOnly" ? "Read only" : type === "workspaceWrite" ? "Workspace" : type === "dangerFullAccess" ? "Full access" : "Custom / unknown";
const approvalLabel = (policy: unknown) => policy === "on-request" ? "Ask when needed" : policy === "never" ? "Never ask" : policy === "untrusted" ? "Ask for untrusted actions" : "Custom / unknown";

export function AgentAccess({ snapshot, compact = false }: { snapshot?: AgentAccessSnapshot; compact?: boolean }) {
  const local = useSyncExternalStore(subscribe, () => snapshot ? updates.get(snapshot.agent_id) : undefined, () => undefined);
  const access = local && snapshot && local.revision > snapshot.revision ? local : snapshot;
  const [sandbox, setSandbox] = useState<AccessPolicy["sandbox"] | "">("");
  const [approval, setApproval] = useState<AccessPolicy["approval_policy"] | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const positioned = position !== null;
  const close = () => { setAnchor(null); setPosition(null); };
  useLayoutEffect(() => {
    if (!anchor || !popup.current) return;
    const update = () => {
      if (!popup.current) return;
      const { width, height } = popup.current.getBoundingClientRect();
      const next = { left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - height - 12)) };
      setPosition(previous => previous?.left === next.left && previous?.top === next.top ? previous : next);
    };
    const resize = new ResizeObserver(update); resize.observe(popup.current); update();
    return () => resize.disconnect();
  }, [anchor]);
  useEffect(() => { if (positioned) popup.current?.focus({ preventScroll: true }); }, [positioned]);
  useEffect(() => {
    if (!anchor) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { close(); trigger.current?.focus(); } };
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close(); };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close(); };
    window.addEventListener("keydown", escape); window.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true); window.addEventListener("resize", close);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); };
  }, [anchor]);
  if (!access) return null;
  const policy = { sandbox: sandbox || access.requested?.sandbox, approval_policy: approval || access.requested?.approval_policy };
  const apply = async () => {
    if (!policy.sandbox || !policy.approval_policy || busy) return;
    setBusy(true); setError(null);
    try { const result = await requestAgentAccess(access, policy as AccessPolicy); updates.set(access.agent_id, result); listeners.forEach(listener => listener()); setSandbox(""); setApproval(""); close(); trigger.current?.focus(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <button ref={trigger} className={`agent-access ${compact ? "nodrag nopan" : ""}`} type="button" aria-haspopup="dialog" aria-expanded={Boolean(anchor)} aria-controls={anchor ? popupId : undefined}
      title={access.state === "pending" ? "Access change pending" : access.effective ? sandboxLabel(access.effective.sandbox_policy.type) : "Agent access"}
      onClick={event => { event.stopPropagation(); if (anchor) close(); else setAnchor(event.currentTarget.getBoundingClientRect()); }}
      onKeyDown={event => { if (event.key === "Escape") close(); event.stopPropagation(); }}>
      <Shield className="size-3.5" />Access{access.state === "pending" && <span className="access-pending-dot" aria-label="Change pending" />}<ChevronDown className="size-3" />
    </button>
    {anchor && createPortal(<div ref={popup} id={popupId} tabIndex={-1} role="dialog" aria-label="Agent access" className="agent-control-app agent-access-popover nodrag nopan"
      style={{ ...position, visibility: position ? "visible" : "hidden" }} onClick={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === "Escape") { close(); trigger.current?.focus(); } event.stopPropagation(); }}>
      <div className="agent-access-heading"><strong>Agent access</strong><button type="button" aria-label="Close access settings" onClick={() => { close(); trigger.current?.focus(); }}><X className="size-3.5" /></button></div>
      <p><strong>Current:</strong> {access.effective ? `${sandboxLabel(access.effective.sandbox_policy.type)} · ${approvalLabel(access.effective.approval_policy)}` : "Not yet reported by Codex."}</p>
      {access.requested && access.state === "pending" && <p><strong>Pending:</strong> {access.requested.sandbox.replaceAll("_", " ")} · {approvalLabel(access.requested.approval_policy)}</p>}
      {access.state === "unsupported" ? <p>This backend cannot change access through this console.</p> : <>
        <label>Access<select aria-label="Access for next turn" value={policy.sandbox ?? ""} onChange={event => setSandbox(event.target.value as AccessPolicy["sandbox"])}>
          <option value="" disabled>Select access</option><option value="read_only">Read only</option><option value="workspace">Workspace</option><option value="full_access">Full access</option>
        </select></label>
        <label>Permissions<select aria-label="Approval policy" value={policy.approval_policy ?? ""} onChange={event => setApproval(event.target.value as AccessPolicy["approval_policy"])}>
          <option value="" disabled>Select policy</option><option value="on-request">Ask when needed</option><option value="untrusted">Ask for untrusted actions</option><option value="never">Never ask</option>
        </select></label>
        {policy.sandbox === "full_access" && <p>Full access removes sandbox restrictions for this agent&apos;s next turn.</p>}
        {policy.approval_policy === "never" && <p>Never ask does not grant extra access. Actions outside the sandbox can fail.</p>}
        <p className="access-next-turn">Applies to the next turn. Current requests keep their scope.</p>
        <button type="button" disabled={busy || !policy.sandbox || !policy.approval_policy} onClick={() => void apply()}>{busy ? "Saving…" : "Apply to next turn"}</button>
      </>}
      {access.effective && <details><summary>Effective policy details</summary><pre>{JSON.stringify({ sandbox: access.effective.sandbox_policy, approval: access.effective.approval_policy }, null, 2)}</pre></details>}
      {error && <p role="alert">{error}</p>}
    </div>, document.body)}
  </>;
}
