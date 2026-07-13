---
name: flow-runner
description: Use when the user or another workflow asks to execute, resume, inspect, or debug a declarative Agent Control flow config with structured step reports and artifact-based transitions.
---

# Flow Runner

Use this skill to run a declared workflow from a flow config. The flow config is
the source of truth for steps, roles, artifacts, structured reports, and
transitions. The coordinator applies the config; it does not invent hidden
workflow state.

When debugging flow semantics, prefer the Agent Control flow patterns reference
at `docs/flow-patterns.md` if that repository path is available. It explains
the intended meaning of transitions, notifications,
subscriptions, artifacts, and visual relationships.

## Inputs

Expect one of:

- a flow name or flow id from the Agent Control flow catalog;
- a path to a flow config file;
- an inline flow config object;
- an existing `flow_instance_id` to inspect or resume.

Agent Control accepts JSON and YAML config files. Prefer passing file paths
directly to `agentctl flow validate --config-file` or `agentctl flow start
--config-file` so Agent Control can parse YAML/JSON and expand environment
placeholders consistently.

## Runtime

Use Agent Control MCP tools when available:

- `flow_catalog_list`
- `flow_catalog_get`
- `flow_validate_config`
- `flow_start`
- `flow_get`
- `flow_continue`
- `flow_dispatch_active`
- `flow_step_start`
- `flow_step_report`
- `subscription_create`
- `event_list`

Use `agentctl flow ...` only when MCP tools are unavailable or for manual/debug
smoke checks. If `flow_continue` is not present in the loaded MCP tools, use
`agentctl flow continue` immediately without discovery commands; do not fall
back to manual `agent_register` + `agent_start` for normal flow execution.

Do not run preflight checks before invoking the operation that this skill or an
Agent Control notification tells you to use. Trust the declared operation and
call it directly; if that call fails, handle the returned error or use the
documented fallback. Avoid spending a coordinator turn checking whether a tool,
flow, prompt file, or backend exists before the operation that already performs
that validation.

## Flow Discovery

When the user asks for a named flow, a default flow, or a flow without a config
path, resolve it through Agent Control before launching:

1. Use `flow_catalog_list` to inspect available catalog flows. The default
   catalogs are Agent Control's bundled `flows/` directory and the user flow
   catalog at `${AGENT_CONTROL_USER_DIR:-$HOME/.agent-control}/flows`.
2. Use `flow_catalog_get` with the selected flow id or directory name.
3. Launch with the returned `config_path`, or use the returned `config` when
   you must call MCP-only `flow_start`.

For CLI fallback, use:

```bash
agentctl flow catalog list
agentctl flow catalog get --flow "$FLOW_ID"
```

Do not manually search the repository for flow files before using the catalog.
If the catalog cannot resolve the requested flow, stop and report the available
flow ids from `flow_catalog_list`.

User-added flows should normally live under the user catalog. Override the user
catalog with `AGENT_CONTROL_USER_FLOW_CATALOG_DIR`, or set
`AGENT_CONTROL_USER_DIR` to move the whole user Agent Control home.

## Preferred One-Shot Launch

When the user provides or selects a flow config path and a run objective for a
new flow, prefer the deterministic one-shot CLI path:

```bash
agentctl flow launch \
  --config-file "$FLOW_CONFIG" \
  --title "$RUN_OBJECTIVE" \
  --repo-dir "$PWD" \
  --server "${AGENT_CONTROL_OPENCODE_SERVER:-http://localhost:53910}"
```

This command authenticates/registers the local coordinator, starts or reuses the
flow instance, subscribes the coordinator only to configured flow notifications
and blockers, asks Agent Control to continue the flow, dispatches the currently
active worker when one is ready, and returns immediately. The response is a
compact control contract: read `next`, `run_id`, `flow_instance_id`,
`active_step`, `worker_agent_id`, `expected_artifacts`, `blocked_reason`, and
`ui_url`.

Treat `next: "worker_dispatched_end_turn_until_agent_control_wakeup"` and
`next: "worker_already_running_end_turn_until_agent_control_wakeup"` as hard
turn boundaries: show the `run_id`, `worker_agent_id` when returned,
`expected_artifacts`, and `ui_url`, then end the coordinator turn. Treat
`next: "orchestrator_action_required"` as a compact decision request, and
`next: "flow_blocked"` as an intervention point.

Do not open or connect the Codex Browser after `agentctl flow launch` dispatches
a worker. Fast workers can finish while the coordinator is still doing Browser
setup, causing the wakeup to arrive before the coordinator has truly ended its
turn. Do not start, health-check, or open the web console from the visible
coordinator before launch either; `agentctl flow launch` does not need UI
preflight. Let the caller/supervising thread keep the console visible. After
launch, only print the returned URL and end the turn.

