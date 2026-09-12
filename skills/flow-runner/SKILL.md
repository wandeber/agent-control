---
name: flow-runner
description: Execute or resume an authorized Agent Control flow, or inspect and diagnose it without starting work. Preserve declared steps, evidence gates, owner continuity, and event supervision.
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

## Intent And Loading

Establish the requested operation from the user and existing authorization.
Selecting this skill does not authorize launching or changing a flow.

- **Inspect, audit, explain, or diagnose:** read the supplied config, relevant
  prompts, catalog entry, or existing `flow_get` snapshot. Report findings and
  proposed corrections. Do not launch, resume, route, edit, install, or repair
  configuration merely to inspect it. A missing capability is a finding.
- **Execute or resume:** perform the authorized operation and supervise it to
  its requested completion. Use the launch and turn contracts below. Follow
  existing decisions; ask only for a missing decision that blocks that work.
- **Change a flow:** inspect the current package and apply only the requested
  edits through `flow-author`; validation does not imply permission to run it.

Read relevant contracts once and reuse them while retained. After context loss,
reload the applicable operation and current durable state rather than every
reference. User instructions and existing authorization take precedence over
skill guidelines; preserve actual host restrictions and configured flow gates.

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
- `flow_launch` (preferred initial launch)
- `flow_start` (lower-level start)
- `flow_get`
- `flow_continue`
- `flow_dispatch_active`
- `flow_step_start`
- `flow_step_report`
- `subscription_create`
- `run_observe`
- `run_wait`
- `run_ack`
- `flow_decision`
- `flow_context_update`
- `flow_evidence`
- `flow_packages`
- `event_list`

Use `agentctl flow ...` only when MCP tools are unavailable or for manual/debug
smoke checks. If `flow_continue` is not present in the loaded MCP tools, use
`agentctl flow continue` immediately without discovery commands; do not fall
back to manual `agent_register` + `agent_start` for normal flow execution.

For an authorized first launch, satisfy the
[right-side panel gate](references/side-panel.md) before dispatch. Once the
matching panel exists, ordinary launches and resumes avoid redundant preflight
checks. Call the declared operation directly; if that call fails, handle the returned error or use the
documented fallback. Avoid spending a coordinator turn checking whether a tool,
flow, prompt file, or backend exists before the operation that already performs
that validation.

## Conditional Native Bridge

Load [codex-subagent-bridge.md](references/codex-subagent-bridge.md) only when
an active role uses `codex-subagent` or the runtime returns a native orchestrator
action. Retain that contract while it remains in context. Ordinary
`codex-thread` execution does not need the native bridge procedure.

## Flow Discovery

When the user asks for a named flow, a default flow, or a flow without a config
path, resolve it through Agent Control before launching:

1. For a known flow id or directory name, call `flow_catalog_get` directly.
2. Use `flow_catalog_list` only to choose a flow or resolve a missing/ambiguous
   id. The default catalogs are bundled `flows/` and
   `${AGENT_CONTROL_USER_DIR:-$HOME/.agent-control}/flows`.
3. For execution, first satisfy or reuse the
   [right-side panel gate](references/side-panel.md), then call `flow_launch`
   with the selected `flow_id` and objective,
   or pass its `config_path` to `agentctl flow launch`. For inspection, read the
   returned package and finish the requested analysis without launching.

For CLI fallback, use:

```bash
agentctl flow catalog get --flow "$FLOW_ID"
# List only when the requested id is unknown or could not be resolved.
agentctl flow catalog list
```

Do not manually search the repository for flow files before using the catalog.
If the catalog cannot resolve the requested flow, stop and report the available
flow ids from `flow_catalog_list`.

User-added flows should normally live under the user catalog. Override the user
catalog with `AGENT_CONTROL_USER_FLOW_CATALOG_DIR`, or set
`AGENT_CONTROL_USER_DIR` to move the whole user Agent Control home.

## Preferred One-Shot Launch

