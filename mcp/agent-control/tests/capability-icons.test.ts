import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { capabilityIcon } from "../src/core/capability-icons.js";

const roots: string[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "capability-icons-"));
  roots.push(root);
  const source = join(root, "source");
  const installed = join(root, "installed");
  for (const directory of [source, installed]) mkdirSync(join(directory, "assets"), { recursive: true });
  return { root, source, installed };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it("embeds the installed asset when runtime metadata points to the source copy", () => {
  const { source, installed } = fixture();
  writeFileSync(join(source, "assets/icon.svg"), "invalid old image");
  writeFileSync(join(installed, "assets/icon.svg"), svg);
  expect(capabilityIcon([join(source, "assets/icon.svg")], [installed, source])).toBe(dataUrl);
  expect(capabilityIcon(["./assets/missing.svg", "./assets/icon.svg"], [installed])).toBe(dataUrl);
});

it("rejects traversal, symlink escapes, nonimages, oversized files, and remote resources", () => {
  const { root, source } = fixture();
  const outside = join(root, "outside.svg");
  writeFileSync(outside, svg);
  symlinkSync(outside, join(source, "assets/link.svg"));
  writeFileSync(join(source, "assets/invalid.svg"), '{"private":"not an image"}');
  writeFileSync(join(source, "assets/large.svg"), svg + " ".repeat(2 * 1024 * 1024));
  for (const candidate of [outside, "../outside.svg", "assets/link.svg", "assets/invalid.svg", "assets/large.svg", "https://example.com/icon.svg", "file://" + outside]) {
    expect(capabilityIcon([candidate], [source])).toBeUndefined();
  }
  expect(capabilityIcon([], [source])).toBeUndefined();
});
