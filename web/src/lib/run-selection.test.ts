import { describe, expect, it } from "vitest";
import { nextRunSelection, readRunSelection, runSelectionKey } from "./run-selection";

describe("browser run selection", () => {
  it("adds and removes runs with modifiers, retaining the last selection", () => {
    expect(nextRunSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(nextRunSelection(["a", "b"], "a", true)).toEqual(["b"]);
    expect(nextRunSelection(["b"], "b", true)).toEqual(["b"]);
    expect(nextRunSelection(["a", "b"], "b", false)).toEqual(["b"]);
  });
  it("restores all browser runs but only one embedded run", () => {
    const search = "?apiPort=4000&run_id=a&run_id=b&run_id=a&run_id=";
    expect(readRunSelection(search, false)).toEqual(["a", "b"]);
    expect(readRunSelection(search, true)).toEqual(["a"]);
    expect(runSelectionKey(["b", "a"])).toBe(runSelectionKey(["a", "b"]));
  });
});
