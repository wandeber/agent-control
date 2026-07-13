# Agent Control

Agent Control is a local deterministic control plane for agent workers. It is
packaged as a Codex plugin with an MCP server and an `agentctl` CLI that share
the same TypeScript core.

The plugin also ships Agent Control skills:

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

Install from this local checkout while developing:

```bash
agentctl marketplace install
```

That command is equivalent to:

```bash
codex plugin marketplace add "$(pwd)"
```

Install from Git once the repository is published:

```bash
agentctl marketplace install wandeber/agent-control
```

or directly:

```bash
codex plugin marketplace add wandeber/agent-control --ref main
```

Refresh an existing Git marketplace installation after changes are pushed:

```bash
agentctl marketplace update
```

or directly:

```bash
codex plugin marketplace upgrade agent-control
```

Local path marketplaces read from the checkout directly, so they usually do not
need an upgrade command after file edits.

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

Create or attach a visible Codex-thread coordinator with:

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

The native panel reads compact snapshots, agent messages, and log tails through
app-only MCP tools. It falls back to the local API/WebSocket server when opened
as a normal browser page.

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
orchestration, prefer app-server delivery plus detached watchers; use blocking
wait only when the caller explicitly selects `mcp-wait` for a short/manual
foreground wait. Omit `--timeout` only when the caller has a separate
cancellation path such as stop, purge, subscription delete, or run shutdown.

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

Use `${VAR:-default}` for most flow backend/model settings. Agent Control reads
the process environment only; it does not source `.env` files.
When validation receives `--config-file`, prompt file references are checked
relative to the flow config file.

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

The runtime contract carries the active run title/objective, repository
directory, input artifact paths, output artifact paths, artifact descriptions,
and artifact handling rules. The reporting contract carries the exact MCP tool
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
`worker_dispatched_end_turn_until_agent_control_wakeup` or
`worker_already_running_end_turn_until_agent_control_wakeup` means the
coordinator should stop its turn until Agent Control wakes it again.
`orchestrator_action_required`, `flow_blocked`, `flow_completed`, and
`flow_cancelled` are terminal or human-decision control states.

The same surface is available through MCP as `flow_catalog_list`,
`flow_catalog_get`, `flow_validate_config`, `flow_start`, `flow_get`,
`flow_continue`, `flow_step_start`, and `flow_step_report`. Use
`flow_step_start` when a `notify` transition asks the orchestrator to choose the
next configured step. When a worker reports invalid structured data, omits a
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

## Standalone Workers

Use native `agentctl` commands for worker-style tasks outside a declared flow:

```bash
agentctl worker launch \
  --backend opencode-server \
  --server http://localhost:53910 \
  --repo /path/to/repo \
  --model opencode-go/deepseek-v4-pro \
  --title "Implementation" \
  --phase implementation \
  --prompt-file /path/to/canonical-prompt.md \
  --output-artifact /tmp/implementation-report.md \
  --watch
```

`agentctl worker launch --watch` starts the worker and arms a detached
deterministic watcher in the same operation. Use `agentctl watch start` only for
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
