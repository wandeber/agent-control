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

## Live Source Preview

To show, create, or edit a flow with the user watching, open the native panel
with `open_agent_control_console({screen: "flows", flow_id: "<id>", repo_dir: "<absolute task project>"})`.
When the panel is already open, use `reuse_agent_control_console` with the same
selection fields. Preview does not need a run and must not launch workers.

The Flows screen lists bundled, user, and project catalogs and shows effective
models/reasoning, role prompts, phase instructions, artifacts, and routes. It
refreshes directly from source files while visible; no model polling, event
subscription, or wait loop is needed for authoring. A new local package under
`.agents/flows/<id>/flow.yaml` appears automatically. Select its ID before
creation when useful. Edit the real YAML/JSON and Markdown prompt files through
Codex, then validate the finished definition. During an incomplete save the UI
keeps the last valid preview and recovers on the next valid save.

Project model overrides still use `.agents/models.toml` and deterministic
catalog resolution. Editing sources changes the preview and future launches;
it never replaces an already running flow's pinned config or prompts. Do not
modify an installed plugin cache to create a project flow.

## Authoring Rules

- Establish desired behavior, scope, acceptance, and material tradeoffs before
  encoding them as routes. Use [User Questions](../flow-runner/references/user-questions.md)
  for unresolved user choices, through a native question UI available in the
  current mode or text fallback. Preserve prior answers; a worker must route
  missing user decisions to the original conversation rather than choose for it.
- Software-development flows default to clean pre-production implementation,
  without hypothetical legacy compatibility or data conversion work. Plans
  may assume old development data can be recreated when simpler; existing
  records alone do not require conversion. Keep normal ORM/schema migrations.
  If valued data or production evidence leaves preservation unresolved, route
  the loss-versus-conversion choice to the original user. Explicit
  user requirements and authoritative evidence of production clients, retained
  data, or public contracts take precedence. Carry that boundary, evidence, and
  exceptions in acceptance, phase prompts, and isolated package projections;
  route material uncertainty to the user before the plan. A fresh-data design
  does not authorize executing a destructive database reset/delete. Preserve
  migration history, necessary schema tooling, and actual external contracts.
  Keep this policy conditional for non-software flows.
- Keep Agent Control generic: do not bake one workflow's result labels into the
  runtime contract.
- Model real documents as named artifacts referenced from step `inputs` and
  `outputs`. Keep semantic reports, ledgers, decisions, and check receipts as
  runtime records; do not create Markdown files only to transport structured data.
- Model reusable prompts as named resources under top-level `prompts`, then
  reference them from roles or steps with `prompt_ref`.
- Use literal role `model` and `reasoning_effort` defaults. Project overrides
  belong in `.agents/models.toml`; model fields reject environment interpolation.
  Backend/connection environment placeholders remain supported.
- Prefer Markdown prompt files for stable instructions:
  - role prompts define stable worker behavior;
  - step prompts define the current phase/action;
  - runtime payloads carry user objective, repo, artifact paths, and
    backend-specific details.
- Prompt file paths must end in `.md`. If the config is stored in a file, make
  relative prompt paths resolvable from the flow config file's directory.
- Use structured `report.schema` fields only for routing decisions that the
  flow actually needs.
- Use `execution: coordinator` with `decision: { key, authority, owner, artifact_key? }` for
  explicit human/coordinator gates. These steps notify without dispatching a
  worker. Use `authority: user` for human decisions and `authority: coordinator` for
  coordinator judgment. Use `owner: requester` when the original conversation
  owns the decision and `owner: orchestrator` when the executor owns it. Bind content approvals to their artifact revision. A plain `notify`
  remains useful for a blocker or ambiguous route.
- Use `to: "<step-id>"` only for deterministic transitions that the config can
  express safely.
- Use `finish: true` only with the required current evidence and earlier gates.
  Under `policy: { strict: true }`, define `requires`, `requires_evidence`, and
  transition `set` milestones explicitly. Conditions may read durable `state`,
  current `decisions`, and verified `evidence`; worker result fields alone must
  not certify human approval, reviewer identity, or mechanical execution.
- Avoid `waits_for` as workflow state. A step depends on artifacts or on a
  transition, not on a visual wait edge.
- Do not duplicate runtime details in prompt files. Active steps receive
  generated runtime and reporting contracts from Agent Control.
- Put project-authored flow packages under `.agents/flows/<flow-id>/flow.yaml`.
  Local IDs replace matching installed IDs; prompts resolve relative to the local package.
- Put shared user-authored flow packages under the user flow catalog unless the user
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
    model: gpt-5.6-luna
    reasoning_effort: max
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
- Conditions on worker result fields have corresponding `report.schema` fields;
  runtime state and package conditions use their defined contracts.
- The config can represent orchestrator-driven flows by using `notify` actions.
- The config can represent automatic flows by using `transitions` and `to`.
- Material user questions have a configured handback route and reach the
  original conversation's available question interface. Isolated workers receive
  the accepted constraints and cannot approve an unresolved choice themselves.
- Repo-authored flow files validate with `agentctl flow validate --config-file
  <flow.yaml>`, including prompt file existence relative to that config file.
- The canonical schema is available with `agentctl flow schema`.

When Agent Control is available, validate the finished config with
`flow_validate_config` or `agentctl flow validate` before handing it back.

## Efficient Phase Contracts

Define each logical phase's authority, inputs, result, evidence, owner, skip
condition, and correction destinations. A logical phase does not require a new
agent: reuse Context/Analysis owners, make Integration conditional, and let
controlled tools perform mechanical work. Keep no-edit validation separate from
implementation and semantic review. Do not add an independent reviewer merely
to duplicate an existing expert gate.

Record acceptance as durable revisioned context and carry every correction's
source report and concrete outstanding findings. Preserve approved material
while invalidating what changed or depends on the change. Reuse a historical
milestone only for its declared meaning; a previous planner approval cannot
certify a later result's identity.

Use the runtime's evidence provider for immutable snapshots, incremental scope,
semantic draft composition, plan projections, command receipts, and verified
closure. Reference receipts through `requires_evidence`; do not invent a
trusted `evidence_valid` result flag or duplicate the provider in prompt code.
A flow needing strict authored review must retain the exact owner or block for
explicit recovery; review-only prose must not be described as a technical sandbox.

Pin effective config and prompts for a run. Continued owners receive changes
and relevant references, with a full refresh only when continuity is uncertain.
Describe optional user testing and single-review preferences explicitly. Normal
correction loops collect findings in batches; repeated underlying problems
without progress return to a concrete user decision, never timeout approval.

## Declaring Managed Work Packages

Use `policy.work_packages` to bind the package lifecycle to a flow's existing
approval decision, manifest step, execution step, and integration step. Define
required package IDs, configured `codex-thread` roles, disjoint literal paths,
deliverables, dependencies,
and provisioned Codex worktrees through the runtime package contract before the
same exact-plan decision. An empty manifest represents inline execution.

Require `packages.joined` on the integration entry and `packages.integrated` on
subsequent gates, including manual entry, so no route can bypass the group.
Route using runtime `packages.integration_required` and retain the automatic
join/integration guards for the declared phases. Set `success_condition` to the
flow's successful completion result so blockers and corrections can return to
the responsible phase without claiming a verified join. Do not substitute a worker
boolean or terminal child status for those guards. The package group is a
bounded parallel execution unit inside a phase, not an arbitrary multi-active
flow graph. Preserve declaration/review, worktree provisioning, execution,
delivery acceptance, and consolidation as distinct responsibilities without
creating unnecessary model turns or new human gates.
