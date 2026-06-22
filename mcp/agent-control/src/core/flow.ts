import { z } from "zod";
import { ControllerError } from "./errors.js";
import type {
  FlowArtifactBindingRecord,
  FlowArtifactReferenceConfig,
  FlowConditionConfig,
  FlowConfig,
  FlowPromptConfig,
  FlowPromptReferenceConfig,
  FlowResultSchemaConfig,
  FlowStepActionConfig,
  FlowStepConfig,
  FlowTransitionConfig
} from "./types.js";

const artifactReferenceSchema = z.object({
  artifact: z.string().min(1),
  required: z.boolean().optional()
});

const resultPropertySchema = z.object({
  enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
});

const resultSchema = z.object({
  type: z.literal("object").optional(),
  required: z.array(z.string().min(1)).optional(),
  properties: z.record(resultPropertySchema).optional()
});

const reportSchema = z.object({
  tool: z.string().min(1).optional(),
  schema: resultSchema.optional()
});

const promptSourceSchema: z.ZodType<FlowPromptConfig> = z.object({
  path: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  description: z.string().min(1).optional()
});

const conditionSchema: z.ZodType<FlowConditionConfig> = z.lazy(() =>
  z.union([
    z.object({
      equals: z
        .object({
          var: z.string().min(1),
          value: z.unknown()
        })
        .required({ value: true })
    }),
    z.object({
      exists: z.object({
        var: z.string().min(1)
      })
    }),
    z.object({
      all: z.array(conditionSchema).min(1)
    }),
    z.object({
      any: z.array(conditionSchema).min(1)
    })
  ])
);

const actionShape = {
  notify: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  finish: z.boolean().optional()
};

const actionSchema: z.ZodType<FlowStepActionConfig> = z.lazy(() =>
  z.object({
    ...actionShape,
    transitions: z.array(transitionSchema).optional()
  })
);

const transitionSchema: z.ZodType<FlowTransitionConfig> = z.lazy(() =>
  z.object({
    ...actionShape,
    id: z.string().min(1),
    when: conditionSchema.optional(),
    transitions: z.array(transitionSchema).optional()
  })
);

const stepSchema: z.ZodType<FlowStepConfig> = z.object({
  role: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  prompt_ref: z.string().min(1).optional(),
  prompt_path: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  inputs: z.record(artifactReferenceSchema).optional(),
  outputs: z.record(artifactReferenceSchema).optional(),
  report: reportSchema.optional(),
  on: z.record(actionSchema).optional()
});

const roleSchema = z.object({
  backend: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  prompt_ref: z.string().min(1).optional(),
  prompt_path: z.string().min(1).optional()
});

export const flowConfigSchema: z.ZodType<FlowConfig> = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  initial_step: z.string().min(1),
  prompts: z.record(promptSourceSchema).optional(),
  artifacts: z
    .record(
      z.object({
        path: z.string().min(1).optional(),
        description: z.string().min(1).optional()
      })
    )
    .optional(),
  roles: z.record(roleSchema).optional(),
  steps: z.record(stepSchema)
});

export function parseFlowConfig(value: unknown): FlowConfig {
  const parsed = flowConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ControllerError("Invalid flow config.", "tool_error", {
      issues: parsed.error.issues
    });
  }
  validateFlowConfigReferences(parsed.data);
  return parsed.data;
}

export function validateFlowConfigReferences(config: FlowConfig): void {
  const stepIds = new Set(Object.keys(config.steps));
  if (!stepIds.has(config.initial_step)) {
    throw new ControllerError("Flow initial_step does not reference a defined step.", "tool_error", {
      initial_step: config.initial_step
    });
  }

  const promptIds = new Set(Object.keys(config.prompts ?? {}));
  for (const [promptId, prompt] of Object.entries(config.prompts ?? {})) {
    validatePromptSource(`prompts.${promptId}`, prompt);
  }
  for (const [roleId, role] of Object.entries(config.roles ?? {})) {
    validatePromptReference(promptIds, `roles.${roleId}`, role);
  }

  const artifactIds = new Set(Object.keys(config.artifacts ?? {}));
  for (const [stepId, step] of Object.entries(config.steps)) {
    validatePromptReference(promptIds, `steps.${stepId}`, step);
    validateArtifactReferences(config, artifactIds, stepId, "inputs", step.inputs);
    validateArtifactReferences(config, artifactIds, stepId, "outputs", step.outputs);
    for (const [eventName, action] of Object.entries(step.on ?? {})) {
      validateActionReferences(stepIds, stepId, eventName, action);
    }
  }
}

