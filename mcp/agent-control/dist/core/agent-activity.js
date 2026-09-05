export function activityText(value) {
    if (typeof value !== "string")
        return null;
    const line = value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
    return line ? line.replace(/\s+/g, " ").slice(0, 240) : null;
}
export function parseActivity(value) {
    if (!value || typeof value !== "object")
        return null;
    const item = value;
    const text = activityText(item.text);
    if (!text || (item.kind !== "message" && item.kind !== "tool"))
        return null;
    return { kind: item.kind, text, ...(typeof item.observed_at === "string" ? { observed_at: item.observed_at } : {}),
        ...(["running", "completed", "failed"].includes(String(item.state)) ? { state: item.state } : {}) };
}
/** Read the latest public activity in item order, including a tool that has already finished. */
export function codexThreadActivity(turns) {
    const latest = turns.at(-1);
    if (!latest)
        return null;
    const tools = {
        commandExecution: "Run a command", mcpToolCall: "Use a tool", dynamicToolCall: "Use a tool",
        webSearch: "Search the web", fileChange: "Edit files", imageGeneration: "Generate an image"
    };
    for (const item of [...(latest.items ?? [])].reverse()) {
        if (item.type === "agentMessage") {
            const text = activityText(item.text);
            if (text)
                return { kind: "message", text,
                    ...((latest.completedAt ?? latest.startedAt) ? { observed_at: new Date((latest.completedAt ?? latest.startedAt) * 1000).toISOString() } : {}) };
        }
        if (!tools[item.type])
            continue;
        let text = tools[item.type];
        // Expose a small known operation vocabulary, never shell arguments, tool inputs, or results.
        if (item.type === "commandExecution") {
            const command = item.command ?? "";
            if (/^\s*(pnpm|npm|yarn)\s+(test|run\s+test)(?:\s|$)/.test(command))
                text = "Run tests";
            else if (/^\s*(pnpm|npm|yarn)\s+(build|run\s+build)(?:\s|$)/.test(command))
                text = "Build the project";
            else if (/^\s*git\s+diff(?:\s|$)/.test(command))
                text = "Review changes";
            else if (/^\s*git\s+status(?:\s|$)/.test(command))
                text = "Check changes";
            else if (/^\s*rg(?:\s|$)/.test(command))
                text = "Search files";
        }
        else if (item.tool && /^[a-zA-Z0-9_.:-]{1,80}$/.test(item.tool)) {
            text = item.tool;
        }
        const state = item.status === "inProgress" && latest.status === "inProgress" ? "running"
            : item.status === "completed" ? "completed" : item.status === "failed" || item.status === "declined" ? "failed" : undefined;
        return { kind: "tool", text, ...(state ? { state } : {}),
            ...((latest.completedAt ?? latest.startedAt) !== undefined && (latest.completedAt ?? latest.startedAt) !== null
                ? { observed_at: new Date((latest.completedAt ?? latest.startedAt) * 1000).toISOString() } : {}) };
    }
    return null;
}
