import type { LucideIcon } from "lucide-react";
import { cx, STATUS_STYLE } from "@/lib/format";
import type { AgentStatus } from "@/lib/types";

export function IconButton({
  label,
  icon: Icon,
  active,
  onClick
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        "grid size-8 shrink-0 place-items-center rounded-md border text-ink-500 transition",
        active
          ? "border-teal-300 bg-teal-50 text-teal-700 shadow-hairline"
          : "border-black/10 bg-white/70 hover:border-black/20 hover:bg-white hover:text-ink-900"
      )}
      type="button"
    >
      <Icon className="size-4" strokeWidth={1.8} />
    </button>
  );
}

export function StatusPill({ status, compact = false }: { status: AgentStatus; compact?: boolean }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium leading-none",
        style.bg,
        style.border,
        style.text
      )}
    >
      <span className={cx("size-1.5 rounded-full", style.dot)} />
      {compact ? style.label.slice(0, 7) : style.label}
    </span>
  );
}

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      aria-label={`Status: ${style.label}`}
      className={cx("grid size-4 shrink-0 place-items-center rounded-full", style.bg, className)}
      title={`Status: ${style.label}`}
    >
      <span className={cx("size-2 rounded-full", style.dot)} />
    </span>
  );
}

export function Metric({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value: string;
  tone?: "neutral" | "teal" | "amber" | "coral";
}) {
  const toneClass =
    tone === "teal"
      ? "text-teal-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "coral"
          ? "text-red-700"
          : "text-ink-900";
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300">{label}</div>
      <div className={cx("truncate text-sm font-semibold", toneClass)}>{value}</div>
    </div>
  );
}

export function Panel({
  children,
  className
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-lg border border-black/10 bg-white/80 shadow-panel backdrop-blur-xl", className)}>
      {children}
    </section>
  );
}

export function SectionHeader({
  title,
  action,
  detail
}: {
  title: string;
  action?: React.ReactNode;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-black/10 px-3 py-2">
      <div className="min-w-0">
        <h2 className="truncate text-xs font-semibold uppercase tracking-[0.1em] text-ink-700">{title}</h2>
        {detail ? <p className="truncate text-[11px] text-ink-300">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="rounded-lg border border-dashed border-black/15 bg-white/60 px-4 py-3">
        <div className="text-sm font-semibold text-ink-900">{title}</div>
        <div className="mt-1 max-w-sm text-xs leading-5 text-ink-500">{detail}</div>
      </div>
    </div>
  );
}
