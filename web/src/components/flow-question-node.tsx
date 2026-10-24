"use client";

import { flowNodeSize } from "@/lib/flow-diagram";
import { GitBranch, UserRound } from "lucide-react";

/** User questions share one shape in authored flows and running workflows. */
export function FlowQuestionNode({ title, description, status, selected, current, automatic = false, onSelect }: {
  title: string; description?: string | null; status?: string; selected?: boolean; current?: boolean; automatic?: boolean; onSelect?: () => void;
}) {
  const label = automatic ? "Automatic decision" : "User question";
  const Icon = automatic ? GitBranch : UserRound;
  return <button type="button" className="flow-question-node" style={flowNodeSize("decision")}
    data-selected={Boolean(selected)} data-current={Boolean(current)} aria-label={`${label}: ${title}${status ? ` · ${status}` : ""}`}
    title={description ?? title} onClick={event => { event.stopPropagation(); onSelect?.(); }}>
    <svg viewBox="0 0 264 156" aria-hidden="true"><polygon points="132,1 263,78 132,155 1,78" /></svg>
    <span className="flow-question-content"><small><Icon size={12} aria-hidden="true" />{label}</small><strong>{title}</strong>{status ? <span>{status}</span> : null}</span>
  </button>;
}
