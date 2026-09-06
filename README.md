# Agent Control

Agent Control is a local deterministic control plane for agent workers. It is
packaged as a Codex plugin with an MCP server and an `agentctl` CLI that share
the same TypeScript core.

Default workers and bundled flow roles use Codex (`codex-thread`) with
`gpt-5.6-luna` and `max` reasoning. Existing explicit Codex selections, such as
the development-v1 final reviewer, are preserved. OpenCode is an optional backend
that requires an explicit backend and provider/model choice.

The plugin also ships Agent Control skills:

- `development-flow` for clarifying and running the bundled development workflow
- `flow-author` for designing declarative flow packages
- `flow-configurator` for setting backend/model environment overrides
- `flow-runner` for launching, resuming, and inspecting flows

The controller does not plan, review, or decide semantic quality. It registers
agents, starts work, sends messages, reads compact status, stops agents,
records goals and heartbeats, and delivers subscription events.

## Codex Marketplace

This repository is a Codex plugin marketplace. The marketplace manifest is
`.agents/plugins/marketplace.json`, and it exposes the root `agent-control`
plugin with its MCP server, CLI, web console runtime, bundled flows, and flow
skills.

Register this local checkout as a marketplace while developing:

The local marketplace materializes the repository's Git `HEAD`. Commit the
Agent Control files that should be installed before registering or refreshing
the checkout; uncommitted and untracked files are intentionally excluded from
the plugin snapshot.

```bash
agentctl marketplace install
```

That command is equivalent to:

```bash
codex plugin marketplace add "$(pwd)"
```

Then install the plugin, which makes the MCP server, CLI integration, bundled
flows, and skills available to Codex:

```bash
codex plugin add agent-control@agent-control
```

Expose the packaged CLI through the user's local binary directory after the
plugin installation:

```bash
plugin_version="$(codex plugin list --json | jq -er '.installed[] | select(.pluginId == "agent-control@agent-control" and .installed == true and .enabled == true) | .version')"
plugin_root="${CODEX_HOME:-$HOME/.codex}/plugins/cache/agent-control/agent-control/$plugin_version"
"$plugin_root/scripts/install-agentctl-link.sh"
```

The linker validates the packaged CLI before replacing a legacy Agent Control
wrapper or an older standalone symlink. It refuses to overwrite an unrelated
user-managed `agentctl` executable.

Register the Git marketplace once the repository is published:

```bash
agentctl marketplace install wandeber/agent-control
```

or directly:

```bash
codex plugin marketplace add wandeber/agent-control --ref main
```

Then install the same plugin selector:

```bash
codex plugin add agent-control@agent-control
```

Run the CLI linker above after a fresh install or marketplace refresh so the
stable `agentctl` command points at the active plugin cache version.

Refresh an existing Git marketplace installation after changes are pushed:

```bash
agentctl marketplace update
```

or directly:

```bash
codex plugin marketplace upgrade agent-control
```

After a Git marketplace refresh or a local plugin version/cachebuster change,
rerun `codex plugin add agent-control@agent-control` and start a new Codex task
so the updated MCP server and skills are loaded together.

## Identity

Root orchestrators authenticate with the local Agent Control admin key and
receive an agent identity token. Worker agents receive their own generated
tokens when they are registered or started. Tokens are local, persistent, and
stored only as hashes in SQLite; plaintext is returned only at creation/login
time.

The admin key is resolved from `AGENT_CONTROL_ADMIN_KEY`. If that variable is
unset, Agent Control generates a local random key under
`~/.agent-control` with `0600` permissions so local controller processes
can share it. Startup wrappers should set `AGENT_CONTROL_ADMIN_KEY` explicitly
when they need unattended root login.

CLI calls read `--token` first, then `AGENT_CONTROL_TOKEN`. MCP tools accept
`agent_token` because the MCP process may be shared across agents. OpenCode
workers launched by Agent Control receive their token through
`AGENT_CONTROL_TOKEN`; the token is not placed in the worker prompt.

Normal `worker_launch` / `flow_launch` MCP calls and CLI launches resolve local
authorization and coordinator identity automatically. For advanced manual
identity management, create or attach a visible Codex-thread coordinator with:

