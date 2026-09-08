import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeepSeekPeakRates, parseEcbExchangeRate, parseOpenAIStandardRates, updatePricing } from "./update-pricing.mjs";

// Different model columns ensure the parser actually selects vision, even if public rates later diverge.
const html = `<table>
<tr><td colspan="3">MODEL</td><td>deepseek-v4-flash</td><td>deepseek-v4-flash-vision-exp</td></tr>
<tr><td>PRICING</td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.001</td><td>$0.007</td></tr>
<tr><td>PEAK</td><td>$0.002</td><td>$0.014</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.1</td><td>$0.22</td></tr>
<tr><td>PEAK</td><td>$0.2</td><td>$0.44</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.3</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.6</td><td>$1.32</td></tr></table>`;
const markdown = "### Standard pricing data\n| gpt-5.5 | $5.00 | $0.50 | - | $30.00 |\n";
const xml = "<Cube><Cube time='2026-09-07'><Cube currency='USD' rate='1.1622'/><Cube currency='GBP' rate='0.85'/></Cube></Cube>";

test("reads the ECB quote and refuses missing, ambiguous or invalid exchange rates", () => {
  assert.deepEqual(parseEcbExchangeRate(xml), { usd_per_eur: 1.1622, source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", updated_at: "2026-09-07" });
  for (const invalid of [xml.replace("USD", "CAD"), xml.replace("1.1622", "0"), xml.replace("1.1622", "NaN"), xml.replace("2026-09-07", "2026-02-31"), xml + "<Cube currency='USD' rate='1.2'/>"]) assert.throws(() => parseEcbExchangeRate(invalid));
});

test("uses the requested multimodal model's peak rates and bills writes as uncached input", () => {
  assert.deepEqual(parseDeepSeekPeakRates(html, "deepseek-v4-flash-vision-exp"), {
    input_per_million: .44, cached_input_per_million: .014, cache_write_input_per_million: .44, output_per_million: 1.32
  });
});

test("rejects unknown models, missing tiers and malformed prices rather than selecting another rate", () => {
  assert.throws(() => parseDeepSeekPeakRates(html, "unknown"));
  assert.throws(() => parseDeepSeekPeakRates(html.replaceAll(">PEAK<", ">UNKNOWN<"), "deepseek-v4-flash-vision-exp"));
  assert.throws(() => parseDeepSeekPeakRates(html.replace("$1.32", "TBD"), "deepseek-v4-flash-vision-exp"));
});

test("preserves pre-5.6 cache-write billing and requires all requested OpenAI rows", () => {
  assert.equal(parseOpenAIStandardRates(markdown, ["gpt-5.5"])["gpt-5.5"].cache_write_input_per_million, 5);
  assert.throws(() => parseOpenAIStandardRates(markdown, ["gpt-6-astra"]));
});

test("updates both sources together and preserves the old file if either source cannot be validated", async () => {
  const root = mkdtempSync(join(tmpdir(), "ac-price-refresh-"));
  const path = join(root, "pricing.json");
  const originalFetch = globalThis.fetch;
  const catalog = {
    source: "https://developers.openai.com/api/docs/pricing", models: { "gpt-5.5": {}, yoda: {} },
    model_references: { yoda: { model: "deepseek-v4-flash-vision-exp", source: "https://api-docs.deepseek.com/quick_start/pricing/", basis: "Peak API rates" } }
  };
  try {
    writeFileSync(path, JSON.stringify(catalog));
    let deepseek = html;
    let exchange = xml;
    globalThis.fetch = async url => new Response(url.includes("deepseek") ? deepseek : url.includes("ecb.europa.eu") ? exchange : markdown);
    await updatePricing(path);
    const updated = readFileSync(path, "utf8");
    assert.equal(JSON.parse(updated).models.yoda.output_per_million, 1.32);
    assert.equal(JSON.parse(updated).exchange.usd_per_eur, 1.1622);
    deepseek = html.replace("$1.32", "TBD");
    await assert.rejects(updatePricing(path));
    assert.equal(readFileSync(path, "utf8"), updated);
    deepseek = html;
    exchange = xml.replace("1.1622", "0");
    await assert.rejects(updatePricing(path));
    assert.equal(readFileSync(path, "utf8"), updated);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