For a new flow, prefer one MCP `flow_launch` call with `title`, `repo_dir`, and
exactly one of `flow_id` or `config`. The tool validates the flow, resolves local
authorization, registers the executing coordinator and original conversation,
subscribes the conversation to all supported run events before dispatch, and
starts detached supervision. Do not precede it with login, agent registration,
`run_observe`, socket probes, or manual subscriptions. It returns `run_id`,
`flow_instance_id`, `observer`, `start`, `continuation`, and `watch`.

When MCP tools are unavailable, the caller supplies a config file, or the native
CLI bridge requires private local credential storage, use the equivalent CLI
operation:

```bash
agentctl flow launch \
  --config-file "$FLOW_CONFIG" \
  --title "$RUN_OBJECTIVE" \
  --repo-dir "$PWD"
```

This command authenticates/registers the local coordinator, starts or reuses the
flow instance, attaches the initiating conversational thread as a run observer
before dispatch, subscribes to all supported run events unless explicitly filtered,
asks Agent Control to continue the flow, dispatches the currently
active worker when one is ready, and returns immediately. The response is a
compact control contract: read `next`, `run_id`, `flow_instance_id`,
`active_step`, `worker_agent_id`, `expected_artifacts`, `blocked_reason`, and
`ui_url`, and `observer`. Retain the observer id and durable cursor for event
consumption. A native CLI launch can also return a safe `orchestrator_action`
reference plus a public `bridge_grant` reference; the scoped credential itself
is persisted privately and never appears in CLI output.

Treat `next: "worker_dispatched_wait_for_run_events"`,
`next: "worker_already_running_wait_for_run_events"`, and
`next: "worker_start_in_progress_wait_for_run_events"` as instructions to keep
the turn open and call `run_wait`. The requester uses `observer.wait_contract`;
a separate executor uses `coordinator_observer.wait_contract`. Each resumes
with its own latest processed cursor. Older launch responses mentioning an ended
turn are obsolete; apply this keep-open policy while work remains. Treat
`next: "orchestrator_action_required"` as a compact decision request, and
`next: "flow_blocked"` as an intervention point.

Treat `next: "native_subagent_action_required"` as a root bridge action, not a
human routing decision: claim the referenced action, execute the exact native
tool, acknowledge it, process only the follow-up actions explicitly returned by
ACKs, and then enter the observer wait without finishing the turn. This is
still part of the single one-shot launch
path; do not replace it with an MCP-only or manual worker-registration detour.

Before the first dispatch, satisfy the [integrated panel gate](references/side-panel.md)
in the original user conversation, or reuse the caller's established MCP App
panel. Use `open_agent_control_console`, not a browser target. Verify host
placement before claiming it; report unsupported presentation before launch.

After dispatch, retain the launch response and event cursor and enter
`run_wait` in the same open turn. Resumes and wakeups reuse the panel without
repeating startup or health checks. If it is lost, repair only presentation;
do not relaunch workers or discard acknowledged events.

When run from a visible Codex coordinator, `agentctl flow launch` automatically
attaches that coordinator to the current Codex thread through `CODEX_THREAD_ID`
when the environment provides it. Do not pass the thread id in the user prompt
or manually rewrite the orchestrator backend handle unless the user explicitly
asks for a non-Codex coordinator backend.

The initiating conversational thread must also be identified in the run. When
a separate thread executes the launch, pass the original requester as
`--requester-thread-id "$REQUESTER_THREAD_ID"`. Preserve this identity in the
delegation metadata: the executor's `CODEX_THREAD_ID` remains its own identity,
while the original requester stays in control metadata across every delegation.
Use `requester_thread_id` with MCP or `--requester-thread-id` with the CLI only
when the executor cannot inherit it. Resolution prefers an explicit requester,
the persisted run/parent requester, the authenticated caller's run requester,
`AGENT_CONTROL_REQUESTER_THREAD_ID`, then `CODEX_THREAD_ID`. Never replace the
original with an intermediate worker's thread or put thread identity in task
text. A host without a Codex conversation must supply a real requester id to
attach one; Agent Control does not invent an observer identity. If both identities are the same, Agent Control reuses one agent.
An attached observer has no worker lifecycle or native execution grant.

