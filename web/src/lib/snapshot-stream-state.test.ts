import { describe, expect, it } from "vitest";
import { snapshotStreamIsLoading } from "./snapshot-stream-state";

describe("snapshotStreamIsLoading", () => {
  it("ends MCP loading as soon as the initial refresh reports an error", () => {
    expect(
      snapshotStreamIsLoading({ hasSnapshot: false, hasError: true, mcpMode: true, queryLoading: false })
    ).toBe(false);
  });

  it("keeps the initial MCP connection in loading before data or an error arrives", () => {
    expect(
      snapshotStreamIsLoading({ hasSnapshot: false, hasError: false, mcpMode: true, queryLoading: false })
    ).toBe(true);
  });
});
