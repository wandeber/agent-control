import {
  agentDefinitionConfigureToolSchema,
  agentDefinitionDeleteToolSchema,
  agentDefinitionGetSchema,
  agentDefinitionInventorySchema,
  agentDefinitionLaunchSchema,
  agentDefinitionListSchema
} from "../agent-definitions.js";
import type { ToolDefinition } from "./json-schema.js";

const string = (description: string) => ({ type: "string", description });
const toggle = (key: "id" | "path" | "name") => ({
  type: "array",
  items: {
    type: "object",
    properties: { [key]: string("Capability identity."), enabled: { type: "boolean" } },
    required: [key, "enabled"],
    additionalProperties: false
  }
});
const patch = {
  type: "object",
  properties: {
    name: string("Personal agent name."),
    description: string("Short catalog description."),
    instructions: string("Instructions appended to the inherited developer instructions."),
    model: string("Configured model id or alias."),
    model_provider: string("Configured provider id."),
    reasoning_effort: string("Reasoning effort supported by the selected model or validated at launch."),
    skills_catalog_token_budget: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
    plugins: toggle("id"),
    skills: toggle("path"),
    mcp_servers: toggle("name")
  },
  additionalProperties: false
};
const selector = {
  definition_id: string("Stable configured-agent definition id."),
  name: string("Exact personal agent name; choose this or definition_id.")
};
const authority = {
  admin_key: string("Optional explicit local operator credential."),
  agent_token: string("Worker and run-scoped tokens are rejected for catalog mutations.")
};

export const AGENT_DEFINITION_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "agent_definition_list",
    description: "List the ordered personal configured-agent catalog and its compare-and-swap revision.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    schema: agentDefinitionListSchema
  },
  {
    name: "agent_definition_get",
    description: "Get one personal configured-agent definition by definition_id or exact normalized name.",
    inputSchema: { type: "object", properties: selector, additionalProperties: false },
    schema: agentDefinitionGetSchema
  },
  {
    name: "agent_definition_inventory",
    description: "Read the feature-qualified Codex runtime inventory used to configure agents. Set refresh only for an explicit rescan.",
    inputSchema: { type: "object", properties: {
      repo_dir: string("Project directory used for project-scoped capabilities."),
      refresh: { type: "boolean", description: "Bypass the cached inventory and requalify the runtime." }
    }, additionalProperties: false },
    schema: agentDefinitionInventorySchema
  },
  {
    name: "agent_definition_configure",
    description: "Create, update, duplicate, or reorder one personal configured-agent definition with catalog revision compare-and-swap.",
    inputSchema: { type: "object", properties: {
      ...authority,
      operation: { type: "string", enum: ["create", "update", "duplicate"] },
      expected_revision: string("Revision returned by the latest catalog read."),
      definition_id: string("Definition to update."),
      source_id: string("Definition to duplicate."),
      position: { type: "integer", minimum: 0, description: "Optional zero-based catalog position." },
      patch
    }, required: ["operation", "expected_revision", "patch"], additionalProperties: false },
    schema: agentDefinitionConfigureToolSchema
  },
  {
    name: "agent_definition_delete",
    description: "Delete one personal configured-agent definition with catalog revision compare-and-swap.",
    inputSchema: { type: "object", properties: {
      ...authority,
      definition_id: string("Definition to delete."),
      expected_revision: string("Revision returned by the latest catalog read.")
    }, required: ["definition_id", "expected_revision"], additionalProperties: false },
    schema: agentDefinitionDeleteToolSchema
  },
  {
    name: "agent_definition_launch",
    description: "Launch a supervised worker from an immutable configured-agent snapshot after a fresh runtime and capability check.",
    inputSchema: { type: "object", properties: {
      ...selector,
      ...authority,
      prompt: string("Task prompt; choose this or prompt_file."),
      prompt_file: string("Canonical prompt file; choose this or prompt."),
      title: string("Optional execution title."),
      repo_dir: string("Project directory."),
      run_id: string("Optional existing run."),
      phase: string("Execution phase."),
      role: string("Worker role."),
      objective: string("Bounded objective."),
      sandbox: { type: "string", enum: ["read_only", "workspace"] },
      approval_policy: { type: "string", enum: ["on-request"] },
      output_artifact: string("Optional expected output artifact."),
      input_handoffs: { type: "array", items: {} },
      input_artifacts: { type: "array", items: { type: "string" } },
      constraints: { type: "array", items: { type: "string" } },
      expected_artifacts: { type: "array", items: { type: "string" } },
      attachments: { type: "array", items: { type: "string" } },
      watch: { type: "boolean" },
      requester_thread_id: string("Original user conversation."),
      requester_event_types: { type: "array", items: { type: "string" } },
      requester_delivery: { type: "string", enum: ["wait", "notify"] }
    }, additionalProperties: false },
    schema: agentDefinitionLaunchSchema
  }
];