For ordinary execution, do not reread the full config, prompts, implementation,
CLI help, or backend logs before this launch operation. Agent Control owns config
validation, prompt composition, worker registration, subscription creation, and
detached supervision. If the installed Agent Control version lacks the launch operation,
report the missing capability. Use the installation/update workflow only when
that change is already authorized. Do not
replace it with a manual login/register/observe sequence, polling, or
hand-written worker prompts.

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
   `$HOME/.codex/plugins/cache/agent-control/agent-control/<installed-version>/mcp/agent-control/bin/agentctl`.

If none of those paths exists, stop and report that Agent Control CLI is
unavailable. Do not inspect implementation files or hand-roll equivalent
commands as a substitute for `agentctl`.

## Turn Boundary Contract

When execution and the original conversation are in different Codex threads,
launch also registers and returns `coordinator_observer` for the executing
thread. `observer` remains the original user's observation. The executor uses
`coordinator_observer.wait_contract` when present; the original conversation
uses `observer.wait_contract`. Each keeps its own processed cursor. Do not use
a passive requester's event stream for the coordinator's native actions, or
replace one thread's cursor with the other's. Same-thread launches reuse one
observation and return `coordinator_observer: null`. Lower-level/manual starts
can attach the additional coordinator explicitly with `run_observe` under its
existing authorization; one-shot launches do not need that extra call.


A run has an executing coordinator and an initiating conversational observer;
they may be the same Codex thread. Register both identities before dispatch.
The one-shot launch does this automatically. Lower-level `flow_start` and
`agent_start` also ensure requester observation before execution. Reserve
`run_observe` for attaching an additional conversation, an older existing run,
or intentionally changing filters/delivery. Reattachment preserves the current
filters and does not duplicate the agent. Retain the last acknowledged cursor;
an idempotent launch response must not reset a cursor already being consumed.

For existing Codex sessions, use `worker_attach` with the verified `thread_id`
and optional `run_id`. Use `server` for the owning local or remote app-server.
It registers/subscribes the requester and returns current control capabilities.
Use `agent_send_message` to steer active work or continue the same idle session;
use `agent_stop` for explicit interruption. Independent local CLI messages can
be queued behind their active turn and resumed with the original profile. A
queued receipt is not delivery or completion: keep waiting for that reply.
Stopping cancels pending messages and interrupts the verified writer. Reattach with the owning endpoint
when disconnected. Never create a replacement session or second active writer.
Native work keeps native waits unless Agent Control was selected. Do not infer
independent CLI liveness from desktop `wait_threads`; use `run_wait`.

While any supervised Agent Control work is pending, keep the launching Codex
turn open. Do not send a final response or rely on a notification to reactivate
it. This applies to the conversational requester and to a separate Codex
coordinator that still has work or decisions to supervise. Tool return is a
boundary between operations, not the end of the model turn.

When the user sends another message, answer in commentary, even if it is about
an unrelated topic. Preserve the original work unless the user explicitly
cancels or pauses it. Then re-enter the returned `wait_contract`; do not finish
the turn after answering. Do not relay routine activity, inspect status repeatedly,
or create monitoring automations while workers are running.

Keep a record for every active run: its name, observer id, flow/worker ids,
last successfully processed cursor, and completion condition. Do not overwrite
that record when discussing something else or starting another run. Use
concurrent long waits when the host supports them; completion or closure of one
observation must not abandon the others. If the host interrupted a wait for user
input, resume from the last processed cursor and deduplicate any replayed event
ids. Never advance a cursor for a batch the conversation did not process.

