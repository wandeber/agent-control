import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { codexUsagePaths } from "./codex-session.js";
const fields = ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"];
const cache = new Map();
const count = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
function samplesFrom(path) {
    const stat = statSync(path), signature = `${stat.size}:${stat.mtimeMs}`;
    if (cache.get(path)?.signature === signature)
        return cache.get(path).samples;
    let model = null, createdAt = "";
    const samples = [];
    // Keep only metering records in this cache, never conversation content or tool payloads.
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"'))
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        }
        const p = row.payload;
        if (row.type === "session_meta")
            createdAt = row.timestamp;
        if (row.type === "turn_context" && typeof p?.model === "string")
            model = p.model;
        if (row.type !== "event_msg" || p?.type !== "token_count" || !p.info?.total_token_usage || !Number.isFinite(Date.parse(row.timestamp)))
            continue;
        const usage = p.info.total_token_usage, last = p.info.last_token_usage;
        const counts = Object.fromEntries(fields.map(field => [field, count(usage[field])]));
        samples.push({ counts, at: row.timestamp, model, path, ordinal: samples.length, createdAt, contextLimit: count(p.info.model_context_window),
            fresh: Boolean(last && ["input_tokens", "output_tokens", "total_tokens"].every(field => count(last[field]) !== null && last[field] === usage[field])) });
    }
    if (cache.size >= 100 && !cache.has(path))
        cache.delete(cache.keys().next().value);
    cache.set(path, { signature, samples });
    return samples;
}
/** Measured deltas inside the run window, independent of the currently active rollout. */
export function codexRunUsage(threadId, start, end, baselinePath) {
    return codexRunUsageWithEvidence(threadId, start, end, baselinePath)?.usage ?? null;
}
const fingerprint = (sample) => JSON.stringify([Date.parse(sample.at), sample.model, sample.counts]);
/** Private record fingerprints let persistence detect missing segments, even in a truncated file. */
export function codexRunUsageWithEvidence(threadId, start, end, baselinePath) {
    const from = Date.parse(start), until = end === null ? Infinity : Date.parse(end);
    if (!Number.isFinite(from) || Number.isNaN(until) || until < from)
        return null;
    const unique = new Map();
    for (const path of codexUsagePaths(threadId, baselinePath)) {
        for (const sample of samplesFrom(path)) {
            if (Date.parse(sample.at) > until)
                continue;
            // Resumed files can contain copied history. Identical native records count once.
            const key = fingerprint(sample);
            const previous = unique.get(key);
            if (!previous || Date.parse(sample.createdAt) < Date.parse(previous.createdAt))
                unique.set(key, sample);
        }
    }
    const samples = [...unique.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.ordinal - b.ordinal);
    const totals = Object.fromEntries(fields.map(field => [field, 0]));
    const models = new Set();
    const evidence = [];
    const remember = (sample) => evidence.push({ at: Date.parse(sample.at), key: createHash("sha256").update(fingerprint(sample)).digest("hex") });
    let previous, latest;
    for (const sample of samples) {
        // The counter at the start is the baseline: adjacent windows are (start, end].
        if (Date.parse(sample.at) <= from) {
            previous = sample;
            continue;
        }
        if (!latest && previous)
            remember(previous);
        remember(sample);
        // A separate native file may restart counters. Only a first record whose
        // cumulative counters equal its request counters proves a fresh origin.
        const fresh = sample.ordinal === 0 && sample.fresh &&
            Date.parse(sample.createdAt) <= Date.parse(sample.at) && (!previous ||
            sample.path !== previous.path && Date.parse(sample.createdAt) >= Math.max(from, Date.parse(previous.at)));
        let changed = false;
        for (const field of fields) {
            const before = fresh ? 0 : previous?.counts[field], value = sample.counts[field];
            const delta = typeof before === "number" && value !== null && value >= before ? value - before : null;
            changed ||= delta === null || delta > 0;
            totals[field] = totals[field] !== null && delta !== null && Number.isSafeInteger(totals[field] + delta) ? totals[field] + delta : null;
        }
        if (changed)
            models.add(sample.model);
        latest = sample;
        previous = sample;
    }
    if (!latest && !previous)
        return null;
    if (!latest && previous)
        remember(previous);
    const last = latest ?? previous;
    // A baseline without subsequent consumption still measures a legitimate zero.
    return { evidence, usage: { ...totals, model: models.size > 1 ? "Mixed models" : models.size === 1 ? [...models][0] : last.model,
            context_used: null, context_limit: last.contextLimit, captured_at: last.at,
            source: "codex.rollout.run_window", scope_started_at: start, scope_ended_at: end } };
}
