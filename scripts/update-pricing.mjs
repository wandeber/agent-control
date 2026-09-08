#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const exchangeSource = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const parseRate = text => /^\$[\d,.]+$/.test(text) ? Number(text.slice(1).replaceAll(",", "")) : NaN;
const rates = (input, cached, writes, output) => {
  if ([input, cached, writes, output].some(value => !Number.isFinite(value) || value < 0)) throw new Error("Unrecognized pricing rates; no prices were written.");
  return { input_per_million: input, cached_input_per_million: cached, cache_write_input_per_million: writes, output_per_million: output };
};

export function parseOpenAIStandardRates(markdown, models) {
  const section = markdown.split("### Standard pricing data\n")[1]?.split("\n### ")[0];
  if (!section) throw new Error("Official Standard pricing table changed; review it before updating prices.");
  const rows = new Map(section.split("\n").filter(line => line.startsWith("| ")).map(line => {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    return [cells[0].replace(/ \(.*\)$/, ""), cells];
  }));
  return Object.fromEntries(models.map(model => {
    const row = rows.get(model);
    if (!row) throw new Error(`Official rate is missing for ${model}; no prices were written.`);
    const [input, cached, writes, output] = row.slice(1, 5).map(parseRate);
    // Pre-5.6 models do not have a separate cache-write surcharge: writes retain ordinary input pricing.
    const writeRate = row[3] === "-" && ["gpt-5.5", "gpt-5.4-mini"].includes(model) ? input : writes;
    return [model, rates(input, cached, writeRate, output)];
  }));
}

export function parseDeepSeekPeakRates(html, model) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].filter(([, table]) => table.includes(model));
  if (tables.length !== 1) throw new Error("Official DeepSeek model table changed; no prices were written.");
  const rows = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
    [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => cell.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()));
  const header = rows.find(row => row[0] === "MODEL");
  const column = header?.slice(1).indexOf(model) ?? -1;
  if (column < 0) throw new Error(`Official DeepSeek model is missing: ${model}`);
  const peak = label => {
    const matches = rows.map((row, i) => row.includes(label) ? i : -1).filter(i => i >= 0);
    const row = matches.length === 1 ? rows[matches[0] + 1] : null;
    // The source uses paired off-peak/peak rows. Validate the tier and model columns before selecting a rate.
    if (!row || row[0] !== "PEAK" || row.length !== header.length) throw new Error(`Official DeepSeek peak row changed: ${label}`);
    return parseRate(row[column + 1]);
  };
  const input = peak("1M INPUT TOKENS (CACHE MISS)");
  return rates(input, peak("1M INPUT TOKENS (CACHE HIT)"), input, peak("1M OUTPUT TOKENS"));
}

export function parseEcbExchangeRate(xml) {
  const cubes = [...xml.matchAll(/<Cube\b([^>]*)>/g)].map(([, attributes]) => Object.fromEntries([...attributes.matchAll(/(\w+)=['"]([^'"]+)['"]/g)].map(([, name, value]) => [name, value])));
  const dates = cubes.filter(cube => cube.time), usd = cubes.filter(cube => cube.currency === "USD");
  const date = dates[0]?.time, rate = Number(usd[0]?.rate);
  if (dates.length !== 1 || usd.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !Number.isFinite(rate) || rate <= 0) throw new Error("Official ECB exchange rate changed; no prices were written.");
  return { usd_per_eur: rate, source: exchangeSource, updated_at: date };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Pricing download failed: HTTP ${response.status}`);
  return response.text();
}

// Explicit maintainer operation. Runtime dashboards always use the bundled snapshot plus local TOML overrides.
export async function updatePricing(path = fileURLToPath(new URL("../mcp/agent-control/assets/pricing.json", import.meta.url))) {
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  const references = catalog.model_references ?? {};
  const sources = [...new Set(Object.values(references).map(reference => reference.source))];
  const [markdown, exchange, ...pages] = await Promise.all([download(`${catalog.source}.md`), download(exchangeSource), ...sources.map(download)]);
  const refreshed = parseOpenAIStandardRates(markdown, Object.keys(catalog.models).filter(model => !references[model]));
  for (const [alias, reference] of Object.entries(references)) {
    if (reference.source !== "https://api-docs.deepseek.com/quick_start/pricing/" || reference.basis !== "Peak API rates") throw new Error(`Unsupported price reference: ${alias}`);
    refreshed[alias] = parseDeepSeekPeakRates(pages[sources.indexOf(reference.source)], reference.model);
  }
  catalog.models = refreshed;
  catalog.exchange = parseEcbExchangeRate(exchange);
  catalog.updated_at = new Date().toISOString().slice(0, 10);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  renameSync(temporary, path);
  console.log(`Updated ${Object.keys(catalog.models).length} model prices from ${[catalog.source, ...sources].join(", ")} (${catalog.updated_at}) and ECB exchange rate (${catalog.exchange.updated_at}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await updatePricing();