export function validateStepResult(schema: FlowResultSchemaConfig | undefined, result: Record<string, unknown>): void {
  if (!schema) {
    return;
  }
  if ((schema.type ?? "object") !== "object") {
    throw new ControllerError("Only object result schemas are supported in flow config v0.", "tool_error", {
      schema
    });
  }
  for (const key of schema.required ?? []) {
    if (!(key in result)) {
      throw new ControllerError("Flow step report is missing a required result field.", "tool_error", {
        field: key
      });
    }
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!(key in result) || !property.enum) {
      continue;
    }
    if (!property.enum.some((candidate) => Object.is(candidate, result[key]))) {
      throw new ControllerError("Flow step report result field is outside the configured enum.", "tool_error", {
        field: key,
        value: result[key],
        allowed: property.enum
      });
    }
  }
}

export function resolveStepEventAction(step: FlowStepConfig, status: string): FlowStepActionConfig | null {
  const on = step.on ?? {};
  if (on.reported) {
    return on.reported;
  }
  if (status === "completed" && on.completed) {
    return on.completed;
  }
  if (status === "blocked" && on.blocked) {
    return on.blocked;
  }
  if (status === "failed" && on.failed) {
    return on.failed;
  }
  return null;
}

export function selectTransition(
  action: FlowStepActionConfig,
  context: Record<string, unknown>
): FlowTransitionConfig | null {
  for (const transition of action.transitions ?? []) {
    if (!transition.when || evaluateCondition(transition.when, context)) {
      return transition;
    }
  }
  return null;
}

export function evaluateCondition(condition: FlowConditionConfig, context: Record<string, unknown>): boolean {
  if ("equals" in condition) {
    return Object.is(valueAtPath(context, condition.equals.var), condition.equals.value);
  }
  if ("exists" in condition) {
    return valueAtPath(context, condition.exists.var) !== undefined;
  }
  if ("all" in condition) {
    return condition.all.every((item) => evaluateCondition(item, context));
  }
  return condition.any.some((item) => evaluateCondition(item, context));
}

export function resolveArtifactPath(template: string, input: { runId: string; runDir: string }): string {
  return template.replaceAll("{run_id}", input.runId).replaceAll("{run_dir}", input.runDir);
}

export function resolveInputArtifacts(
  inputRefs: Record<string, FlowArtifactReferenceConfig> | undefined,
  bindings: FlowArtifactBindingRecord[]
): Record<string, string> {
  const byKey = new Map(bindings.map((binding) => [binding.artifact_key, binding.path]));
  const resolved: Record<string, string> = {};
  for (const [inputName, ref] of Object.entries(inputRefs ?? {})) {
    const path = byKey.get(ref.artifact);
    if (path) {
      resolved[inputName] = path;
    }
  }
  return resolved;
}

export function resolveStepPromptSources(config: FlowConfig, stepId: string): Array<Record<string, unknown>> {
  const step = config.steps[stepId];
  if (!step) {
    return [];
  }
  const sources: Array<Record<string, unknown>> = [];
  const roleConfig = step.role ? config.roles?.[step.role] : undefined;
  const rolePrompt = roleConfig ? resolvePromptSource(config, "role", step.role!, roleConfig) : null;
  const stepPrompt = resolvePromptSource(config, "step", stepId, step);
  if (rolePrompt) {
    sources.push(rolePrompt);
  }
  if (stepPrompt) {
    sources.push(stepPrompt);
  }
  return sources;
}

