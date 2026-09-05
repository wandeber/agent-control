---
name: flow-author
description: Use when the user wants to design, create, or refine a declarative Agent Control flow config from a workflow idea, including roles, steps, artifacts, report schemas, and transitions.
---

# Flow Author

Use this skill to turn a user's workflow intent into an Agent Control flow
config. Prefer YAML flow packages for repository-authored flows. Agent Control
also accepts JSON, but YAML is easier to review for multi-agent workflows.

For transition semantics, notification patterns, artifact handoffs,
subscriptions, and visual relationship guidance, use the Agent Control flow
patterns reference at `docs/flow-patterns.md` when that repository path is
available.

## Authoring Rules

- Keep Agent Control generic: do not bake one workflow's result labels into the
  runtime contract.
- Model artifacts as named resources, then reference them from step `inputs`
  and `outputs`.
- Model reusable prompts as named resources under top-level `prompts`, then
  reference them from roles or steps with `prompt_ref`.
- Use role `backend` and `model` when the flow should suggest a worker backend
  or model. Prefer environment placeholders with defaults for repo-authored
  flows, for example `${DEVFLOW_ANALYST_BACKEND:-codex-thread}` and
  `${DEVFLOW_ANALYST_MODEL-gpt-5.6-luna}`. Set `reasoning_effort` to
  `${DEVFLOW_ANALYST_REASONING_EFFORT-max}` for Codex Luna Max. Preserve explicit
  Codex choices; use OpenCode only when requested with an explicit provider/model.
- Prefer Markdown prompt files for stable instructions:
  - role prompts define stable worker behavior;
  - step prompts define the current phase/action;
  - runtime payloads carry user objective, repo, artifact paths, and
    backend-specific details.
- Prompt file paths must end in `.md`. If the config is stored in a file, make
  relative prompt paths resolvable from the flow config file's directory.
- Use structured `report.schema` fields only for routing decisions that the
  flow actually needs.
- Prefer `notify: "orchestrator"` when a human or higher-intelligence
  coordinator should decide the next step.
- Use `to: "<step-id>"` only for deterministic transitions that the config can
  express safely.
- Use `finish: true` only when the flow is genuinely complete after that step.
- Avoid `waits_for` as workflow state. A step depends on artifacts or on a
  transition, not on a visual wait edge.
- Do not duplicate runtime details in prompt files. Active steps receive
  generated runtime and reporting contracts from Agent Control.
- Put user-authored flow packages under the user flow catalog unless the user
  explicitly asks to edit bundled repository flows. The default user catalog is
  `${AGENT_CONTROL_USER_DIR:-$HOME/.agent-control}/flows`, and it can be
  overridden with `AGENT_CONTROL_USER_FLOW_CATALOG_DIR`. Create the directory
  if it does not exist before writing a user flow package.

## Minimal Shape

```yaml
id: example-flow
version: 0.1.0
description: Short purpose.
initial_step: analysis
prompts:
  analyst_role:
    path: prompts/roles/analyst.md
  analysis_step:
    path: prompts/steps/analysis.md
roles:
  analyst:
    backend: ${DEVFLOW_ANALYST_BACKEND:-codex-thread}
    model: ${DEVFLOW_ANALYST_MODEL-gpt-5.6-luna}
    reasoning_effort: ${DEVFLOW_ANALYST_REASONING_EFFORT-max}
    prompt_ref: analyst_role
artifacts:
  analysis:
    path: "{run_dir}/analysis.md"
steps:
  analysis:
    role: analyst
    prompt_ref: analysis_step
    outputs:
      analysis:
        artifact: analysis
        required: true
    "on":
      reported:
        notify: orchestrator
```

## Quality Checklist

- `initial_step` exists in `steps`.
- Every role/step `prompt_ref` exists in `prompts`.
- Every prompt `path` or role/step `prompt_path` points to a `.md` file.
- Every input/output artifact reference exists in `artifacts`.
- Every `to` target exists in `steps`.
- Required artifacts have stable absolute paths or `{run_dir}` templates.
- Every transition with conditions has a corresponding `report.schema` field.
- The config can represent orchestrator-driven flows by using `notify` actions.
- The config can represent automatic flows by using `transitions` and `to`.
- Repo-authored flow files validate with `agentctl flow validate --config-file
  <flow.yaml>`, including prompt file existence relative to that config file.
- The canonical schema is available with `agentctl flow schema`.

When Agent Control is available, validate the finished config with
`flow_validate_config` or `agentctl flow validate` before handing it back.
