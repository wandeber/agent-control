import { z } from "zod";
import { ControllerError } from "./errors.js";
const CODEX_SUBAGENT_BACKEND = "codex-subagent";
const CODEX_SUBAGENT_ROLE_KEYS = new Set([
    "backend",
    "model",
    "description",
    "prompt",
    "prompt_ref",
    "prompt_path",
    "agent_lifecycle",
    "backend_options"
]);
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
const promptSourceSchema = z.object({
    path: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    description: z.string().min(1).optional()
});
const conditionSchema = z.lazy(() => z.union([
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
]));
const actionShape = {
    notify: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    finish: z.boolean().optional()
};
const actionSchema = z.lazy(() => z.object({
    ...actionShape,
    transitions: z.array(transitionSchema).optional()
}));
const transitionSchema = z.lazy(() => z.object({
    ...actionShape,
    id: z.string().min(1),
    when: conditionSchema.optional(),
    transitions: z.array(transitionSchema).optional()
}));
const stepSchema = z.object({
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
const codexSubagentForkTurnsSchema = z
    .string()
    .refine((value) => value === "none" || value === "all" || /^[1-9]\d*$/.test(value), {
    message: "fork_turns must be none, all, or a positive integer string."
});
const codexSubagentOptionsSchema = z.object({
    fork_turns: codexSubagentForkTurnsSchema.optional()
});
const roleSchema = z.object({
    backend: z.string().min(1).optional(),
    model: z.string().nullable().optional(),
    agent_lifecycle: z.enum(["reuse", "fresh_per_step"]).optional(),
    backend_options: z
        .object({
        codex_subagent: codexSubagentOptionsSchema.optional()
    })
        .optional(),
    description: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    prompt_ref: z.string().min(1).optional(),
    prompt_path: z.string().min(1).optional()
});
export const flowConfigSchema = z.object({
    id: z.string().min(1),
    version: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    initial_step: z.string().min(1),
    prompts: z.record(promptSourceSchema).optional(),
    artifacts: z
        .record(z.object({
        path: z.string().min(1).optional(),
        description: z.string().min(1).optional()
    }))
        .optional(),
    roles: z.record(roleSchema).optional(),
    steps: z.record(stepSchema)
});
export function parseFlowConfig(value) {
    assertSupportedCodexSubagentOptions(value);
    const parsed = flowConfigSchema.safeParse(value);
    if (!parsed.success) {
        throw new ControllerError("Invalid flow config.", "tool_error", {
            issues: parsed.error.issues
        });
    }
    const normalized = normalizeCodexSubagentConfig(parsed.data);
    validateFlowConfigReferences(normalized);
    return normalized;
}
/**
 * Reject native-tool options explicitly instead of letting Zod silently strip
 * them. A Codex subagent request has a deliberately small, stable contract;
 * accepting an option that the root bridge cannot apply would make the saved
 * flow differ from the operation that actually ran.
 */
function assertSupportedCodexSubagentOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
    }
    const rolesValue = value.roles;
    if (!rolesValue || typeof rolesValue !== "object" || Array.isArray(rolesValue)) {
        return;
    }
    for (const [roleId, roleValue] of Object.entries(rolesValue)) {
        if (!roleValue || typeof roleValue !== "object" || Array.isArray(roleValue)) {
            continue;
        }
        const role = roleValue;
        if (role.backend !== CODEX_SUBAGENT_BACKEND) {
            if ("model" in role && (typeof role.model !== "string" || role.model.length === 0)) {
                throw new ControllerError("Invalid flow config.", "tool_error", {
                    issues: [{ path: ["roles", roleId, "model"], message: "Expected a non-empty string." }]
                });
            }
            if ("backend_options" in role) {
                throw new ControllerError("backend_options are only supported by the codex-subagent backend.", "unsupported_operation", { role: roleId, backend: role.backend ?? null });
            }
            continue;
        }
        const unsupportedRoleKeys = Object.keys(role).filter((key) => !CODEX_SUBAGENT_ROLE_KEYS.has(key));
        if (unsupportedRoleKeys.length > 0) {
            throw new ControllerError("Unsupported codex-subagent role option.", "unsupported_operation", {
                role: roleId,
                options: unsupportedRoleKeys.sort()
            });
        }
        if (typeof role.model === "string" && role.model.trim().length > 0) {
            throw new ControllerError("codex-subagent inherits the root model and does not support model overrides.", "unsupported_operation", {
                role: roleId,
                option: "model"
            });
        }
        const backendOptions = role.backend_options;
        if (backendOptions === undefined) {
            continue;
        }
        if (!backendOptions || typeof backendOptions !== "object" || Array.isArray(backendOptions)) {
            throw new ControllerError("Invalid codex-subagent backend_options.", "unsupported_operation", { role: roleId });
        }
        const optionKeys = Object.keys(backendOptions);
        if (optionKeys.some((key) => key !== "codex_subagent")) {
            throw new ControllerError("Unsupported codex-subagent backend option namespace.", "unsupported_operation", {
                role: roleId,
                options: optionKeys.filter((key) => key !== "codex_subagent").sort()
            });
        }
        const nativeOptions = backendOptions.codex_subagent;
        if (nativeOptions === undefined) {
            continue;
        }
        if (!nativeOptions || typeof nativeOptions !== "object" || Array.isArray(nativeOptions)) {
            throw new ControllerError("Invalid codex_subagent options.", "unsupported_operation", { role: roleId });
        }
        const nativeKeys = Object.keys(nativeOptions);
        if (nativeKeys.some((key) => key !== "fork_turns")) {
            throw new ControllerError("Unsupported codex-subagent native option.", "unsupported_operation", {
                role: roleId,
                options: nativeKeys.filter((key) => key !== "fork_turns").sort()
            });
        }
    }
}
function normalizeCodexSubagentConfig(config) {
    for (const role of Object.values(config.roles ?? {})) {
        if (role.backend === CODEX_SUBAGENT_BACKEND && (role.model === null || role.model?.trim() === "")) {
            role.model = undefined;
        }
        const forkTurns = role.backend_options?.codex_subagent?.fork_turns;
        if (forkTurns !== undefined) {
            role.backend_options.codex_subagent.fork_turns = forkTurns;
        }
    }
    return config;
}
export function validateFlowConfigReferences(config) {
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
        const roleConfig = step.role ? config.roles?.[step.role] : undefined;
        if (step.agent_id && resolveFlowAgentLifecycle(roleConfig?.agent_lifecycle) === "fresh_per_step") {
            throw new ControllerError("A fresh_per_step role cannot use a persistent step agent_id.", "tool_error", {
                step_id: stepId,
                role: step.role,
                agent_id: step.agent_id
            });
        }
        validatePromptReference(promptIds, `steps.${stepId}`, step);
        validateArtifactReferences(config, artifactIds, stepId, "inputs", step.inputs);
        validateArtifactReferences(config, artifactIds, stepId, "outputs", step.outputs);
        for (const [eventName, action] of Object.entries(step.on ?? {})) {
            validateActionReferences(stepIds, stepId, eventName, action);
        }
    }
}
/**
 * Keep omitted lifecycle declarations backwards compatible without mutating
 * the parsed config. Callers can still distinguish an explicit declaration,
 * while every execution path gets the same semantic default.
 */
