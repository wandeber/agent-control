import type { AgentStatus } from "./types";

export const STATUS_STYLE: Record<
  AgentStatus,
  { label: string; dot: string; text: string; bg: string; border: string; glow: string }
> = {
  planned: {
    label: "Planned",
    dot: "bg-violet-400",
    text: "text-violet-700",
    bg: "bg-violet-50",
    border: "border-violet-200",
    glow: "shadow-violet-200/60"
  },
  queued: {
    label: "Queued",
    dot: "bg-slate-400",
    text: "text-slate-600",
    bg: "bg-slate-50",
    border: "border-slate-200",
    glow: "shadow-slate-200/60"
  },
  starting: {
    label: "Starting",
    dot: "bg-blue-500",
    text: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
    glow: "shadow-blue-200/70"
  },
  running: {
    label: "Running",
    dot: "bg-signal-teal",
    text: "text-teal-700",
    bg: "bg-teal-50",
    border: "border-teal-200",
    glow: "shadow-teal-200/70"
  },
  waiting_for_input: {
    label: "Waiting",
    dot: "bg-signal-amber",
    text: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    glow: "shadow-amber-200/70"
  },
  completed: {
    label: "Completed",
    dot: "bg-signal-lime",
    text: "text-lime-700",
    bg: "bg-lime-50",
    border: "border-lime-200",
    glow: "shadow-lime-200/70"
  },
  failed: {
    label: "Failed",
    dot: "bg-signal-coral",
    text: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-200",
    glow: "shadow-red-200/70"
  },
  blocked: {
    label: "Blocked",
    dot: "bg-signal-coral",
    text: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-200",
    glow: "shadow-red-200/70"
  },
  stopping: {
    label: "Stopping",
    dot: "bg-orange-500",
    text: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
    glow: "shadow-orange-200/70"
  },
  stopped: {
    label: "Stopped",
    dot: "bg-zinc-400",
    text: "text-zinc-600",
    bg: "bg-zinc-50",
    border: "border-zinc-200",
    glow: "shadow-zinc-200/70"
  },
  unknown: {
    label: "Unknown",
    dot: "bg-zinc-400",
    text: "text-zinc-600",
    bg: "bg-zinc-50",
    border: "border-zinc-200",
    glow: "shadow-zinc-200/70"
  }
};

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) {
    return "0s";
  }
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "unknown";
  }
  return new Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard" }).format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit"
  }).format(date);
}

export function compactId(value: string, size = 7): string {
  if (value.length <= size * 2 + 1) {
    return value;
  }
  return `${value.slice(0, size)}…${value.slice(-4)}`;
}

export function elapsedFrom(start: string, end?: string | null): number {
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, endMs - startMs);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
