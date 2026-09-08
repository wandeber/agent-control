import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { defaultControlHome } from "./paths.js";
import { resolveProjectRoot } from "./project-models.js";
import type { AgentRecord, UsageSnapshotRecord } from "./types.js";

export interface TokenRates {
  input_per_million: number;
  cached_input_per_million: number;
  cache_write_input_per_million: number;
  output_per_million: number;
}
export interface CostAmount { usd: number | null; partial: boolean }
export interface PriceReference { model: string; source: string; basis: string }
export interface ExchangeRate { usd_per_eur: number; source: string | null; updated_at: string | null }
export interface CostBreakdown {
  input: CostAmount;
  cached: CostAmount;
  cache_write: CostAmount;
  output: CostAmount;
  total: CostAmount;
}
export interface AgentCost extends CostBreakdown {
  agent_id: string;
  model: string;
  pricing_key: string | null;
  rates: TokenRates | null;
}
export interface RunCosts {
  currency: "USD";
  updated_at: string;
  source: string;
  basis: string;
  configuration_valid: boolean;
  override_files: string[];
  model_references?: Record<string, PriceReference>;
  exchange?: ExchangeRate;
  agents: AgentCost[];
  models: Array<CostBreakdown & { model: string }>;
  total: CostBreakdown;
}
interface Catalog {
  currency: "USD"; updated_at: string; source: string; basis: string;
  models: Record<string, TokenRates>;
  model_references: Record<string, PriceReference>;
  exchange?: ExchangeRate;
  overrides: Set<string>; files: string[];
}
const bundled = JSON.parse(readFileSync(new URL("../../assets/pricing.json", import.meta.url), "utf8")) as Omit<Catalog, "overrides" | "files">;
const fields = ["input_per_million", "cached_input_per_million", "cache_write_input_per_million", "output_per_million"] as const;
const components = ["input", "cached", "cache_write", "output"] as const;
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const optionalCount = (n: unknown): boolean => n === null || n === undefined || count(n);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const unknown = (): CostAmount => ({ usd: null, partial: true });
const amount = (usd: number): CostAmount => Number.isFinite(usd) ? { usd, partial: false } : unknown();

export function sumCosts(values: CostAmount[]): CostAmount {
  const known = values.filter(v => v.usd !== null);
  if (!known.length) return unknown();
  const result = amount(known.reduce((sum, v) => sum + v.usd!, 0));
  return { usd: result.usd, partial: result.partial || values.some(v => v.partial || v.usd === null) };
}

/** Rates are loaded locally. A dashboard refresh never downloads prices or starts a model. */
export function loadPricing(projectDir?: string | null, home = defaultControlHome()): Catalog {
  const catalog: Catalog = { ...structuredClone(bundled), overrides: new Set(), files: [] };
  const root = resolveProjectRoot(projectDir);
  for (const path of [join(home, "pricing.toml"), ...(root ? [join(root, ".agents", "pricing.toml")] : [])]) {
    if (!existsSync(path)) continue;
    const config = parse(readFileSync(path, "utf8"));
    if (!Object.keys(config).length || Object.keys(config).some(k => k !== "models" && k !== "exchange") || (config.models !== undefined && !record(config.models))) throw new Error(`Invalid pricing configuration: ${path}`);
    if (config.exchange !== undefined) {
      if (!record(config.exchange) || Object.keys(config.exchange).length !== 1 || typeof config.exchange.usd_per_eur !== "number" || !Number.isFinite(config.exchange.usd_per_eur) || config.exchange.usd_per_eur <= 0) throw new Error(`Invalid exchange rate: ${path}`);
      // A configured conversion must not retain the source/date of the bundled ECB quote.
      catalog.exchange = { usd_per_eur: config.exchange.usd_per_eur, source: null, updated_at: null };
    }
    // Validate the complete file before using any of its rates. Never silently price an invalid override at defaults.
    for (const [model, override] of Object.entries(config.models ?? {})) {
      if (!model.trim() || model.trim() !== model || !record(override) || !Object.keys(override).length || Object.keys(override).some(k => !fields.includes(k as typeof fields[number]))) throw new Error(`Invalid pricing model: ${model}`);
      const rates = { ...catalog.models[model], ...override } as TokenRates;
      if (fields.some(k => typeof rates[k] !== "number" || !Number.isFinite(rates[k]) || rates[k] < 0)) throw new Error(`Incomplete or invalid pricing rates: ${model}`);
      catalog.models[model] = rates;
      catalog.overrides.add(model);
    }
    catalog.files.push(path);
  }
  return catalog;
}