Launch returns `observer.wait_contract`; event batches and timeouts return an
updated `wait_contract` with `tool: "run_wait"`, ready-to-use `arguments`, and
`turn_policy: "keep_open_while_work_pending"`. These are continuation guidance;
the launch tool itself stays non-blocking. Call the returned wait immediately:
registration and subscription alone do not keep a tool call pending. Reusable
contracts omit the cursor to recover durable acknowledged progress. `closed: true` returns no next
wait for that observation; check the remaining supervised runs before ending.

The default `wake_on: "control"` separates observable activity from events that
need this thread. The requester receives decisions it owns (including
`authority: coordinator` judgments, which do not automatically require asking
the user), unresolved intervention, and aggregate completion. A separate
executor also receives routing events and its native action references.
Subscriptions still retain all selected events for the UI and inspection.
Only use `wake_on: "all"` (`--wake-on all`) when the user requests individual
worker completions or event updates. Preserve that policy in the returned ACK
and next wait contracts.

`completion` is null while registered work remains. When present, inspect its
`outcome` (`completed`, `failed`, or `cancelled`): it covers every worker, flow,
and descendant run, including outstanding goals and native actions. One
`agent.completed` or `flow.completed` event is not whole-run completion.
An observation closing is not proof of success. Acknowledge a handled delivery
with its `ack_contract`; a timeout or cancelled wait does not acknowledge events.

The default delivery mode is `wait`. Use renewable one-hour MCP waits below the
effective client deadline. The bundled Codex server declares
`tool_timeout_sec: 3700`, leaving headroom for `timeout_ms: 3600000`:

```bash
agentctl run wait \
  --run "$RUN_ID" \
  --observer-agent-id "$OBSERVER_AGENT_ID" \
  --wake-on control \
  --timeout 1h
```

The MCP equivalent is `run_wait` with `timeout_ms: 3600000`. Indefinite waits
are limited to the CLI/internal runtime or a host whose support was explicitly
verified. A server-side timeout cannot override a shorter client deadline;
verify the effective client configuration when changing hosts. A shorter wide
wait, such as 30 minutes, is valid only when it fits that verified deadline.
Process each returned batch, acknowledge it explicitly, and renew the long wait
after a timeout. A timeout does not imply completion.
If the host interrupts or caps a tool call, resume from the last acknowledged
cursor rather than polling worker status or replaying earlier events. Stop that
observation on user cancellation, `closed`, or its selected completion condition;
continue supervising any remaining runs before considering a final response.

Default observation covers every supported event type for the entire run,
including workers registered later. Narrow filters only when explicitly requested. Select specific events with repeated
`--requester-event` options on launch or `--event` on `agentctl run observe`.
For quiet supervision, keep the default full subscription and `wake_on: "control"`.
Filtering only `flow.completed` would miss requester decisions. Independent
worker terminal events do not mean the entire run has completed.

The observer may inspect Agent Control run/flow state and compact agent
summaries when answering a user question or resolving an actionable event.
Otherwise stay in the pending wait. It must
not claim a native action from an informational notification. If the same
thread is already the authorized coordinator, it acts under that existing
role; attaching observation does not create a second owner or grant.

Explicit `--requester-delivery notify` appends an informational injection without
starting a competing turn. Transport acceptance does not prove that an idle
thread resumed or processed the event. Selecting `notify` does not permit
ending a turn with pending work; keep `run_wait` as the reliable event route. If injection is unavailable or fails,
the event remains available through `run_wait`; report the delivery failure.

After worker dispatch, each Codex thread that still supervises pending work
keeps its turn open. When the current thread holds both roles, wait and then
perform the next authorized coordinator action. Complete any
claimed native action and its explicitly returned follow-up ACKs before
waiting. Do not use legacy `agent_wait`, `subscription_wait`, `wait_agent`,
short timeout loops, or shell polling as a substitute for the cursor-based
run event stream. Keep detached backend supervision running independently.

