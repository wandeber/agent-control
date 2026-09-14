---
name: configured-agents
description: Discover, configure, or invoke reusable Agent Control agents by name. Use when the user asks which saved agents are available, requests an agent such as the analyst or video editor, or wants to create, copy, edit, or delete an agent and configure its model, instructions, or ordered plugins, skills, and MCP settings.
---

# Configured Agents

Resolve saved agent identities through Agent Control. A saved definition contains
instructions, a Codex model/provider/reasoning selection, and ordered capability
settings. An execution is a separate worker created from that definition.
The catalog combines agents bundled with Agent Control and personal agents;
never assume a fresh installation has an empty catalog. Bundled development
agents are available without copying flow prompts or changing HDT.

## Resolve The Requested Operation

Use the user's current request and existing authorization. Listing or inspecting
an agent does not authorize launching it or editing its configuration. A request
to ask a named agent to do work authorizes that bounded delegation.

- For a known name or definition ID, call `agent_definition_get` directly with
  exactly one of `name` or `definition_id`.
- Call `agent_definition_list` to answer which agents exist, choose a suitable
  saved agent, or resolve a name that was not found. Use the actual returned
  names and descriptions, not an invented catalog or a hardcoded role list.
- Resolve a material ambiguity with the available native question UI. If none
  is available, ask in conversation. Do not launch a different agent silently.
- To show the editor, use `open_agent_control_console` with `screen: "agents"`
  and the task's absolute `repo_dir`, or reuse the existing panel.

`definition_id` identifies saved settings. The returned execution `agent_id`
identifies a running worker; never interchange them.

## Configure Saved Agents

Use `agent_definition_inventory` with the actual task `repo_dir` when choosing
models or capabilities. It returns the qualified executable, actual providers
and models, installed plugins, standalone skills, and standalone MCP servers.
Use `refresh: true` only when an explicit rescan is needed, such as after an
installation. Ordinary toggles and edits do not need another inventory read.

Prefer the plugin control for capabilities that belong to a plugin. Bundled
skills and MCP servers are managed with that plugin; standalone controls cover
only independent capabilities. Agent Control itself is required infrastructure.
Bundled agents use `capabilities_mode: "inherit"`: new workers take the enabled
plugins, skills, MCP servers, and apps from the general Codex CLI configuration.
Personal agents may instead use a custom selection. Model, provider, and
reasoning remain explicit, editable settings. Enable requested capabilities
using returned IDs, skill paths, and MCP names.

Use the shared tools:

| Operation | Tool and fields |
| --- | --- |
| Create | `agent_definition_configure`, `operation: "create"`, `expected_revision`, `patch` |
| Edit | `agent_definition_configure`, `operation: "update"`, `definition_id`, `expected_revision`, `patch` |
| Copy | `agent_definition_configure`, `operation: "duplicate"`, `source_id`, `expected_revision`, `patch` |
| Delete | `agent_definition_delete`, `definition_id`, `expected_revision` |

Take `expected_revision` from the latest catalog read or successful mutation.
The editable patch accepts `name`, `description`, `instructions`, `model`,
`model_provider`, `reasoning_effort`, `capabilities_mode`,
`skills_catalog_token_budget`, and ordered
`plugins`, `skills`, and `mcp_servers` arrays. Plugin entries use `{id, enabled}` with optional ordered `skills`,
`mcp_servers`, and `apps` child selections using the same identity/toggle shape;
skills use `{path, enabled}`; MCP servers use `{name, enabled}`. A supplied array
replaces that whole saved array, including disabled entries. Omitted fields stay
unchanged; a null budget removes the override. The optional budget is 1–10,000.

To customize inherited capabilities, materialize all three `plugins`, `skills`,
and `mcp_servers` arrays from the current inventory defaults and submit them
together with `capabilities_mode: "custom"`. Preserve required infrastructure
and the other categories when changing only one capability. For currently
enabled plugins, also preserve each bundled child's inventory enablement in its
nested selections so an unrelated edit cannot re-enable a disabled child.
Omitted child arrays use the plugin's ordinary all-enabled selection; supplied
arrays select only their enabled entries. Set
`capabilities_mode: "inherit"` to return to general defaults. Editing a name,
model, or instructions alone must retain the current capability mode.

Bundled entries expose read-only `bundled_key` and `customized` metadata. Updates
are personal field overrides; do not write those metadata fields or edit the
installed bundle. Bundled agents can be customized or duplicated, not deleted.
Use stable definition IDs for tools and stable bundled keys for portable flows.

After a revision conflict, reread and reconcile only the intended change against
the current definition before retrying. Do not replay a stale whole definition
over someone else's edits. Never edit catalog files directly, copy credentials,
or change global Codex settings as a substitute for these operations.