function validateArtifactReferences(
  config: FlowConfig,
  artifactIds: Set<string>,
  stepId: string,
  direction: "inputs" | "outputs",
  refs: Record<string, FlowArtifactReferenceConfig> | undefined
): void {
  for (const [name, ref] of Object.entries(refs ?? {})) {
    if (!artifactIds.has(ref.artifact)) {
      throw new ControllerError("Flow step references an undefined artifact.", "tool_error", {
        step_id: stepId,
        direction,
        name,
        artifact: ref.artifact,
        defined_artifacts: Object.keys(config.artifacts ?? {})
      });
    }
  }
}

function resolvePromptSource(
  config: FlowConfig,
  scope: "role" | "step",
  ownerId: string,
  prompt: FlowPromptReferenceConfig
): Record<string, unknown> | null {
  if (prompt.prompt_ref) {
    const referenced = config.prompts?.[prompt.prompt_ref];
    return referenced
      ? {
          scope,
          owner_id: ownerId,
          prompt_ref: prompt.prompt_ref,
          ...referenced
        }
      : null;
  }
  if (prompt.prompt_path) {
    return {
      scope,
      owner_id: ownerId,
      path: prompt.prompt_path
    };
  }
  if (prompt.prompt) {
    return {
      scope,
      owner_id: ownerId,
      text: prompt.prompt
    };
  }
  return null;
}

function validateActionReferences(
  stepIds: Set<string>,
  stepId: string,
  eventName: string,
  action: FlowStepActionConfig
): void {
  if (action.to && !stepIds.has(action.to)) {
    throw new ControllerError("Flow action references an undefined target step.", "tool_error", {
      step_id: stepId,
      event: eventName,
      target_step: action.to
    });
  }
  for (const transition of action.transitions ?? []) {
    if (transition.when) {
      validateCondition(stepId, `${eventName}:${transition.id}`, transition.when);
    }
    validateActionReferences(stepIds, stepId, `${eventName}:${transition.id}`, transition);
  }
}

function validateCondition(stepId: string, eventName: string, condition: FlowConditionConfig): void {
  if ("equals" in condition && !Object.prototype.hasOwnProperty.call(condition.equals, "value")) {
    throw new ControllerError("Flow equals condition requires a value field.", "tool_error", {
      step_id: stepId,
      event: eventName,
      var: condition.equals.var
    });
  }
  if ("all" in condition) {
    for (const nested of condition.all) {
      validateCondition(stepId, eventName, nested);
    }
  }
  if ("any" in condition) {
    for (const nested of condition.any) {
      validateCondition(stepId, eventName, nested);
    }
  }
}

function valueAtPath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function validatePromptSource(owner: string, prompt: FlowPromptConfig): void {
  const sourceCount = [prompt.path, prompt.text].filter(Boolean).length;
  if (sourceCount !== 1) {
    throw new ControllerError("Flow prompt source must define exactly one of path or text.", "tool_error", {
      owner
    });
  }
  if (prompt.path) {
    validateMarkdownPromptPath(owner, prompt.path);
  }
}

function validatePromptReference(
  promptIds: Set<string>,
  owner: string,
  prompt: FlowPromptReferenceConfig
): void {
  const sourceCount = [prompt.prompt, prompt.prompt_ref, prompt.prompt_path].filter(Boolean).length;
  if (sourceCount > 1) {
    throw new ControllerError("Flow role or step prompt must define only one prompt source.", "tool_error", {
      owner
    });
  }
  if (prompt.prompt_ref && !promptIds.has(prompt.prompt_ref)) {
    throw new ControllerError("Flow prompt_ref references an undefined prompt.", "tool_error", {
      owner,
      prompt_ref: prompt.prompt_ref,
      defined_prompts: [...promptIds]
    });
  }
  if (prompt.prompt_path) {
    validateMarkdownPromptPath(owner, prompt.prompt_path);
  }
}

function validateMarkdownPromptPath(owner: string, path: string): void {
  if (!path.toLowerCase().endsWith(".md")) {
    throw new ControllerError("Flow prompt paths must reference Markdown files.", "tool_error", {
      owner,
      path
    });
  }
}