```bash
agentctl --admin-key "$AGENT_CONTROL_ADMIN_KEY" auth login \
  --run-title "Development Flow" \
  --title "Workflow Orchestrator" \
  --repo-dir "$REPO_DIR" \
  --backend codex-thread \
  --backend-handle-json "{\"thread_id\":\"$CODEX_THREAD_ID\",\"agent_control_role\":\"orchestrator\"}"
```

The response includes `run`, `agent`, and `agent_token`. Export that token as
`AGENT_CONTROL_TOKEN` for later CLI calls from the same coordinator. When a
caller registers a same-run worker with its token, Agent Control automatically
creates the `parent_child` relationship. When a caller creates a run with its
token, the new run records `parent_run_id` and `created_by_agent_id` so the web
console can show the run tree.

## Codex Console, Local API, And WebSocket

Agent Control includes a native Codex MCP App console, a local web console, and
an API/WebSocket server for tools that need live controller state without going
through MCP. The console source is a Next.js app, but normal plugin installs run
the prebuilt static runtime from `web-runtime`; they do not start Next.js dev or
require a `.next` directory. The console shows runs, agent relationship graphs,
draggable nodes, pan/zoom/follow graph controls, goals, heartbeats,
usage/context metrics, artifacts, events, logs, and read-only agent chat/message
views.

Inside Codex, open the native side-panel console with the MCP tool:

```text
open_agent_control_console
```

The panel opens the simple **Subagents** screen by default: a worker list and
its selected conversation. **Full console** opens a separate graph/flow screen;
**Back to subagents** returns to the simple screen. The screens share run and
worker selection, and only one is mounted at a time. The full console's Chat
tab uses the same rich conversation view as Subagents while retaining its
Events, Artifacts, and Logs tabs.

Browser URLs can select `#/subagents` or `#/console`. Fragment navigation also
works inside the single embedded Codex resource without reloading the app or
requesting another panel. Client library imports are eagerly bundled so chat
diagrams and graph layout do not require an external asset server.

Pass `run_id` to pin a specific run. With no `run_id`, the panel follows the
latest run. The tool result includes the initial snapshot and that selection
mode so the panel can paint immediately; later app-only reads run through one
serial refresh coordinator instead of overlapping polling loops. Explicit URL,
tool, and sidebar selections remain pinned until the user returns to an
unpinned URL.

The bundled `development-flow` skill calls `open_agent_control_console`
exactly once after clarification and catalog discovery, immediately before the
first launch. Opening the native console is a required pre-dispatch gate for
that skill: a missing or failed tool stops the launch, and Browser/local-web
fallbacks are not substituted. Agent Control wakeups and resumed turns never
reopen it.

The native panel reads compact snapshots, agent messages, and log tails through
app-only MCP tools. Snapshot reads ask the controller to refresh only adapters
that declare cheap status inspection; native Codex collaboration is synchronized
explicitly and is never polled by the console. The same UI falls back to the
local API/WebSocket server when opened as a normal browser page.

Automated bridge and refresh tests cover notification parsing, source
validation, initial-state replay, selection metadata, and serial request
coalescing. A full visual proof of live native Codex side-panel refresh must
still be performed from a new Codex task after installing the rebuilt plugin;
the current task cannot hot-reload its already-loaded MCP App bundle.

That follow-up visual check should run the complete bundled
`demo-age-duration` flow with the literal input `10/10/1991`, keeping its
current backends. Without pressing Refresh, verify that the panel follows the
new run, paints all seven steps/workers/reports as they advance, and reaches
the final transition. Also verify the visible Codex wakeup separately; the
headless/web tests in this repository cannot prove host-side task repainting.

Start the full console with:

```bash
agentctl web start --port 3766 --api-port 3767
```

Rebuild the packaged static runtime before starting when developing or
refreshing a marketplace install:

```bash
agentctl web start --rebuild --port 3766 --api-port 3767
```

The web UI opens at `http://localhost:3766`. The private API/WebSocket surface
is served on `http://localhost:3767` by default. HTML is served with
`Cache-Control: no-store` so local console refreshes pick up new plugin
versions immediately, while hashed static assets are cacheable.

You can also start only the API/WebSocket server for custom tools. It exposes
compact run snapshots, agent messages, log tails, registered artifact image
files, relationship links, usage snapshots, and a `/ws/control` stream for
snapshots, events, and selected agent log updates.

Start it with:

```bash
agentctl server start --port 3766
```

The default host is `localhost`. Both the console and the API server are
local-only in v0.

