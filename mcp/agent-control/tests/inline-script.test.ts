import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { escapeInlineScript } from "../src/inline-script.js";

describe("embedded JavaScript", () => {
  it("preserves HTML strings without entering escaped HTML parser states", () => {
    const source = `const html = '<!-- <script>nested</script> --><SCRIPT>upper</SCRIPT>'; html;`;
    const escaped = escapeInlineScript(source);
    expect(runInNewContext(escaped)).toBe(runInNewContext(source));
    expect(escaped).not.toMatch(/<!--|<\/?script/gi);
  });

  it("preserves comparisons, templates, and regular expressions", () => {
    const source = 'const match = /<script/i.test(`<script>`); JSON.stringify([1 < 2, match, `</script>`]);';
    expect(runInNewContext(escapeInlineScript(source))).toBe(runInNewContext(source));
  });
});
