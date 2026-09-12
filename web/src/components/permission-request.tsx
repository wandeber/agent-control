"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, ShieldQuestion } from "lucide-react";
import { decidePermission, fetchSnapshot } from "@/lib/api";
import type { PermissionRequest } from "@/lib/types";

// Shared optimistic state prevents a second view accepting another click while
// the authoritative CAS decision is in flight. Snapshots still own resolution.
const decisions = new Map<string, PermissionRequest>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(request: PermissionRequest) { decisions.set(request.request_id, request); listeners.forEach(listener => listener()); }
function current(request: PermissionRequest) {
  const local = decisions.get(request.request_id);
  if (!local || ["resolved", "unavailable"].includes(request.state) || request.state === "sent") return request;
  return local;
}

export function PermissionRequests({ requests, compact = false }: { requests: PermissionRequest[]; compact?: boolean }) {
  if (!requests.length) return null;
  const active = requests.filter(request => ["pending", "submitting", "sent"].includes(request.state));
  const visible = compact ? active : [...active, ...requests.filter(request => !active.includes(request)).slice(-4)];
  return <div className={`permission-list ${compact ? "permission-list-compact nodrag nopan" : ""}`}>
    {visible.map(request => <PermissionCard key={request.request_id} request={request} />)}
  </div>;
}

function PermissionCard({ request }: { request: PermissionRequest }) {
  const local = useSyncExternalStore(subscribe, () => decisions.get(request.request_id), () => undefined);
  const record = current(request);
  const [error, setError] = useState<string | null>(null);
  // `local` subscribes this view to decisions from every other occurrence.
  void local;
  const act = async (decision: "approve" | "reject") => {
    if (current(request).state !== "pending") return;
    setError(null); publish({ ...request, state: "submitting", decision });
    try { publish(await decidePermission(request, decision)); }
    catch (cause) {
      // An uncertain response must never re-enable a second decision. A fresh
      // backend snapshot can resolve it; no callback is blindly replayed.
      publish({ ...request, state: "unavailable", decision });
      setError(cause instanceof Error ? cause.message : String(cause));
      try {
        const snapshot = await fetchSnapshot();
        const authoritative = snapshot.permission_requests?.find(item => item.request_id === request.request_id);
        if (authoritative) publish(authoritative);
      } catch { /* Keep unavailable until a backend read succeeds. */ }
    }
  };
  const state = record.state === "pending" ? "Permission requested"
    : record.state === "submitting" ? "Sending…"
    : record.state === "sent" ? "Waiting for Codex"
    : record.state === "resolved" ? "Resolved"
    : "Request unavailable";
  const command = typeof record.scope.command === "string" ? record.scope.command : null;
  const pending = ["pending", "submitting", "sent"].includes(record.state);
  return <section className="permission-request" data-permission-id={record.request_id} data-permission-state={record.state}
    onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <div className="permission-heading" role="status">
      {record.state === "resolved" ? <Check className="size-3.5 shrink-0" /> : <ShieldQuestion className="size-3.5 shrink-0" />}
      <span>{state}</span>
    </div>
    {pending && <>
      {record.reason && <p className="permission-reason">{record.reason}</p>}
      {command && <pre className="permission-command">{command}</pre>}
      {record.scope.grantRoot != null && <p>Session access: <code>{String(record.scope.grantRoot)}</code></p>}
      {record.scope.network != null && <p className="permission-extra">Network: {JSON.stringify(record.scope.network)}</p>}
      {(record.scope.permissions ?? record.scope.additionalPermissions) != null && <pre className="permission-command">{JSON.stringify(record.scope.permissions ?? record.scope.additionalPermissions, null, 2)}</pre>}
    </>}
    <details className="permission-scope"><summary>Details{pending && record.scope.duration ? ` · ${String(record.scope.duration)}` : ""}</summary>
      {record.state === "resolved" && record.decision && <p>Your selected response: {record.decision}.</p>}
      {!pending && record.reason && <p>{record.reason}</p>}
      {Object.entries(record.scope).filter(([key, value]) => key !== "duration" && !(pending && key === "command") && value != null).map(([key, value]) => <div key={key}>
        <h4>{key.replaceAll(/([A-Z])/g, " $1")}</h4><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
      </div>)}
      {!record.scope_complete && <p>Full scope is unavailable. Approval is disabled; rejection remains available when supported.</p>}
    </details>
    {record.state === "pending" && <div className="permission-actions">
      {record.choices.includes("reject") && <button type="button" onClick={() => void act("reject")}>{record.reject_interrupts_turn ? "Reject & interrupt" : "Reject"}</button>}
      {record.choices.includes("approve") && <button type="button" className="permission-approve" disabled={!record.scope_complete} onClick={() => void act("approve")}>Approve</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