The MCP server does not poll by default. Backends that can observe their own
workers, such as the OpenCode detached-process adapter, arm a process watcher
after start. Set `AGENT_CONTROL_POLL_INTERVAL_MS` only when you want an
additional watchdog for agents that were attached after a restart or whose
backend cannot push lifecycle changes.

Blocking waits are available but must be explicitly acknowledged. They are
useful for command-line debugging and short opt-in foreground waits:

```bash
agentctl agent wait --agent <agent-id> --allow-blocking-wait --interval-ms 5000
agentctl sub wait --subscription <subscription-id> --allow-blocking-wait --interval-ms 5000
```

`sub wait` waits for the matching event even when the subscriber backend cannot
receive an inbound message. The returned JSON includes whether the event was
actually delivered to the subscriber.

While a blocking wait is open, the model is not polling or reading worker
transcripts; Agent Control refreshes status in normal code and returns compact
terminal state. For non-Codex or external orchestrators, prefer detached
watchers so the orchestrator process can end. For normal Codex Desktop
orchestration, keep detached supervision and consume the automatic conversation
subscription with `run_wait`, indefinitely or with a one-hour timeout. Legacy
`agent_wait` / `subscription_wait` remain explicit diagnostic operations. The
flow watcher refreshes the whole run through later phases and coordinator gates,
until completion, cancellation, run shutdown, or its configured timeout.

Delivered subscription messages are compact human-readable notifications. They
include the event type, event id, run id, source agent, subscriber, status,
short backend message, and the subscriber's registered `objective`. Register
subscribers with an actionable objective, for example "When this event arrives,
run final review using these artifact paths...". This avoids sending a separate
setup turn just to explain what the subscriber should do when it wakes, while
keeping Codex threads readable instead of filling them with raw JSON payloads.
When the subscriber backend is `codex-thread`, Agent Control adds a short
Codex Desktop visibility note with the target thread id. It explains that
app-server delivery is durable controller plumbing, but may not live-refresh an
already-open Codex Desktop view. The receiving thread must continue normally
from the delivered event; it must not try to force-refresh itself through
native thread tools.

## Goals

Agent Control goals are controller-owned. Register a goal against the
orchestrator agent for a run, then use controller operations to decide when the
owner should be asked whether the goal is complete, should continue, or is
blocked.

Creating a goal does not create a heartbeat by default. Heartbeats are optional
supervision signals and should be created only when a caller explicitly wants
periodic idle-timeout checks. Heartbeat events are deterministic controller
events: they are emitted by `poll`, a detached watcher, the MCP server polling
loop, or the local API server loop, not by an always-running background model
turn.

Goal completion confirmation is deferred while any `parent_child` descendant of
the goal owner is active. Use deterministic waiting instead of model-side
polling:

```bash
agentctl goal register --agent <orchestrator-agent-id> --objective "..."
agentctl goal wait-confirm --goal <goal-id> --allow-blocking-wait --timeout 8h --interval-ms 30000
```

External model orchestrators should run goal confirmation from a detached
watcher or persistent controller process when child agents may still be running.
A visible native Codex coordinator may instead keep its current turn open with a
blocking MCP wait so Desktop continuity stays native.

Goal elapsed time is measured from the goal record's `created_at` until a
terminal goal status update (`complete`, `blocked`, or `cancelled`). Worker and
phase elapsed times come from Agent Control agent timestamps and lifecycle
events.

## Declarative Flows

Agent Control can validate and track declarative flow instances. A flow config
defines steps, named artifacts, required inputs and outputs, structured step
reports, and generic transitions over reported result fields. Config files may
be YAML or JSON. The controller does not interpret domain values such as task
sizes or review outcomes; it only validates the configured schema, checks
required artifact paths, records the selected transition, and activates the next
step, dispatches ready workers through `flow_continue`, or notifies the
orchestrator when the config explicitly asks for feedback/decision.

Flow config files support shell-style environment placeholders in string values:

- `${VAR}` requires `VAR` to be present.
- `${VAR-default}` uses `default` only when `VAR` is unset.
- `${VAR:-default}` uses `default` when `VAR` is unset or empty.

Use `${VAR:-default}` for most settings. When the same role can opt into
`codex-subagent`, use `${MODEL_VAR-default}` for its model so an explicitly
empty environment value survives expansion and tells the native backend to
inherit the root model. Agent Control reads the process environment only; it
does not source `.env` files.
When validation receives `--config-file`, prompt file references are checked
relative to the flow config file.

