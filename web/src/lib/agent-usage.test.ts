import { describe, expect, it } from "vitest";
import { agentTokenLabel } from "./agent-presentation";
import type { UsageSnapshotRecord } from "./types";

const usage = (values: Partial<UsageSnapshotRecord>) => ({ input_tokens: null, output_tokens: null, total_tokens: null, ...values }) as UsageSnapshotRecord;

describe("agent token consumption", () => {
  it("hides unavailable consumption even when context size is known", () => {
    expect(agentTokenLabel(null)).toBeNull();
    expect(agentTokenLabel(usage({ context_used: 12000 }))).toBeNull();
  });
  it("preserves reported zero and partial counts without inventing missing values", () => {
    expect(agentTokenLabel(usage({ input_tokens: 1200, output_tokens: 0 }))).toBe("1,200 in · 0 out tokens");
    expect(agentTokenLabel(usage({ total_tokens: 1400 }))).toBe("1,400 total tokens");
    expect(agentTokenLabel(usage({ input_tokens: -1, output_tokens: NaN }))).toBeNull();
  });
});
