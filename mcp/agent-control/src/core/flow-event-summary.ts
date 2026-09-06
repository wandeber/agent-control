import type { EventRecord } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const short = (value: unknown) => typeof value === "string" ? value.slice(0, 320) : undefined;

/** Forward bounded decisions and verified evidence references, never whole reports or command contexts. */
export function compactFlowEvent(event: EventRecord): Record<string, unknown> {
  if (!event.type.startsWith("flow.")) return {};
  const result = object(event.payload.result);
  const compactResult: Record<string, unknown> = {};
  for (const key of ["conclusion", "decision", "target", "evidence_receipt_id"]) {
    const value = short(result?.[key]);
    if (value !== undefined) compactResult[key] = value;
  }
  const evidence = object(event.payload.evidence);
  const compactEvidence: Record<string, unknown> = {};
  for (const key of ["receipt_id", "kind", "status", "step_instance_id"]) {
    const value = short(evidence?.[key]);
    if (value !== undefined) compactEvidence[key] = value;
  }
  const summary = object(evidence?.summary);
  if (summary) {
    const detail: Record<string, unknown> = {};
    for (const key of ["reviewed_count", "carried_count", "reopened_count", "executed_check_count", "reused_check_count"]) {
      const value = summary[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) detail[key] = value;
    }
    for (const key of ["reviewed_scopes", "carried_scopes", "executed_checks", "reused_checks"]) {
      const values = summary[key];
      if (Array.isArray(values)) detail[key] = values.filter((value): value is string => typeof value === "string").slice(0, 8).map(value => value.slice(0, 160));
    }
    if (Array.isArray(summary.reopened_scopes)) detail.reopened_scopes = summary.reopened_scopes.slice(0, 8).flatMap(value => {
      const entry = object(value);
      return typeof entry?.label === "string" && typeof entry.reason === "string"
        ? [{ label: entry.label.slice(0, 160), reason: entry.reason.slice(0, 320) }] : [];
    });
    const reason = short(summary.reason);
    if (reason) detail.reason = reason;
    if (Object.keys(detail).length) compactEvidence.summary = detail;
  }
  return {
    ...(short(event.payload.reason) ? { reason: short(event.payload.reason) } : {}),
    ...(short(event.payload.summary) ? { detail: short(event.payload.summary) } : {}),
    ...(event.payload.failure_source === "worker_reported" ? { failure_source: "worker_reported" } : {}),
    ...(Object.keys(compactResult).length ? { result: compactResult } : {}),
    ...(typeof compactEvidence.receipt_id === "string" ? { evidence: compactEvidence } : {})
  };
}
