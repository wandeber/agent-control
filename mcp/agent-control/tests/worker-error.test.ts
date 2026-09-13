import { expect, it } from "vitest";
import { ControllerError, workerError } from "../src/core/errors.js";

it("retains capability identity while excluding instruction/configuration contents", () => {
  const diagnostic = workerError(new ControllerError("Capability unavailable", "capability_unavailable", {
    capability_kind: "skill", capability_id: "/fixture/SKILL.md", expected: "private instructions", actual: "private config"
  }));
  expect(diagnostic).toEqual({ message: "Capability unavailable", reason: "capability_unavailable",
    details: { capability_kind: "skill", capability_id: "/fixture/SKILL.md" } });
  expect(JSON.stringify(diagnostic)).not.toContain("private");
});
