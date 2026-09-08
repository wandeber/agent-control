"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { modelUsage } from "@/lib/agent-presentation";

type Usage = ReturnType<typeof modelUsage>["totals"];
const fields = [["input", "Input"], ["cached", "Cached input"], ["uncached", "Uncached input"], ["output", "Output"], ["total", "Total"]] as const;
const tokenLabel = (value?: Usage["input"]) => value?.value === null || value?.value === undefined ? "—" : `${new Intl.NumberFormat("en-US").format(value.value)}${value.partial ? "+" : ""}`;

export function TokenUsageCell({ values, label }: { values?: Usage; label: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const hide = () => { clear(); setAnchor(null); setPosition(null); };
  const open = () => { clear(); if (trigger.current) setAnchor(trigger.current.getBoundingClientRect()); };
  const closeSoon = () => { clear(); timer.current = setTimeout(hide, 120); };

  useLayoutEffect(() => {
    if (!anchor || !popover.current) return;
    const { width, height } = popover.current.getBoundingClientRect();
    const below = anchor.bottom + 8;
    setPosition({ left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)), top: Math.max(8, below + height <= window.innerHeight - 8 ? below : anchor.top - height - 8) });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) hide(); };
    const scroll = (event: Event) => { if (!popover.current?.contains(event.target as Node)) hide(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", hide);
    return () => {
      clear();
      window.removeEventListener("keydown", escape);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [anchor]);

  const available = fields.some(([key]) => values?.[key].value !== null && values?.[key].value !== undefined);
  return <td className="py-2 text-right align-top">
    {available ? <button ref={trigger} type="button" className="rounded-sm tabular-nums decoration-dotted underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-500"
      aria-label={`${label}: ${tokenLabel(values?.total)} tokens. Show breakdown`} aria-describedby={anchor ? id : undefined}
      onMouseEnter={open} onMouseLeave={closeSoon} onFocus={open} onBlur={closeSoon} onClick={open}>
      {tokenLabel(values?.total)}
    </button> : tokenLabel(values?.total)}
    {anchor && createPortal(<div ref={popover} id={id} role="tooltip"
      className="fixed z-[100] max-h-[calc(100vh-16px)] w-[280px] max-w-[calc(100vw-16px)] overflow-auto rounded-lg border p-3 text-left text-xs font-normal shadow-lg"
      style={{ ...position, visibility: position ? "visible" : "hidden", background: "var(--panel-solid)", color: "var(--foreground)", borderColor: "var(--line)" }}
      onMouseEnter={clear} onMouseLeave={closeSoon}>
      <div className="mb-2 font-semibold">Token consumption · {label}</div>
      <dl className="space-y-1">{fields.map(([key, name]) => <div key={key} className="flex justify-between gap-3"><dt>{name}</dt><dd className="tabular-nums">{tokenLabel(values?.[key])}</dd></div>)}</dl>
      <p className="mt-2 text-ink-400">Input includes cache; output includes reasoning. + marks a partial sum; — means unavailable.</p>
    </div>, document.body)}
  </td>;
}
