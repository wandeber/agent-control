import { describe, expect, it } from "vitest";
import { compactFlowEvent } from "../src/core/flow-event-summary.js";
import type { EventRecord } from "../src/core/types.js";

const event = (payload: Record<string, unknown>, type: EventRecord["type"] = "flow.notification") =>
  ({ type, payload } as EventRecord);

describe("compact flow event evidence", () => {
  it("explains a reported capability failure without certifying the worker's diagnosis", () => {
    expect(compactFlowEvent(event({ reason: "worker_capability_unavailable", failure_source: "worker_reported",
      summary: "Worker reported an unavailable Agent Control capability: flow_evidence | Approval required",
      capability_failure: "unbounded backend diagnostic" }, "flow.step_blocked"))).toEqual({
      reason: "worker_capability_unavailable", failure_source: "worker_reported",
      detail: "Worker reported an unavailable Agent Control capability: flow_evidence | Approval required"
    });
  });
  it("carries actionable review and execution summaries without raw reports", () => {
    expect(compactFlowEvent(event({ result: { conclusion: "approved", evidence_receipt_id: "review-1", ledger: "large report", agent_token: "private" },
      evidence: { receipt_id: "review-1", kind: "expert_review", status: "approved", payload: { environment: "private" }, summary: {
        carried_count: 2, reused_check_count: 1, reused_checks: ["unit"], reopened_scopes: [{ label: "API", reason: "Changed consumer contract" }], argv: "private"
      } } }))).toEqual({ result: { conclusion: "approved", evidence_receipt_id: "review-1" }, evidence: {
      receipt_id: "review-1", kind: "expert_review", status: "approved", summary: { carried_count: 2, reused_check_count: 1,
        reused_checks: ["unit"], reopened_scopes: [{ label: "API", reason: "Changed consumer contract" }] }
    } });
  });
  it("bounds output and ignores invalid fields and unrelated events", () => {
    const value = compactFlowEvent(event({ evidence: { receipt_id: "receipt", summary: { reviewed_count: -1,
      reused_check_count: Infinity, executed_checks: Array(20).fill("x".repeat(200)), reopened_scopes: [null, { label: 3 }] } } }));
    expect(JSON.stringify(value).length).toBeLessThan(1500);
    expect(value).toMatchObject({ evidence: { summary: { executed_checks: Array(8).fill("x".repeat(160)), reopened_scopes: [] } } });
    expect(compactFlowEvent(event({ result: { conclusion: "ready" } }, "agent.completed"))).toEqual({});
  });
});
