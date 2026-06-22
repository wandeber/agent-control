import { existsSync, readdirSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFlowConfigFile } from "./flow-config-loader.js";
import { parseFlowConfig } from "./flow.js";

export interface FlowCatalogDescriptor {
  catalog_id: string;
  name: string;
  root_path: string;
  exists: boolean;
}

export interface FlowCatalogEntry {
  catalog_id: string;
  flow_id: string | null;
  version: string | null;
  description: string | null;
  directory_name: string;
  directory_path: string;
  config_path: string;
  format: "json" | "yaml";
  valid: boolean;
  error: string | null;
}

export interface FlowCatalogListResult {
  catalogs: FlowCatalogDescriptor[];
  flows: FlowCatalogEntry[];
}

export interface FlowCatalogGetResult extends FlowCatalogEntry {
  config: Record<string, unknown>;
}

const FLOW_CONFIG_FILENAMES = ["flow.yaml", "flow.yml", "flow.json"] as const;

export function listFlowCatalog(options: {
  query?: string | null;
  catalogs?: FlowCatalogDescriptor[];
} = {}): FlowCatalogListResult {
  const catalogs = options.catalogs ?? defaultFlowCatalogs();
  const query = options.query?.trim().toLowerCase();
  const flows = catalogs.flatMap((catalog) => listCatalogFlows(catalog));
  return {
    catalogs,
    flows: query ? flows.filter((flow) => matchesFlowQuery(flow, query)) : flows
  };
}

export function getFlowFromCatalog(input: {
  flowId: string;
  catalogs?: FlowCatalogDescriptor[];
}): FlowCatalogGetResult {
  const flowId = input.flowId.trim();
  const result = listFlowCatalog({ catalogs: input.catalogs });
  const matches = result.flows.filter((flow) => flow.flow_id === flowId || flow.directory_name === flowId);
  if (matches.length === 0) {
    throw new Error(`Flow not found in catalog: ${flowId}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Flow id is ambiguous: ${flowId}. Matching config paths:\n${matches.map((flow) => flow.config_path).join("\n")}`
    );
  }
  const match = matches[0]!;
  const loaded = loadFlowConfigFile(match.config_path);
  const parsed = parseFlowConfig(loaded);
  return {
    ...match,
    flow_id: parsed.id,
    version: parsed.version ?? null,
    description: parsed.description ?? null,
    valid: true,
    error: null,
    config: loaded
  };
}

export function defaultFlowCatalogs(): FlowCatalogDescriptor[] {
  const rootPath = resolveDefaultFlowCatalogRoot();
  return [
    {
      catalog_id: "repo-flows",
      name: "Repository flows",
      root_path: rootPath,
      exists: existsSync(rootPath)
    }
  ];
}

export function resolveDefaultFlowCatalogRoot(options: {
  basePath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const envPath = options.env?.AGENT_CONTROL_FLOW_CATALOG_DIR ?? process.env.AGENT_CONTROL_FLOW_CATALOG_DIR;
  if (envPath) {
    return resolve(envPath);
  }
  const basePath = options.basePath ?? defaultCatalogBasePath();
  const candidates = uniqueStrings([
    marketplaceCacheFlowCatalogCandidate(basePath),
    marketplaceCheckoutFlowCatalogCandidate(basePath),
    ...ancestorFlowCatalogCandidates(basePath)
  ].filter((candidate): candidate is string => Boolean(candidate)));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? resolve(basePath, "flows");
}

function defaultCatalogBasePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here;
}

function ancestorFlowCatalogCandidates(basePath: string): string[] {
  const candidates: string[] = [];
  const root = parse(resolve(basePath)).root;
  let current = resolve(basePath);
  while (true) {
    candidates.push(join(current, "flows"));
    if (current === root) {
      return candidates;
    }
    current = dirname(current);
  }
}

function marketplaceCacheFlowCatalogCandidate(basePath: string): string | null {
  const parts = resolve(basePath).split(sep);
  const marker = marketplaceCacheMarker(parts);
  if (!marker) {
    return null;
  }
  return join(marker.cacheRoot, marker.marketplaceName, "flows");
}

function marketplaceCheckoutFlowCatalogCandidate(basePath: string): string | null {
  const parts = resolve(basePath).split(sep);
  const marker = marketplaceCacheMarker(parts);
  if (!marker) {
    return null;
  }
  return join(marker.codexRoot, ".tmp", "marketplaces", marker.marketplaceName, "flows");
}

function marketplaceCacheMarker(parts: string[]): {
  codexRoot: string;
  cacheRoot: string;
  marketplaceName: string;
} | null {
  const codexIndex = parts.lastIndexOf(".codex");
  const cacheIndex = parts.lastIndexOf("cache");
  if (codexIndex < 0 || cacheIndex < 0 || parts[cacheIndex - 1] !== "plugins") {
    return null;
  }
  const marketplaceName = parts[cacheIndex + 1];
  if (!marketplaceName) {
    return null;
  }
  const codexRoot = parts.slice(0, codexIndex + 1).join(sep) || sep;
  const cacheRoot = parts.slice(0, cacheIndex + 1).join(sep) || sep;
  return { codexRoot, cacheRoot, marketplaceName };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function listCatalogFlows(catalog: FlowCatalogDescriptor): FlowCatalogEntry[] {
  if (!catalog.exists) {
    return [];
  }
  return readdirSync(catalog.root_path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directoryPath = join(catalog.root_path, entry.name);
      const configPath = FLOW_CONFIG_FILENAMES.map((filename) => join(directoryPath, filename)).find((candidate) =>
        existsSync(candidate)
      );
      if (!configPath) {
        return [];
      }
      return [summarizeFlowConfig(catalog, entry.name, directoryPath, configPath)];
    })
    .sort((left, right) => {
      const leftName = left.flow_id ?? left.directory_name;
      const rightName = right.flow_id ?? right.directory_name;
      return leftName.localeCompare(rightName);
    });
}

function summarizeFlowConfig(
  catalog: FlowCatalogDescriptor,
  directoryName: string,
  directoryPath: string,
  configPath: string
): FlowCatalogEntry {
  try {
    const loaded = loadFlowConfigFile(configPath);
    const parsed = parseFlowConfig(loaded);
    return {
      catalog_id: catalog.catalog_id,
      flow_id: parsed.id,
      version: parsed.version ?? null,
      description: parsed.description ?? null,
      directory_name: directoryName,
      directory_path: directoryPath,
      config_path: configPath,
      format: configPath.endsWith(".json") ? "json" : "yaml",
      valid: true,
      error: null
    };
  } catch (error) {
    return {
      catalog_id: catalog.catalog_id,
      flow_id: null,
      version: null,
      description: null,
      directory_name: directoryName,
      directory_path: directoryPath,
      config_path: configPath,
      format: configPath.endsWith(".json") ? "json" : "yaml",
      valid: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function matchesFlowQuery(flow: FlowCatalogEntry, query: string): boolean {
  return [
    flow.flow_id,
    flow.version,
    flow.description,
    flow.directory_name,
    flow.config_path
  ].some((value) => value?.toLowerCase().includes(query));
}