/** Input partitions and reasoning are already included in input/output. Do not bill them twice. */
export function estimateTokenCost(usage: UsageSnapshotRecord | null, rates: TokenRates | null): CostBreakdown {
  const result: CostBreakdown = { input: unknown(), cached: unknown(), cache_write: unknown(), output: unknown(), total: unknown() };
  if (!usage || !rates) return result;
  if (count(usage.output_tokens)) result.output = amount(usage.output_tokens * rates.output_per_million / 1e6);
  const input = usage.input_tokens, cached = usage.cached_input_tokens, writes = usage.cache_write_input_tokens;
  if (count(input) && input === 0 && optionalCount(cached) && optionalCount(writes) && (!count(cached) || cached === 0) && (!count(writes) || writes === 0)) {
    result.input = result.cached = result.cache_write = amount(0);
  } else if (count(input) && count(cached) && optionalCount(writes) && cached <= input && (!count(writes) || cached + writes <= input)) {
    result.cached = amount(cached * rates.cached_input_per_million / 1e6);
    if (count(writes)) {
      result.input = amount((input - cached - writes) * rates.input_per_million / 1e6);
      result.cache_write = amount(writes * rates.cache_write_input_per_million / 1e6);
    } else if (rates.cache_write_input_per_million === rates.input_per_million) {
      // Older models have no separate write surcharge; the unknown split does not affect their total.
      result.input = amount((input - cached) * rates.input_per_million / 1e6);
      result.cache_write = amount(0);
    }
  }
  result.total = sumCosts(components.map(k => result[k]));
  return result;
}

function summarize(items: CostBreakdown[]): CostBreakdown {
  return { input: sumCosts(items.map(i => i.input)), cached: sumCosts(items.map(i => i.cached)), cache_write: sumCosts(items.map(i => i.cache_write)), output: sumCosts(items.map(i => i.output)), total: sumCosts(items.map(i => i.total)) };
}

export function buildRunCosts(agents: AgentRecord[], usage: Map<string, UsageSnapshotRecord>, projectDir?: string | null, home?: string): RunCosts {
  let catalog: Catalog;
  let valid = true;
  try { catalog = loadPricing(projectDir, home); }
  catch { catalog = { ...bundled, models: {}, overrides: new Set(), files: [] }; valid = false; }
  const seenThreads = new Set<string>();
  const usageOwner = new Map<string, string>();
  for (const agent of agents) {
    const id = agent.backend_handle?.thread_id;
    if (typeof id === "string" && (!usageOwner.has(id) || usage.has(agent.agent_id))) usageOwner.set(id, agent.agent_id);
  }
  const costs: AgentCost[] = [];
  for (const agent of agents) {
    const observed = usage.get(agent.agent_id) ?? null;
    if (!observed && agent.status === "planned") continue;
    const threadId = agent.backend_handle?.thread_id;
    if (typeof threadId === "string") {
      if (usageOwner.get(threadId) !== agent.agent_id) continue;
      if (seenThreads.has(threadId)) continue;
      seenThreads.add(threadId);
    }
    const model = observed?.model || agent.model || (typeof agent.backend_handle?.resolved_model === "string" ? agent.backend_handle.resolved_model : "Unknown model");
    const provider = agent.backend_handle?.model_provider ?? agent.backend_handle?.provider;
    const qualified = typeof provider === "string" ? `${provider}/${model}` : null;
    // External aliases need an explicit reference or override; a matching OpenAI display name is insufficient.
    const native = (provider === "openai" || (!provider && !(agent.backend === "codex-cli" && agent.backend_handle?.profile))) && agent.backend.startsWith("codex");
    const key = qualified && catalog.models[qualified] ? qualified : catalog.models[model] && (native || catalog.overrides.has(model) || catalog.model_references[model]) ? model : null;
    const rates = key ? catalog.models[key] : null;
    costs.push({ agent_id: agent.agent_id, model, pricing_key: key, rates, ...estimateTokenCost(observed, rates) });
  }
  const groups = new Map<string, AgentCost[]>();
  for (const cost of costs) groups.set(cost.model, [...(groups.get(cost.model) ?? []), cost]);
  return {
    currency: "USD", updated_at: catalog.updated_at, source: catalog.source, basis: catalog.basis,
    configuration_valid: valid, override_files: catalog.files, exchange: valid ? catalog.exchange : undefined,
    model_references: Object.fromEntries([...groups.keys()].filter(model => catalog.model_references[model]).map(model => [model, catalog.model_references[model]])), agents: costs,
    models: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([model, values]) => ({ model, ...summarize(values) })),
    total: summarize(costs)
  };
}