export function resolveFlowAgentLifecycle(lifecycle) {
    return lifecycle ?? "reuse";
}
export function validateStepResult(schema, result) {
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
export function resolveStepEventAction(step, status) {
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
export function selectTransition(action, context) {
    for (const transition of action.transitions ?? []) {
        if (!transition.when || evaluateCondition(transition.when, context)) {
            return transition;
        }
    }
    return null;
}
export function evaluateCondition(condition, context) {
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
export function resolveArtifactPath(template, input) {
    return template.replaceAll("{run_id}", input.runId).replaceAll("{run_dir}", input.runDir);
}
export function resolveInputArtifacts(inputRefs, bindings) {
    const byKey = new Map(bindings.map((binding) => [binding.artifact_key, binding.path]));
    const resolved = {};
    for (const [inputName, ref] of Object.entries(inputRefs ?? {})) {
        const path = byKey.get(ref.artifact);
        if (path) {
            resolved[inputName] = path;
        }
    }
    return resolved;
}
export function resolveStepPromptSources(config, stepId) {
    const step = config.steps[stepId];
    if (!step) {
        return [];
    }
    const sources = [];
    const roleConfig = step.role ? config.roles?.[step.role] : undefined;
    const rolePrompt = roleConfig ? resolvePromptSource(config, "role", step.role, roleConfig) : null;
    const stepPrompt = resolvePromptSource(config, "step", stepId, step);
    if (rolePrompt) {
        sources.push(rolePrompt);
    }
    if (stepPrompt) {
        sources.push(stepPrompt);
    }
    return sources;
}
function validateArtifactReferences(config, artifactIds, stepId, direction, refs) {
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
function resolvePromptSource(config, scope, ownerId, prompt) {
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
function validateActionReferences(stepIds, stepId, eventName, action) {
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
function validateCondition(stepId, eventName, condition) {
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
function valueAtPath(context, path) {
    const parts = path.split(".");
    let current = context;
    for (const part of parts) {
        if (!current || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}
function validatePromptSource(owner, prompt) {
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
function validatePromptReference(promptIds, owner, prompt) {
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
function validateMarkdownPromptPath(owner, path) {
    if (!path.toLowerCase().endsWith(".md")) {
        throw new ControllerError("Flow prompt paths must reference Markdown files.", "tool_error", {
            owner,
            path
        });
    }
}