When run from a visible Codex coordinator, `agentctl flow launch` automatically
attaches that coordinator to the current Codex thread through `CODEX_THREAD_ID`
when the environment provides it. Do not pass the thread id in the user prompt
or manually rewrite the orchestrator backend handle unless the user explicitly
asks for a non-Codex coordinator backend.

Do not inspect the full flow config, prompt files, implementation files, CLI
help, or backend logs before using this path. Agent Control owns config
validation, prompt composition, worker registration, subscription creation, and
detached supervision. If `agentctl flow launch` is unavailable or fails because
the installed Agent Control version is too old, fall back to the explicit
`auth login` + `flow start --compact` + `flow continue` sequence below;
do not replace it with manual polling or hand-written worker prompts.

After launch, report the selected run URL compactly, for example
the returned `ui_url`. Never run `agentctl web start`, health probes, Browser
setup, or foreground server work from a visible coordinator turn.

The console is observation-only for the runner. Do not use the web UI as the
source of truth for flow state; use Agent Control flow/agent tools.

## Agent Control CLI Resolution

When using the local CLI, call `agentctl` directly first. Do not spend a
preflight step on `command -v`, `--help`, filesystem inspection, or version
checks before the flow operation. If the direct command fails because
`agentctl` is not found, retry the same operation with these paths in order:

1. if the current checkout contains
   `mcp/agent-control/bin/agentctl`, use that path.
2. otherwise, use the installed plugin cache path:
   `$HOME/.codex/plugins/cache/agent-control/0.1.0/mcp/agent-control/bin/agentctl`.

If none of those paths exists, stop and report that Agent Control CLI is
unavailable. Do not inspect implementation files or hand-roll equivalent
commands as a substitute for `agentctl`.

## Turn Boundary Contract

For a visible Codex coordinator, a normal flow turn is intentionally short:

1. prepare the flow state needed for the next action;
2. register/authenticate the coordinator if needed;
3. start or resume the flow;
4. call `flow_continue` once so Agent Control dispatches the active worker or
   stops at a configured notification/blocker;
5. end the coordinator turn.

After a worker dispatch succeeds, do not call
`agent_wait`, `subscription_wait`, `goal_wait_confirm`, `agentctl agent wait`,
`agentctl sub wait`, or shell polling loops. Do not read worker logs, full
transcripts, or flow artifacts while waiting. Normal transitions happen when
workers report through Agent Control; the next coordinator action must happen
only after Agent Control delivers a configured flow notification, blocker, or
explicit user follow-up.

The coordinator's final message for such a turn should be compact: flow/run id,
worker id, watcher/subscription id when available, and the fact that the turn is
ending until Agent Control wakes it again.

## Prompt Resolution

Flow configs may define top-level `prompts`, role `prompt_ref`/`prompt_path`,
and step `prompt_ref`/`prompt_path`. Prompt paths must reference Markdown files.
When the config was loaded from a file, resolve relative prompt paths from the
flow config file's directory. When the config was supplied inline, resolve
relative prompt paths from the current working directory unless the caller gives
a different base directory.

Flow config string values may contain environment placeholders. Agent Control
resolves these before validation:

- `${VAR}` requires `VAR`.
- `${VAR-default}` uses `default` only when `VAR` is unset.
- `${VAR:-default}` uses `default` when `VAR` is unset or empty.

Do not source `.env` files inside the runner. The caller is responsible for the
process environment used by Agent Control.

When a step is active, Agent Control exposes ordered `prompt_sources`, a
generated `runtime_contract`, and a generated `reporting_contract` in the step
`input_json` and `flow.step_started` event. Compose worker instructions in this
order:

1. role prompt source;
2. step prompt source;
3. `runtime_contract.markdown`;
4. `reporting_contract.markdown`;
5. backend constraints.

Do not paste prompt file contents into the flow config. Read only the prompt
files needed for the active step.

Do not rely on workers knowing this skill. The generated runtime contract is the
worker's operational source of truth for the active run title/objective,
repository directory, input artifact paths, output artifact paths, and artifact
rules. The generated reporting contract is the worker's operational source of
truth for the exact MCP tool name, CLI fallback command, `step_instance_id`,
result schema, allowed routing values, report artifact payload, and examples.

## Execution Model

