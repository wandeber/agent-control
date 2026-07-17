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

## Native Codex Subagent v2 Bridge

When an active role uses the `codex-subagent` backend, Agent Control persists
the flow state and emits a logical orchestrator action, while the visible root
coordinator performs the corresponding Codex collaboration call. Do not ask an
MCP server, shell command, nested worker, or browser to impersonate these native
tools.

Only the root coordinator may claim and execute bridge actions. A worker may
edit its assigned files, run scoped checks, and report its result; it must not
spawn, message, resume, interrupt, wait for, or synchronize sibling workers.
Map each claimed logical operation to the same exact native tool:

- `spawn_agent` -> `spawn_agent({ task_name, message, fork_turns })`
- `send_message` -> `send_message({ target, message })` while the target is running
- `followup_task` -> `followup_task({ target, message })` to trigger the next turn
  of an idle target
- `interrupt_agent` -> `interrupt_agent({ target })`

The preferred CLI bridge keeps both credential stages out of stdout:

1. `agentctl flow launch` persists the scoped bridge credential in Agent
   Control's private local credential store and returns only
   `bridge_grant.bridge_grant_id` plus the safe `orchestrator_action` reference.
2. Claim that action with
   `agentctl action claim --action <action-id> --bridge-grant <grant-id>`.
   The command persists the one-time action token privately and returns only
   `action_claim` metadata plus the native request envelope.
3. Execute the one exact native tool named by that envelope. A successful
   `spawn_agent` ACK must persist the native identity with this safe CLI form:

   ```bash
   agentctl action ack \
     --action <action-id> \
     --status succeeded \
     --result-json '{"native_agent_id":"<returned-agent-id>","native_task_name":"<request-task-name>","native_task_path":"<request-task-path>"}'
   ```

   Set `native_agent_id` to the id returned by `spawn_agent`. Copy
   `native_task_name` and the canonical `native_task_path` from the claimed
   request/native result exactly; never infer or shorten them. The ACK command
   resolves the stored action token locally.
4. For successful `send_message`, `followup_task`, or `interrupt_agent`
   operations, ACK with `--status succeeded`; include `--result-json` only when
   the native tool returned useful non-secret structured state. If any native
   operation fails, ACK it with `--status failed --error-json <safe-json>` using
   a compact error that contains no task message, request payload, token, or
   credential reference.
5. If claim returns `status: "already_claimed"`, do not execute the native
   action again. Respect `retry_after_ms` and recover/synchronize as described
   below rather than guessing whether the first call succeeded.

Pass `--bridge-grant <grant-id>` to later CLI `flow continue`,
`flow dispatch-active`, `action claim`, and `agent external-sync` operations.
If the public reference is unavailable on a wakeup, let Agent Control perform
its deterministic flow/action/agent plus `CODEX_THREAD_ID` lookup. A missing,
revoked, expired, unsafe, or ambiguous credential is a blocker: report it and
wait for intervention. Never fall back to a new login, broader admin/agent
credential, or a newly created bridge grant.

The direct MCP path has the same two-stage semantics but may return secrets in
private structured tool results when they are required by the next MCP call:

1. Call `orchestrator_action_claim({ action_id, bridge_token })`.
2. Execute the returned native request, then call
   `orchestrator_action_ack({ action_id, action_token, status, result?, error? })`.
   A successful MCP `spawn_agent` ACK uses the same `native_agent_id`,
   `native_task_name`, and `native_task_path` result object required by the CLI
   path above.

Inspect the result of every ACK before applying the normal turn boundary. A
claimed spawn can race with flow shutdown, in which case its ACK returns a safe
follow-up `orchestrator_action` for `interrupt_agent`. When an ACK explicitly
contains a follow-up action:

1. Claim that exact returned action with the same bridge grant/credential.
2. Execute only the native operation named by its claimed request.
3. ACK it using the same CLI or direct MCP path described above.
4. Repeat only when that ACK itself explicitly returns another follow-up
   `orchestrator_action`.

Do not infer a follow-up, search for unrelated pending actions, or call
`flow_continue` to discover one. When the ACK result contains no follow-up
action, the chain is complete.