Roles use a persistent Agent Control identity by default. An independent
reviewer that may request corrections should keep `agent_lifecycle: reuse`: its
backend worker starts with clean context on the first review and the same worker
handles every later review iteration. Reserve `fresh_per_step` for workflows
that intentionally require a different worker for every step instance.

Agent Control also exposes flow catalogs for discovery. The bundled catalog,
`repo-flows`, points at this repository's top-level `flows/` directory or the
installed marketplace root. User-added flows belong outside the repository in
`user-flows`, which defaults to `$HOME/.agent-control/flows`.
Use `flow_catalog_list` / `agentctl flow catalog list` to discover available
flow ids, and `flow_catalog_get` / `agentctl flow catalog get --flow <flow-id>`
to resolve a flow id or directory name to its config path and loaded config.
Set `AGENT_CONTROL_FLOW_CATALOG_DIR` only when a local runtime needs to override
the bundled catalog root. Set `AGENT_CONTROL_USER_FLOW_CATALOG_DIR` to override
the user flow catalog directly, or set `AGENT_CONTROL_HOME` /
`AGENT_CONTROL_USER_DIR` to move the whole user Agent Control home.

Flow artifacts are named resources. Steps consume artifact paths through
`inputs` and produce artifact paths through `outputs`; agents do not wait on
arbitrary files. If a required input or output artifact is missing, the step is
blocked and a compact flow event is emitted.

Flow prompts are named resources too. A config may define top-level `prompts`
and then reference them from `roles` or `steps` with `prompt_ref`, or it may use
`prompt_path` directly on a role/step. Prompt paths must point to Markdown
files (`.md`). Agent Control validates and records the references, but it does
not read prompt files into controller state; the runner resolves prompt paths
and composes the worker message. When a step is activated, its `input_json` and
`flow.step_started` event include ordered `prompt_sources`: role prompt first,
then step prompt. They also include structured `input_artifacts`,
`output_artifacts`, a generated `runtime_contract`, and a generated
`reporting_contract`.

The runtime contract carries the effective objective, repository directory,
input artifact paths, output artifact paths, artifact descriptions, and
artifact handling rules. A manual transition can add coordinator context; that
latest context is authoritative wherever it adds to, clarifies, or conflicts
with the original run title. The reporting contract carries the exact MCP tool
name, CLI fallback command, `step_instance_id`, result schema, allowed routing
values, report artifact payload, and examples for that active step.

Runners should pass `runtime_contract.markdown` and
`reporting_contract.markdown` to workers instead of relying on workers to know
Agent Control skills, hardcoded paths, or hardcoded report labels. The flow
config remains the source of truth; generated contracts are only step-specific
renderings of that config and the resolved runtime values.

The runner/coordinator must stay out of step execution. It should not write
step artifacts, infer semantic conclusions from artifacts, or submit
`flow report` on behalf of a worker unless the worker explicitly returned the
report payload or compact report text. If a worker reaches a terminal status
without reporting, Agent Control marks the step blocked for orchestration. This
keeps flow runs honest in the console and avoids spending coordinator tokens
doing worker work.

The runtime is backend-neutral but can dispatch configured role backends through
`flow_continue`. A normal worker report validates the result, records artifact
bindings, selects the configured transition, activates the next step, and
auto-continues by default. The orchestrator is subscribed only to configured
flow notifications and blockers; ordinary step-to-step transitions do not need a
coordinator wakeup.

Native-only roles can request the Codex subagent v2 bridge explicitly:

```yaml
roles:
  native_worker:
    backend: codex-subagent
    model: ""
    backend_options:
      codex_subagent:
        fork_turns: none
```

`fork_turns` accepts `none`, `all`, or a positive integer string. Native roles
inherit the root model and reasoning effort, so nonempty overrides are rejected.
Set a bundled role's backend to `codex-subagent` and clear both its model and
reasoning-effort variables to opt in with the safe default `fork_turns: none`. Because
`backend_options` are rejected on non-native backends, configurable bundled
roles do not carry dormant native options.

For `codex-subagent`, the root coordinator claims each persisted logical action,
executes exactly one native collaboration tool (`spawn_agent`, `send_message`,
`followup_task`, or `interrupt_agent`), and acknowledges the result. Recovery
first uses `list_agents` and then `agent_external_sync`; an exact existing task
is reused instead of duplicated. Workers only implement and report their own
step—they never orchestrate siblings.