Stopping the run leaves the attached conversational thread available to the
user. It does not keep worker goals open after all executing descendants end.

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
`input_json` and `flow.step_started` event. The runtime contract carries the durable acceptance revision, immutable artifact
references, and current causal correction. `flow_context_update` persists a
material clarified objective before dependent dispatch; automatic transitions
must preserve it. A transition reason explains that transition and must not be
the only copy of accepted user intent. Compose worker instructions in
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

## Execution Model

1. For a new flow, use `flow_launch` or `agentctl flow launch`. This single
   operation validates, authenticates locally, registers/reuses the coordinator,
   attaches the original conversation with its event subscription, and dispatches
   the first ready worker. Keep the returned run, flow, observer, and cursor.
2. Do not print admin keys, agent tokens, or raw auth files in chat or logs.
   The launcher resolves local authorization internally. Preserve any scoped
   native bridge credential only through the existing private bridge contract.
3. On an existing-flow notification, do not start a new flow or log in again.
   Use the notification's flow and subscriber/orchestrator identities to resume
   through `flow_continue`, unless it asks for a manual routing decision.
4. Treat a reused launch as a resume. Keep the original conversational requester
   and its acknowledged cursor. Never replace it with the current worker's
   thread just because execution moved to another agent.
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
   result schema, author/step identity, required artifacts, and configured
   evidence guards before recording the report and selecting the next
   transition. Reuse the returned report receipt for retries; do not fabricate
   a second delivery after an uncertain response. It auto-continues by default. This means a normal worker report
   can launch the next worker without waking the coordinator.
9. A step with `execution: coordinator` does not dispatch a worker. For a
   configured decision, use `flow_decision` with the current revision and actual
   authorized decision; its report follows the configured transition. A
   notification without a decision contract may need `flow_step_start` with a
   concrete causal correction. Persist changed acceptance with
   `flow_context_update` before resuming. Neither a manual route nor a worker
   conclusion bypasses current artifact approvals or evidence requirements.
10. If Agent Control returns `blocked`, notify the orchestrator/user with a short
    reason and wait for correction instructions.
11. On `blocked`, stop dependent dispatch, explain the blocker, and stay
    available through event waiting while awaiting the required decision. End
    the turn only when every supervised task is resolved, or when the user
    explicitly pauses or cancels supervision. An unrelated question or a wait
    timeout does not satisfy that condition.

If a deterministic end-to-end flow runner command is unavailable, do not emulate
one by keeping the coordinator model turn open and manually polling every worker.
Use `flow_continue` for the next deterministic action, then consume run events
through the configured observation route.
If that is not enough to continue safely, report the missing runner capability
and stop dependent dispatch. Preserve event observation for existing work;
do not hand-roll a foreground polling loop.

For external detached backends such as OpenCode server, Agent Control should
launch the worker in detached mode. The conversational observer can remain
in `run_wait` while deterministic supervision refreshes backend state. Do not
keep a model turn open to poll status or repeatedly read worker logs.

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

Include optional output artifacts only when produced in this attempt. Omission
does not claim a previous file at the configured path as a new delivery.
The `result` fields are generic and are generated from the loaded flow config.
Do not assume meanings such as `approved`, `needs_changes`, `s`, `m`, `l`, or
`xl` unless they appear in the active step reporting contract.

For a strict flow, worker authorship and evidence must satisfy the generated
contract; coordinator inference or copied worker prose cannot replace the
required author capability. If the runtime provides an explicit authenticated
relay, relay only that original worker report. For a non-strict flow whose
contract permits a relay, a coordinator may submit the explicit worker output
on its behalf. The coordinator may not inspect an
artifact, infer a result, and submit a step report as if the worker had reported
it. If the worker reaches a terminal status without reporting, Agent Control
marks the step blocked so the coordinator/user can decide what to do. Do not
start fresh duplicate workers for the same active step as a retry loop unless
the flow config explicitly defines that retry strategy.

## Managed Package Groups

For a flow declaring `policy.work_packages`, use the generated `flow_packages`
contract. A content-bound manifest names the complete expected package set
before the existing exact-plan approval. That same decision includes the
`package_manifest_digest`; do not add a separate user approval for delegation.
An empty manifest keeps ordinary inline execution unchanged.