The raw `--action-token` CLI flag is an advanced-only escape hatch; bridge
tokens stay in the local credential store on the CLI path. No normal CLI output
prints either value. Never copy a token, bridge grant reference, or action claim
reference into chat, controller events, UI state, logs, artifacts, worker
prompts, or summaries. Keep the private request envelope out of those public
surfaces too; pass only its declared arguments to the one exact native
collaboration tool. A spawned worker receives its intended task message, never
bridge/action control data.

The preferred one-shot launch remains valid for native roles. Retain the
public `bridge_grant_id` only as private coordinator control state and inspect
the public `orchestrator_action` reference. When `next` is
`native_subagent_action_required`, claim, execute, and acknowledge that action
in the same root turn. After a successful `spawn_agent` ACK and every explicitly
returned follow-up action have been acknowledged, end the turn as soon as the
latest ACK contains no further action. A normal spawn ACK therefore still ends
the turn immediately. Do not call `flow_continue` as a polling substitute.

For spawn recovery, call
`list_agents({ path_prefix: expected_task_path })` first. Reuse an exact native
task/path match and synchronize it on the CLI path with:

```bash
agentctl agent external-sync \
  --agent <agent-id> \
  --bridge-grant <grant-id> \
  ...
```

On the direct MCP path, use
`agent_external_sync({ agent_id, bridge_token, native_agent_id?, native_task_name?, native_task_path?, native_status, latest_message?, observed_at?, confirmed_absent? })`
instead. Spawn only when no exact match exists. Use the same `list_agents` then
external-sync sequence after an ambiguous delivery, restart, or stale
controller state; do not create duplicate workers as recovery.

`wait_agent` is forbidden during normal flow execution. It may be used only
for an explicit foreground smoke test, with a single wide timeout rather than
short polling. Normal coordinators end their turn after dispatch and resume
only from Agent Control wakeups or user input.

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
`ui_url`. A native CLI launch can also return a safe `orchestrator_action`
reference plus a public `bridge_grant` reference; the scoped credential itself
is persisted privately and never appears in CLI output.

Treat `next: "worker_dispatched_end_turn_until_agent_control_wakeup"` and
`next: "worker_already_running_end_turn_until_agent_control_wakeup"` as hard
turn boundaries: show the `run_id`, `worker_agent_id` when returned,
`expected_artifacts`, and `ui_url`, then end the coordinator turn. Treat
`next: "orchestrator_action_required"` as a compact decision request, and
`next: "flow_blocked"` as an intervention point.

Treat `next: "native_subagent_action_required"` as a root bridge action, not a
human routing decision: claim the referenced action, execute the exact native
tool, acknowledge it, process only the follow-up actions explicitly returned by
ACKs, and then end the turn. This is still part of the single one-shot launch
path; do not replace it with an MCP-only or manual worker-registration detour.

Do not call `open_agent_control_console` from this generic runner during a
resume or wakeup. A caller such as `development-flow` may require one native
open immediately before its first launch; once that gate succeeds, the runner
never reopens the panel.

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
   `$HOME/.codex/plugins/cache/agent-control/agent-control/0.1.0/mcp/agent-control/bin/agentctl`.

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
`input_json` and `flow.step_started` event. A manually activated step can also
contain `coordinator_context`; in that case, `runtime_contract.objective`
combines the base run title with that latest context and makes the coordinator
context authoritative wherever the two differ. Compose worker instructions in
this order:

1. role prompt source;
2. step prompt source;
3. `runtime_contract.markdown`;
4. `reporting_contract.markdown`;
5. backend constraints.

Do not paste prompt file contents into the flow config. Read only the prompt
files needed for the active step.

Do not rely on workers knowing this skill. The generated runtime contract is the
worker's operational source of truth for the effective objective,
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
   user feedback. When manually returning work or passing newly clarified user
   intent, put the complete correction or updated intent in `reason`; Agent
   Control delivers that value to the target worker as coordinator context.
   Do not use an opaque routing label when the worker needs the decision itself.
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
