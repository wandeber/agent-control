/** Public tool fields only; never copy an entire provider item into metadata. */
export function toolActivity(item, callId, eventType) {
    const raw = String(item.status ?? item.stateStatus ?? "");
    const status = /^(completed|success|succeeded)$/.test(raw) ? "completed"
        : /^(failed|error)$/.test(raw) ? "failed"
            : /^(declined|denied|cancelled|canceled)$/.test(raw) ? "declined"
                : /^(inProgress|in_progress|running|pending)$/.test(raw) ? "running"
                    : eventType === "item.completed" ? "completed" : eventType === "item.started" ? "running" : "unknown";
    return {
        call_id: callId,
        name: typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : String(item.type ?? "Tool"),
        status,
        ...(typeof item.command === "string" ? { command: item.command } : {}),
        ...(item.arguments !== undefined ? { input: item.arguments } : item.input !== undefined ? { input: item.input } : {}),
        ...((item.aggregatedOutput ?? item.aggregated_output ?? item.result ?? item.output) !== undefined
            ? { output: item.aggregatedOutput ?? item.aggregated_output ?? item.result ?? item.output } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
        ...(typeof (item.exitCode ?? item.exit_code) === "number" ? { exit_code: item.exitCode ?? item.exit_code } : {})
    };
}