The CLI writes bridge and action-claim credentials to Agent Control's private
local credential store with restrictive directory/file permissions.
`agentctl flow launch` returns only `bridge_grant.bridge_grant_id`;
`agentctl action claim` accepts that public reference, stores its one-time
action token, and returns only claim metadata plus the native request.
`agentctl action ack` resolves the token locally. Later continue, dispatch,
claim, and external-sync commands accept `--bridge-grant <id>`. Raw token flags
are advanced-only and no normal CLI output prints them. Neither tokens nor
their public control references belong in chat, events, logs, UI, artifacts,
prompts, worker messages, or summaries.
The private request returned by claim is used only to call its exact native
tool; workers receive the intended task message, never bridge/action control
data.

Missing, revoked, expired, unsafe, or ambiguous local credentials block the
operation instead of falling back to a new login or broader credential.

For authoring semantics, transition patterns, subscriptions, and visual
relationship guidance, see [`docs/flow-patterns.md`](docs/flow-patterns.md).

```bash
agentctl flow schema
agentctl flow validate --config-file ./flow.yaml
agentctl --admin-key "$AGENT_CONTROL_ADMIN_KEY" flow launch \
  --config-file ./flow.yaml \
  --title "Classify and route task" \
  --repo-dir "$PWD"
agentctl --admin-key "$AGENT_CONTROL_ADMIN_KEY" flow start \
  --config-file ./flow.yaml \
  --run-title "Classify and route task"
agentctl flow continue --flow <flow-instance-id>
agentctl flow report \
  --step <step-instance-id> \
  --status completed \
  --result-json '{"size":"s"}' \
  --artifact analysis=/tmp/agent-control/analysis.md
agentctl flow get --flow <flow-instance-id>
```

`agentctl flow launch` returns a compact control result for visible
coordinators. The stable fields are `next`, `run_id`, `flow_instance_id`,
`active_step`, `worker_agent_id`, `expected_artifacts`, `blocked_reason`, and
`ui_url`. A `next` value of
`worker_dispatched_wait_for_run_events`,
`worker_already_running_wait_for_run_events`, or
`worker_start_in_progress_wait_for_run_events` means the coordinator keeps
its turn open and calls `run_wait` with the returned `observer.wait_contract`.
`native_subagent_action_required` means the root must claim the returned safe
action reference, execute its exact native collaboration tool, acknowledge it,
and then enter `run_wait` after a successful spawn without ending the turn. The CLI returns a public
`bridge_grant` reference while persisting the scoped bridge credential
privately; neither the reference nor any token is copied into the user-facing
launch summary.
`orchestrator_action_required`, `flow_blocked`, `flow_completed`, and
`flow_cancelled` are terminal or human-decision control states. A blocker
stops dependent dispatch but does not automatically end event observation.

The same surface is available through MCP as `flow_catalog_list`,
`flow_catalog_get`, `flow_validate_config`, `flow_start`, `flow_get`,
`flow_continue`, `flow_step_start`, and `flow_step_report`. Use
`flow_step_start` when a `notify` transition asks the orchestrator to choose the
next configured step. Put the complete correction, newly clarified user answer,
or approval context in its `reason` so the target worker receives the effective
objective. When a worker reports invalid structured data, omits a
required artifact, or terminates without reporting, the flow instance moves to
`blocked` so an orchestrator can correct, retry, or cancel.

## Interfaces

- MCP server: `agent_control`
- CLI: `agentctl`
- Web console: `agentctl web start --port 3766 --api-port 3767`
- Static web build: `agentctl web build`
- API/WebSocket server: `agentctl server start --port 3766`
- State: `$HOME/.agent-control/state.sqlite`
- Runtime files: `$HOME/.agent-control/runs/<run-id>/`

CLI commands print JSON on success. Runtime, controller, and validation errors
also print structured JSON to stderr before exiting non-zero:

```json
{
  "ok": false,
  "error": {
    "message": "Agent not found: agent_missing",
    "reason": "tool_error",
    "details": {
      "agentId": "agent_missing"
    },
    "name": "ControllerError"
  }
}
```

Callers should read `error.reason` and `error.details` instead of parsing human
error text.

## Lifecycle

- `stop` asks a backend to stop execution.
- `unregister` hides an agent from active tracking while preserving its history.
- `purge` physically deletes controller database rows and controller-owned
  runtime files.

