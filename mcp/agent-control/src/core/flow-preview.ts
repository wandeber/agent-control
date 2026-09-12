import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { getFlowFromCatalog, listFlowCatalog } from "./flow-catalog.js";
import { parseFlowConfig, resolveStepPromptSources } from "./flow.js";
import { resolveProjectRoot } from "./project-models.js";

/** A source preview has no execution identity and never changes a pinned run. */
export function previewFlowCatalog(projectDir?: string | null, flowId?: string | null) {
  const projectRoot = resolveProjectRoot(projectDir) ?? null;
  const catalog = listFlowCatalog({ projectDir: projectRoot });
  const selected = flowId ? catalog.flows.find(flow => flow.flow_id === flowId || flow.directory_name === flowId) : catalog.flows[0];
  let definition = null;
  let error: string | null = null;
  if (selected) {
    try {
      const loaded = getFlowFromCatalog({ flowId: selected.flow_id ?? selected.directory_name, projectDir: projectRoot });
      const config = parseFlowConfig(loaded.config);
      const roots = [...catalog.catalogs.map(value => value.root_path), ...(projectRoot ? [projectRoot] : [])];
      const prompts = Object.fromEntries(Object.keys(config.steps).map(stepId => [stepId,
        resolveStepPromptSources(config, stepId).map(source => previewPrompt(source, roots))]));
      definition = { ...selected, config, prompts };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The flow is not valid yet.";
    }
  } else if (flowId) {
    error = "Waiting for this flow to be created in the catalog.";
  }
  const state = { ...catalog, project_dir: projectRoot, selected_flow_id: selected?.flow_id ?? flowId ?? selected?.directory_name ?? null, definition, error };
  return { ...state, revision: createHash("sha256").update(JSON.stringify(state)).digest("hex") };
}

function previewPrompt(source: Record<string, unknown>, roots: string[]) {
  const result = { ...source, text: typeof source.text === "string" ? source.text : null, error: null as string | null };
  if (typeof source.path !== "string") return result;
  try {
    const path = realpathSync(source.path);
    // Unlike execution, the preview is a UI read surface. Do not let a catalog
    // file make it read arbitrary external Markdown through ../ or symlinks.
    if (!roots.some(root => {
      try { const rel = relative(realpathSync(root), path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\")); }
      catch { return false; }
    })) throw new Error("Prompt is outside the flow catalog and project folders.");
    if (statSync(path).size > 512 * 1024) throw new Error("Prompt is too large to preview (512 KiB limit).");
    result.text = readFileSync(path, "utf8");
  } catch (cause) { result.error = cause instanceof Error ? cause.message : "Prompt unavailable."; }
  return result;
}
