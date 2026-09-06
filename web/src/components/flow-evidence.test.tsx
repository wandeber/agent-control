import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowEvidenceView } from "../lib/flow-evidence";
import { FlowEvidenceDetails } from "./flow-evidence";

const view: FlowEvidenceView = {
  title: "Expert review", history: false, available: true, decision: null,
  continuation: null, correction: null, unscopedEvidence: false, receipts: []
};

describe("phase evidence detail", () => {
  it("explains unchanged evidence and reopened work without adding technical metrics", () => {
    const html = renderToStaticMarkup(<FlowEvidenceDetails expanded view={{ ...view, receipts: [{
      title: "Expert review", status: "Approved", notice: null, reason: null, sections: [
        { title: "Carried forward in this review", items: ["Login guard"] },
        { title: "Reopened for review", items: ["Invoice mapping — The price schema changed"] },
        { title: "Checks reused", items: ["Login regression"] }
      ] }] }} />);
    expect(html).toContain("Carried forward in this review");
    expect(html).toContain("Invoice mapping — The price schema changed");
    expect(html).toContain("Checks reused");
    expect(html).toContain("Later changes may require a new review");
    expect(html).not.toMatch(/Tokens|receipt_id|digest|context_limit/);
  });

  it("makes a pending user decision visible even while the detail is collapsed", () => {
    const html = renderToStaticMarkup(<FlowEvidenceDetails view={{ ...view, title: "Plan approval", decision: "Approve plan" }} />);
    expect(html).toContain("Plan approval · Decision needed");
    expect(html).toContain("Waiting for your decision: Approve plan");
    expect(html).toContain("Reply in the Codex conversation to continue.");
    expect(html).not.toContain("<button");
  });

  it("keeps legacy progress and historical evidence honest", () => {
    const html = renderToStaticMarkup(<FlowEvidenceDetails view={{ ...view, available: false, history: true }} />);
    expect(html).toContain("Earlier attempt");
    expect(html).toContain("Its records do not establish the current result.");
    expect(html).toContain("A completed phase records progress, not validation of the current result.");
  });

  it("does not ask the user to decide a clarification-owner review", () => {
    const html = renderToStaticMarkup(<FlowEvidenceDetails view={{ ...view, waitingLabel: "Waiting for clarification owner review", continuation: "The conversation that clarified the request must complete this review before the flow can continue." }} />);
    expect(html).toContain("Waiting for clarification owner review");
    expect(html).not.toContain("Waiting for your decision");
    expect(html).not.toContain("Reply in the Codex conversation");
  });

  it("renders recovery reasons as escaped text", () => {
    const html = renderToStaticMarkup(<FlowEvidenceDetails view={{ ...view, correction: { title: "Flow paused", text: "Owner unavailable <script>alert(1)</script>" } }} />);
    expect(html).toContain("Owner unavailable &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