Purge commands are intentionally separate because they are destructive. They
never delete arbitrary artifact paths in target repositories; runtime deletion
is limited to `$HOME/.agent-control/runs/...`.

When a run should be cancelled completely, prefer `run purge --stop-first
--force`. The controller attempts to stop active workers before deleting rows,
including recovering OpenCode PID/log metadata from the controller runtime
directory if a launch was interrupted before the backend handle reached SQLite.

Examples:

```bash
agentctl agent purge --agent <agent-id> --dry-run
agentctl run purge --run <run-id> --stop-first --force
agentctl maintenance purge-old --older-than 7d --dry-run
```

## Backends

The first backend adapters are:

- `opencode-server`: starts detached OpenCode CLI workers attached to an
  OpenCode server. For local `localhost` servers, Agent Control verifies the
  server before each worker start and starts it as a detached local process if
  it is down. Agent Control does not install a persistent LaunchAgent for this
  server; if the server is stopped later, the next local worker start can bring
  it back up.
- `codex-thread`: creates, attaches, messages, reads, and interrupts Codex
  threads through Codex app-server. The default transport is the documented
  Unix socket transport so Agent Control can use a persistent local app-server
  without opening a TCP port:

  ```bash
  codex app-server --listen unix://
  export CODEX_APP_SERVER_URL=unix://
  ```

  The documented stdio JSONL transport is also supported for short-lived direct
  operations:

  ```bash
  export CODEX_APP_SERVER_URL=stdio://
  ```

  The current Codex thread id is usually available to runner shells as
  `CODEX_THREAD_ID`.

  App-server delivery is the supported durable transport for creating,
  resuming, reading, and interrupting Codex threads. Current Codex Desktop
  builds may not live-refresh an already-open thread when an external
  app-server client starts a turn, even though the turn is durable and will be
  visible after the Desktop app reloads the thread. Do not ask an
	  app-server-delivered turn to force-refresh itself through native thread
	  tools; that native tool surface is only available to an already-active Codex
	  Desktop session. If a workflow needs guaranteed live Desktop continuity from
	  a Codex coordinator, report that current app-server delivery cannot guarantee
	  it. External Agent Control app-server delivery should be treated as durable
	  wakeup plumbing, not as a UI-refresh guarantee.
- `codex-subagent`: persists native Codex subagent v2 actions for execution by
  the visible root coordinator. Agent Control never calls collaboration tools
  from the MCP process. The root claims an action, maps it to exactly one native
  call, acknowledges success/failure, and synchronizes observed native state.
  This keeps Desktop-visible orchestration native while retaining durable flow,
  artifact, and transition state in Agent Control.

For `codex-thread`, the default `unix://` connection starts the local Codex
app-server daemon automatically if its socket is missing or refused. Explicit
custom sockets, WebSocket URLs, and stdio transports keep their selected
configuration. Unix control sockets disable WebSocket compression because
Codex rejects the compression extension during the handshake.

## Standalone Workers

Use the MCP `worker_launch` tool for a worker outside a declared flow:

```json
{"title":"Review changes","prompt":"Review the current diff without editing files.","repo_dir":"/path/to/repo"}
```

One call registers the coordinator and initiating conversation, subscribes it
to all run events before dispatch, starts a Codex Luna Max worker, and arms
detached supervision. Keep the returned `observer` and use `run_wait` with its
cursor. A report file is optional for ad hoc work. Declared flows have the
corresponding `flow_launch` tool, accepting `title`, `repo_dir`, and either
`flow_id` or `config`.

The equivalent CLI supports `--prompt` for inline task text or `--prompt-file`
for an existing canonical prompt. Workflow callers can still require a report:

```bash
agentctl worker launch \
  --backend codex-thread \
  --repo /path/to/repo \
  --model gpt-5.6-luna \
  --reasoning-effort max \
  --title "Implementation" \
  --phase implementation \
  --prompt-file /path/to/canonical-prompt.md \
  --output-artifact /tmp/implementation-report.md \
  --watch
```

`worker launch` defaults to `codex-thread`. New Codex workers without a model
selection use Luna Max; `--model` and `--reasoning-effort` can override those
settings. Flow roles declare `reasoning_effort`, and direct agent starts can pass
`metadata.reasoning_effort`. The Codex adapter sends it as `turn/start.effort`
and retains it for subsequent turns. Omitting the effort for other explicit
Codex models preserves their configured default.