1. Validate the flow config before starting.
2. For the initial launch, authenticate the coordinator with
   `orchestrator_login`/`agentctl auth login`, or prefer the one-shot
   `agentctl flow launch` command when available. This creates or attaches the
   Agent Control run, registers or reuses the coordinator/orchestrator agent,
   and returns the `agent_token` for that launch turn.
   - Prefer `agentctl auth login` for local Codex coordinators. It may use the
     controller's local stored admin key without printing it.
   - Do not print admin keys, agent tokens, or raw auth files in chat or logs.
3. Use the returned `agent_token` only for the current launch turn's flow,
   agent, subscription, and link operations. Do not perform another login on
   later Agent Control wakeups just to obtain a token. Wakeup messages identify
   the subscriber/orchestrator agent for the run.
4. Start the flow with `flow_start`. For CLI usage, prefer
   `agentctl flow start --compact` so the coordinator receives only ids and the
   active step summary instead of a full config/contract snapshot.
   - If this turn was triggered by an Agent Control notification for an
     existing flow, do not start a new flow and do not log in again. Use the
     `flow_instance_id` and subscriber/orchestrator agent id from the
     notification.
   - When `agentctl flow start --compact` returns `reused: true`, treat it as a
     resume of the existing flow instance, not a new flow.
5. Do not register a second coordinator agent after login. If an existing-flow
   notification requires more work, call `flow_continue` directly with the
   notification's `flow_instance_id` unless the notification explicitly asks
   for a manual route decision. Only use `flow_get` after `flow_continue`
   reports no active step, a blocker, or an already assigned/running step that
   needs human diagnosis.
6. For each ready active step, let Agent Control `flow_continue` (or
   `agentctl flow continue`) dispatch exactly that step. This operation composes
   worker prompts from the flow's prompt sources and generated contracts,
   registers/reuses the worker, starts the worker, and returns immediately.
7. Do not manually compose worker prompts, create per-run prompt files, register
   step workers, start backend workers, or create terminal-event subscriptions
   when `flow_continue` is available.
8. When the worker reports with `flow_step_report`, Agent Control validates the
   result schema, checks required artifacts, records bindings, selects the next
   transition, and auto-continues by default. This means a normal worker report
   can launch the next worker without waking the coordinator.
9. If Agent Control enters a `notify` state, the coordinator decides the next
   step and activates it with `flow_step_start`, or gives the requested compact
   user feedback.
10. If Agent Control returns `blocked`, notify the orchestrator/user with a short
    reason and wait for correction instructions.
11. Stop when the flow instance reaches `completed`, `blocked`, or `cancelled`.

If a deterministic end-to-end flow runner command is unavailable, do not emulate
one by keeping the coordinator model turn open and manually polling every worker.
Use only `flow_continue` for the next deterministic action, then end the turn.
If that is not enough to continue safely, stop and report the missing runner
capability instead of hand-rolling a foreground loop.

For external detached backends such as OpenCode server, Agent Control should
launch the worker in detached mode and then the coordinator should end its
current turn. Do not keep a model turn open just to poll, read logs, or watch
the worker. Foreground/debug wait modes are opt-in only and are forbidden for
normal visible Codex coordinator flow execution because they keep the
coordinator turn open.

The coordinator must not implement a flow step, write step artifacts, or
generate semantic step reports. Its job is to launch/resume the flow, react to
configured notifications and blockers, and ask for human/orchestrator decisions
when the flow configuration asks for them.

Do not use visual links as workflow state. Links can explain relationships, but
step state, reports, artifacts, and transitions live in the flow instance.

## Worker Contract

Workers should write their assigned artifacts and then use the generated
`reporting_contract` from the active step payload. A typical MCP report shape is:

```json
{
  "step_instance_id": "...",
  "status": "completed",
  "result": {},
  "artifacts": {
    "artifact_key_or_output_name": "/absolute/path/to/artifact.md"
  },
  "summary": "Compact step result."
}
```

The `result` fields are generic and are generated from the loaded flow config.
Do not assume meanings such as `approved`, `needs_changes`, `s`, `m`, `l`, or
`xl` unless they appear in the active step reporting contract.

If a worker cannot use MCP/tooling reliably, ask it to produce the artifact and
compact report text, then the coordinator may submit `flow_step_report` on its
behalf only from that explicit worker output. The coordinator may not inspect an
artifact, infer a result, and submit a step report as if the worker had reported
it. If the worker reaches a terminal status without reporting, Agent Control
marks the step blocked so the coordinator/user can decide what to do. Do not
start fresh duplicate workers for the same active step as a retry loop unless
the flow config explicitly defines that retry strategy.

## Done

The flow instance has a terminal status, required artifacts are bound in Agent
Control, and the user receives a compact summary of the selected transitions,
blocked step, or completion result.
