---
name: flow-configurator
description: Configure or inspect project-local model and reasoning overrides for Agent Control flows without editing their instructions or base flow definitions.
---

# Flow Configurator

Use the deterministic runtime helper, relative to this skill directory:

```bash
node "$SKILL_DIR/scripts/flow-model-configurator.mjs" list --project /absolute/project --flow development-flow-v1
node "$SKILL_DIR/scripts/flow-model-configurator.mjs" set --project /absolute/project --flow development-flow-v1 --set planner.model=gpt-5.6-sol --set planner.reasoning_effort=xhigh
```

The helper uses the same catalog and TOML resolver as launches. It writes only model
and reasoning preferences into `.agents/models.toml`, preserving other tables.
Do not duplicate defaults or instructions. Ask only for missing desired choices.
Follow [User Questions](../flow-runner/references/user-questions.md) for those
choices: use a native question interface available in the current mode, with
text fallback. Present the effective options and preserve answers already given;
do not silently choose a different model or treat an empty result as a selection.
The project is the task's explicit repository directory, not the MCP process cwd.
Git subdirectories resolve to the repository root; non-git projects use the nearest
ancestor `.agents` directory, or the provided directory.

```toml
[flows.development-flow-v1.planner]
model = "gpt-5.6-sol"
reasoning_effort = "xhigh"
```

Resolution loads existing catalogs, replaces matching IDs with project packages
under `.agents/flows/<name>/flow.yaml`, then applies model overrides. Local prompt
paths resolve relative to their flow. Effective configuration is pinned at launch;
edits affect future runs, not running workers. Unknown roles, fields, invalid effort,
and environment interpolation in model fields fail explicitly.

## Configuration Procedure

1. Resolve the task's project directory and requested flow. Use `list` to obtain
   the effective models and role identifiers, including project-defined flows.
2. If model or reasoning choices are missing, present those effective settings
   and ask only for the desired changes. Do not infer model choices.
3. Apply the explicitly requested role fields with `set`. Omitted fields retain
   their current values. Preserve HDT tables and unrelated project preferences.
4. Report the effective role settings returned by the helper and the project
   TOML path. The helper validates against the same resolver used by launches.

Model configuration uses `.agents/models.toml` exclusively. Do not read, import,
rewrite or clean up `.env` or `.agents.env` to configure models. Environment
variables are not model/reasoning overrides. Backend and connection/authentication
settings remain separate from this skill's model configuration procedure.
