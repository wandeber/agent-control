"use client";

import { Bot, Workflow } from "lucide-react";
import type { ReactNode } from "react";

export type SettingsSection = "agents" | "flows";

export function SettingsLayout({ section, onSelect, children }: { section: SettingsSection; onSelect: (section: SettingsSection) => void; children: ReactNode }) {
  return <main className="settings-shell" aria-label={section === "agents" ? "Agent settings" : "Flow settings"}>
    <aside className="settings-sidebar"><SettingsNavigation section={section} onSelect={onSelect} /></aside>
    <div className="settings-content">{children}</div>
  </main>;
}

export function SettingsNavigation({ section, onSelect }: { section: SettingsSection; onSelect: (section: SettingsSection) => void }) {
  return <nav className="settings-navigation" aria-label="Settings sections">
    <button type="button" className="settings-section-link" aria-current={section === "agents" ? "page" : undefined} onClick={() => onSelect("agents")}><Bot size={17} />Agents</button>
    <button type="button" className="settings-section-link" aria-current={section === "flows" ? "page" : undefined} onClick={() => onSelect("flows")}><Workflow size={17} />Flows</button>
  </nav>;
}
