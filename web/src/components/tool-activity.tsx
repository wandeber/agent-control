"use client";

import { Check, ChevronRight, Circle, LoaderCircle, Terminal, X } from "lucide-react";
import type { ToolActivity } from "@/lib/tool-activity";

const labels = { running: "Running", completed: "Completed", failed: "Failed", declined: "Declined", unknown: "Status unavailable" };
const render = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
const toolLabels: Record<string, string> = { commandExecution: "Run command", command_execution: "Run command", exec_command: "Run command", fileChange: "Change files", file_change: "Change files", webSearch: "Search web", web_search: "Search web" };

export function ToolActivityRow({ tool }: { tool: ToolActivity }) {
  const Icon = tool.status === "running" ? LoaderCircle : tool.status === "completed" ? Check : ["failed", "declined"].includes(tool.status) ? X : Circle;
  const title = toolLabels[tool.name] ?? tool.name.replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
  return <details className="tool-activity" data-tool-state={tool.status}>
    <summary aria-label={`${title} · ${tool.command ?? ""} · ${labels[tool.status]}`}>
      <ChevronRight className="tool-chevron size-3.5 shrink-0" aria-hidden="true" />
      <Terminal className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="tool-name">{title}</span>
      {tool.command && <span className="tool-command" title={tool.command}>{tool.command}</span>}
      <span className="tool-state"><Icon className={`size-3.5 ${tool.status === "running" ? "animate-spin" : ""}`} aria-hidden="true" />{labels[tool.status]}</span>
    </summary>
    <div className="tool-details">
      {title !== tool.name && <ToolDetail label="Tool" value={tool.name} />}
      {tool.command && <ToolDetail label="Command" value={tool.command} />}
      {tool.input !== undefined && <ToolDetail label="Input" value={tool.input} />}
      {tool.output !== undefined && <ToolDetail label="Result" value={tool.output === "" ? "No output." : tool.output} />}
      {tool.error !== undefined && <ToolDetail label="Error" value={tool.error} />}
      {tool.exit_code !== undefined && <p className="text-xs">Exit code: {tool.exit_code}</p>}
      {tool.output === undefined && tool.error === undefined && <p className="text-xs text-ink-400">{tool.status === "running" ? "Waiting for the tool result." : "No result was recorded."}</p>}
    </div>
  </details>;
}

function ToolDetail({ label, value }: { label: string; value: unknown }) {
  return <section><h4>{label}</h4><pre>{render(value)}</pre></section>;
}