Preserve the user-selected order, including disabled entries. Order is saved in
the catalog and compiled settings; it does not guarantee Codex prompt priority
or which skills fit the context budget. Report external model aliases as needing
launch validation when the inventory says so; do not invent supported efforts.

Catalog changes require local operator authority. An ordinary user-facing Codex
conversation can use the authorized local route. A managed worker's run token
does not grant access to edit the shared catalog; relay an authorized change to
the user-facing owner instead of trying alternate credentials.

## Launch And Continue

For a new requested task, call `agent_definition_launch` with the resolved
`definition_id`, the actual `repo_dir`, and exactly one of `prompt` or
`prompt_file`. Reuse an existing task run when appropriate. The tool resolves
and validates the saved settings, freezes a private execution snapshot, attaches
the original conversational requester, subscribes it to run events, and starts
the worker. It performs fresh inventory checks; do not manually preflight,
register, log in, subscribe again, or reconstruct a saved agent as a role prompt.

The definition selects the managed Codex CLI route. Do not override it with a
native default model/profile or another backend. A missing selected capability,
unsupported runtime, or isolation failure is a concrete launch blocker; report
it without silently weakening the saved configuration. Installing capabilities
or changing the definition requires the corresponding user authorization.

Preserve the launch receipt's worker, run, snapshot identity, requester and
coordinator observations. A separate executor carries the original
`requester_thread_id` in tool metadata; never replace it with the executor's own
thread or put it in the task prompt. An execution result is not saved settings.

If `$delegated-runner` is available, retain this managed worker through its
ordinary opaque execution lifecycle. Otherwise continue the returned worker
directly with Agent Control's `agent_send_message` and supervision tools.
Follow-ups target that exact execution. Editing or deleting a definition changes
future launches, not an existing worker; do not relaunch from the catalog to
continue a conversation.

Immediately enter the returned `run_wait` contract after launch. Use `observer`
for the original conversation or `coordinator_observer` for a separate executing
thread. Each keeps its own processed cursor. Use `timeout_ms: 3600000` (one
hour) as the normal value; a shorter timeout requires an explicit user request
or permission to choose it. Do not lengthen it without a user instruction or a
concrete reason within granted discretion. Preserve the
accepted policy after user messages, handled events, errors, and timeouts.
This is a minimum configured timeout, not a minimum elapsed wait: actionable failures, blockers, decisions and
completion return early. Outer async yields or UI responsiveness do not shorten
it; resume the same pending wrapper call, without creating duplicate waits.
Report a host deadline below one hour instead of silently shortening the wait
without user authorization.
Explicitly `run_ack` after handling each complete
event batch. Request all event wakeups only when the user wants individual
updates; durable subscription and wake filtering are different settings.

Keep the turn open while any supervised work remains pending. After user
steering, a question on another topic, an event, or a timeout, respond in
commentary when useful and reattach to the same run and observer with the
durable processed cursor and the accepted timeout policy if the call returned
or was interrupted; otherwise resume its existing pending call. Subscription notifications
cannot reliably wake an ended Codex turn. Do not replace waits with polling or
a monitoring automation. Finish when all supervised work has settled and its
outcome is known, or when the user explicitly pauses or cancels supervision.

## Reuse From A Flow

A flow role can select `agent_ref: development-planner` or another returned
`bundled_key`; a personal definition ID works on that user's installation.
Keep phase-specific instructions on the step. Do not combine `agent_ref` with
role `prompt`, `prompt_ref`, or `prompt_path`. An inline role remains supported
with its own Codex backend, model, provider, effort, and instructions.
`development-flow-v1` demonstrates both forms: its analyst is inline and its
other workers reference the shared catalog.

The flow pins the selected definition at creation. Each new worker compiles its
capabilities for its actual repository; continuations keep that worker's frozen
selection. Definition edits affect future flows, not a running flow's owners.
Use `$flow-author` for flow authoring and the ordinary flow runner for execution.

## CLI And Missing Capabilities

The same operations are available under `agentctl agent-definition`:

```bash
agentctl agent-definition list
agentctl agent-definition get --name "Analyst"
agentctl agent-definition inventory --repo-dir "$PROJECT_DIR"
agentctl agent-definition launch --definition-id "$DEFINITION_ID" \
  --repo-dir "$PROJECT_DIR" --prompt-file "$TASK_PROMPT_FILE"
```

`configure --input-json` takes the same configure DTO; `delete` accepts
`--definition-id` and `--expected-revision`. Use structured MCP arguments when
available. If a tool or CLI operation is missing, report the missing capability
and use the Agent Control installation/update workflow only when authorized.
Do not silently replace an explicitly requested tool or saved-agent execution
with another procedure.
