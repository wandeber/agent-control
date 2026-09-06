# Native Codex Subagent v2 Bridge

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
returned follow-up action have been acknowledged, enter `run_wait` in the same
open turn as soon as the latest ACK contains no further action. Do not call `flow_continue` as a polling substitute.

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
`agent_external_sync({ agent_id, bridge_token, native_agent_id?, native_task_name?, native_task_path?, native_status, latest_message?, public_activity?, observed_at?, confirmed_absent? })`
instead. To populate a native worker card, send an explicitly public compact
`public_activity` object with `kind: "message" | "tool"`, `text` (up to 240
characters), optional `state: "running" | "completed" | "failed"`, and its
original emission `observed_at`. CLI uses `--public-activity-json`. Preserve the
emission time when syncing unchanged activity. The private `latest_message`
field never becomes card text automatically; do not put private reasoning,
raw logs, credentials, or tool arguments in the public summary. Use `null` to
clear it. Spawn only when no exact match exists. Use the same `list_agents` then
external-sync sequence after an ambiguous delivery, restart, or stale
controller state; do not create duplicate workers as recovery.

`wait_agent` is forbidden during normal flow execution. It may be used only
for an explicit foreground smoke test, with a single wide timeout rather than
short polling. Coordinators consume Agent Control events with `run_wait`.
Notification delivery does not reliably reactivate an ended Codex turn. Native
`wait_agent` is not the run event stream and does not replace this route.

