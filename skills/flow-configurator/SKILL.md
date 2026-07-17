---
name: flow-configurator
description: Use when the user wants to inspect or configure backend, model, or other environment-variable overrides for an Agent Control flow such as development-flow-v1 without editing the flow YAML.
---

# Flow Configurator

Use this skill to configure a declarative Agent Control flow through
project-local environment overrides. The flow config remains the source of
truth; this skill writes or updates `.agents.env` in the current project so a
user can change role backends, models, or other `${VAR:-default}` placeholders
without editing `flow.yaml`.

## Rules

- Discover named flows through Agent Control first: use `flow_catalog_list` and
  `flow_catalog_get` when MCP tools are available, or `agentctl flow catalog
  list` / `agentctl flow catalog get --flow <flow-id>` as CLI fallback.
- Do not modify the flow config unless the user explicitly asks to author or
  change a flow. Configuration means editing `.agents.env`.
- Preserve unrelated `.agents.env` lines, comments, and keys.
- Configure only variables used by the selected flow unless the user explicitly
  asks for an extra environment key.
- If the user asks to configure a named flow but does not provide values, list
  the flow's configurable variables and their defaults, then ask for the
  desired backend/model choices.
- Treat explicit user choices as higher priority than existing `.agents.env`
  values or flow defaults.

## Deterministic Helper

Use `scripts/flow-env-configurator.mjs` for the fragile parts: resolving a flow,
extracting environment placeholders, and editing `.agents.env`.
Resolve the script path relative to this skill directory.

List configurable variables:

```bash
node "$SKILL_DIR/scripts/flow-env-configurator.mjs" list \
  --flow development-flow-v1 \
  --agents-env .agents.env
```

Generate a commented template:

```bash
node "$SKILL_DIR/scripts/flow-env-configurator.mjs" template \
  --flow development-flow-v1 \
  --agents-env .agents.env
```

Set concrete overrides:

```bash
node "$SKILL_DIR/scripts/flow-env-configurator.mjs" set \
  --flow development-flow-v1 \
  --agents-env .agents.env \
  --set DEVFLOW_ANALYST_BACKEND=opencode-server \
  --set DEVFLOW_ANALYST_MODEL=opencode-go/deepseek-v4-pro
```

The helper validates that `--set` keys exist in the selected flow. Use
`--allow-unknown` only when the user explicitly asks for an extra key.

## Environment Loading

`.agents.env` is a project-local override file. Do not source it inside the
skill or print secret-like values. When launching a flow, ensure the runner or
shell environment loads these values before Agent Control expands placeholders.
If the current runner does not auto-load `.agents.env`, launch from a shell that
exports it first or tell the user that the file has been written and must be
loaded by the process that runs `agentctl`.

## Common Development Flow Keys

For `development-flow-v1`, the current configurable role keys are:

- `DEVFLOW_ANALYST_BACKEND`
- `DEVFLOW_ANALYST_MODEL`
- `DEVFLOW_PLANNER_BACKEND`
- `DEVFLOW_PLANNER_MODEL`
- `DEVFLOW_IMPLEMENTER_BACKEND`
- `DEVFLOW_IMPLEMENTER_MODEL`
- `DEVFLOW_FINAL_REVIEWER_BACKEND`
- `DEVFLOW_FINAL_REVIEWER_MODEL`

Prefer flow discovery over hard-coding this list, because future flows can add
different variables.

## Opting Into Native Codex Subagents

The bundled development/demo roles keep their current backend defaults. To opt
one configurable role into the native bridge, set its backend to
`codex-subagent` and set its model variable to an explicit empty value so the
worker inherits the root model:

```bash
node "$SKILL_DIR/scripts/flow-env-configurator.mjs" set \
  --flow development-flow-v1 \
  --agents-env .agents.env \
  --set DEVFLOW_ANALYST_BACKEND=codex-subagent \
  --set DEVFLOW_ANALYST_MODEL=
```

The bundled role then uses the safe native default `fork_turns: none`.
`backend_options.codex_subagent.fork_turns` (`none`, `all`, or a positive
integer string) belongs in a native-only/custom flow role. Do not add dormant
native options to a role that currently resolves to another backend; Agent
Control rejects backend-specific options that cannot be applied.