For a clean worker execution that needs compact workflow state from earlier
phases, pass one JSON array with `--input-handoffs-json`:

```text
--input-handoffs-json '[{"label":"accepted_analysis","kind":"phase_report","payload":{"verdict":"passed","summary":"Use the accepted design."}}]'
```

The option may appear only once. It accepts at most 16 uniquely labelled
handoffs; labels and kinds use lowercase stable tokens, each payload is a JSON
object limited to 16 KiB, and the full collection is limited to 64 KiB. Payload
content is opaque caller-owned data: Agent Control validates only the envelope,
cardinality, size, and lossless JSON rendering. Accepted handoffs are rendered
once in the worker's in-memory dispatch prompt; Agent Control does not create a
prompt file or expose them as artifacts. Use `--input-artifact` for larger
persisted input.

`agentctl worker launch` starts the worker and arms a detached
deterministic watcher by default. `--watch` remains accepted for compatibility;
use `--no-watch` only when an existing supervisor already owns status refresh. Use `agentctl watch start` only for
already-existing agents, subscriptions, or goals:

```bash
agentctl watch start --agent <agent-id> --timeout 30m --interval-ms 5000
```

For a controlled local smoke check of the worker-launch path, use:

```bash
agentctl smoke worker-launch --repo /path/to/repo
```

The smoke uses the `manual` backend, starts no external agent process, verifies
detached watcher completion and `agent.completed` event recording, then purges
the smoke run by default.

## Development

```bash
pnpm --dir mcp/agent-control install
pnpm --dir mcp/agent-control typecheck
pnpm --dir mcp/agent-control test
pnpm --dir mcp/agent-control lint
pnpm --dir web install
pnpm --dir web typecheck
pnpm --dir web build:runtime
```

`agentctl web build` is the packaged equivalent of `pnpm --dir
web build:runtime`. Both run a static Next.js export and
copy only the minimal runtime files into `web-runtime`,
which is the directory that should be tracked and packaged. Do not commit
`web/.next` or `web/out`; both are
intermediate build directories.

For local UI development, run the console source explicitly in dev mode:

```bash
agentctl web start --mode dev --port 3766 --api-port 3767
```

Run the MCP server locally:

```bash
mcp/agent-control/run-agent-control-mcp.sh
```

Use the CLI after building:

```bash
pnpm --dir mcp/agent-control build
mcp/agent-control/bin/agentctl --admin-key "$AGENT_CONTROL_ADMIN_KEY" run create --title "pull refresh"
```

## License

Agent Control is available under the [MIT License](LICENSE).

## Conversational run observation

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


MCP and CLI flow/worker launches attach the initiating Codex conversation to
the run before dispatch and subscribe it to all supported events by default.
Lower-level `flow_start` and `agent_start` share this behavior. The original
requester persists across nested runs; pass `requester_thread_id` (MCP) or
`--requester-thread-id` (CLI) when a separate executor cannot inherit it.
Explicit filters and delivery choices survive repeated launches.

While any supervised work remains, keep the Codex turn open. Respond to new
user messages in commentary, even on another topic, then resume `run_wait` with
the last processed cursor. Preserve all active runs and their separate cursors.
Use one-hour waits, or 30 minutes if the host requires it, and renew a timed-out
wait. An optional localized status sentence can say: "The <flow> flow is still
running; I am continuing to wait." Notifications cannot reliably reactivate an
ended turn, even if delivery succeeds. Finish only when all supervised work is
resolved or the user explicitly pauses or cancels supervision.

Launch returns `observer.wait_contract`; each open `run_wait` response refreshes
that contract with the next cursor and executable wait arguments. Launch itself
returns immediately so the conversation can speak before waiting. `agentctl run observe` attaches to an existing run; `agentctl run
wait` consumes its subscribed events with a durable cursor, indefinitely or
with `--timeout 1h`. The conversational observer stays available when the run
stops and does not acquire worker or native bridge ownership. See
[flow patterns](docs/flow-patterns.md#initiating-thread-observation) for filters,
notification delivery, and same-thread coordinator behavior.

Agent cards show state, current or last phase, and the latest public text or
tool use. The agents view highlights the selected agent's relationships (or the
active phase worker), keeps other main connections visible, and routes arrows
around cards. Use **Relations > Show all relationships** for the full graph.