Use batch `launch` for all ready branches and batch `accept` for inspected
current deliveries. The parent retains its flow-step authority; package children
receive their own delivery contract and cannot complete the parent's step.
Consume the returned `wait_contract` through `flow_packages` using the launching
owner's `coordinator_observer`; preserve the separate original requester. After
processing a complete batch, invoke its returned `ack_contract` and wait again
with the one-hour timeout. Do not substitute polling, implicit ACK, or ending
the turn while packages remain pending. Respond to steering and reattach to the
wait. Respect
pinned owners, attempt generations, dependencies, and disjoint worktrees. The
runtime joins all required accepted deliveries and checks no launched branch
is still active before allowing implementation to finish.

`packages.integration_required` is runtime state, not a worker claim. The
integration owner consolidates exact accepted deliveries and records `integrate`
with a verified current result-checkpoint receipt covering every delivery and
using `base: runtime.packages.base_commit`, including a single external worktree.
Missing, stale, failed, or
unaccepted package results block the join; changing the manifest after approval
requires the ordinary renewed plan/acceptance decision. Retry/cancellation must
name the current attempt and a concrete reason.

Managed package workers currently require an explicitly configured
`codex-thread` role. Resolve an incompatible role override before defining a
group; do not silently change an explicitly requested backend. A nonempty
manifest also requires a clean consolidated checkout and clean worktrees at the
shared base. Preserve uncommitted work and use inline execution when a clean
baseline is unavailable. Native bridge
workers must not directly spawn siblings. The authorized coordinator provisions
Codex worktrees before registration. Do not bypass this contract with ad hoc
launches, manual worktree creation, or parent step reports submitted by children.

## Incremental Evidence And Recovery

Use `flow_evidence` only through its generated operation schema. The current
provider supports `read_receipt` for immutable prior evidence, plan/result preparation, deltas and review scope, semantic
review composition, approved plan projection, controlled validation, immutable
artifact snapshots, and closure verification. The caller supplies the semantic
draft or intended check; the runtime binds actor, flow, acceptance/plan revision,
provider version, and evidence identity. A worker-supplied approval boolean is
not a verified receipt.

A review owner receives a complete first target, then new directives, pending
scope, changed dependencies, prior findings, and immutable references. Evidence
composition carries only eligible closed records. Context loss or unbounded
impact requires full review; missing owner continuity blocks. Do not manually
reconstruct ledger state from conversation history or switch reviewers silently.

Keep real documents as artifacts and control outcomes as structured reports.
Use controlled command receipts for expensive validation reuse; only exact,
intact, non-volatile GREEN evidence is eligible. A focused check cannot satisfy
a complete closure gate. The model remains responsible for complete declared
scope; hashing cannot prove semantic independence.

Configuration, prompts, owners, decisions, and accepted evidence belong to the
run revision. Do not reload changed local prompt files into an existing run or
resolve evidence from an arbitrary installed cache. Resume recorded state and
receipt identities; stop dependent dispatch if recovery cannot establish them.

## Done

The requested inspection is complete when its question has an evidence-backed
answer, with material uncertainty stated. A requested execution completes when
its completion condition and required flow gates are satisfied. A blocker is
an update, not successful completion. Report the outcome and useful artifact
or run links concisely; end this turn only under the Turn Boundary Contract
for all supervised work.

## Deterministic Project Resolution

Pass the task repository's absolute `repo_dir` to catalog and launch tools (CLI:
`--repo-dir`). Catalog loading adds `.agents/flows` after bundled/user catalogs; a
project package with the same flow ID replaces the base. The runtime applies
`.agents/models.toml` role model/effort overrides and pins the effective config at
launch. Do not inspect files to calculate precedence or manually merge roles.
Model/effort environment overrides are unsupported; use flow-configurator to
migrate old `.agents.env` preferences. Backend/auth environment remains separate.
