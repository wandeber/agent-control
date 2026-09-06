# Codex worker permission setup

Check worker tool permissions during Agent Control installation, update, and
verification, even when the plugin is already installed. Package installation
and permission to call its tools are separate. Do not launch a worker just to
discover missing permission.

Codex may require approval for an MCP call. With `approval_policy = "never"`, a
call that still requires approval is denied instead of opening a prompt. Do not
work around a denial through CLI reporting, controller files, or credentials.

## Review and confirmation

Inspect the effective configuration and any existing overrides without exposing
secrets. Show the user the exact missing or changed grants and explain their
persistent scope:

| Tool | Authorized capability |
| --- | --- |
| `flow_get` | Read flow configuration, steps, reports, transitions, and artifact bindings. |
| `flow_evidence` | Create and verify checkpoints and evidence, compose reviews, execute or reuse validation commands, and verify closure when the active phase permits that operation. |
| `flow_step_report` | Submit a phase result. A valid report can advance the flow and dispatch its next configured worker. |
| `flow_packages` | Define approved packages; launch, retry, or cancel their workers; deliver and accept results; verify integration; and wait for or acknowledge the launching thread's events. |

Ask for explicit confirmation before adding missing grants or replacing a more
restrictive setting. A request to install the plugin alone does not authorize
these persistent permissions. If the user has already authorized this exact
scope, proceed without asking again. Already-approved tools need no duplicate
entries or renewed confirmation.

If the user declines, leave the configuration unchanged and report the package
as installed with its current tool restrictions. Do not claim autonomous flow
execution is ready if the effective policy will deny its required calls. Stop
only the verification or launch that depends on the missing permission.

## Apply the authorized scope

Codex supports per-tool policy for installed plugins in its
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
After confirmation, add or update only these entries in the user's effective
`config.toml` (normally `${CODEX_HOME:-$HOME/.codex}/config.toml`):

```toml
[plugins."agent-control@agent-control".mcp_servers.agent_control.tools.flow_get]
approval_mode = "approve"

[plugins."agent-control@agent-control".mcp_servers.agent_control.tools.flow_evidence]
approval_mode = "approve"

[plugins."agent-control@agent-control".mcp_servers.agent_control.tools.flow_step_report]
approval_mode = "approve"

[plugins."agent-control@agent-control".mcp_servers.agent_control.tools.flow_packages]
approval_mode = "approve"
```

Preserve a private backup, parse TOML before and after the edit, and verify that
only the authorized tool policies changed. Preserve unrelated settings and
comments, the global approval policy, and worker shell sandboxes. Merge into
existing tables; do not append duplicate TOML tables or silently broaden the
grant to the entire server. These permissions remain in effect for future
calls to the four tools until changed or removed. Controller checks for phase
operations, caller identity, approved plans, and evidence still apply.

## Verify activation

Verify the saved entries and use a fresh Codex task or app-server process to
load the installed plugin and updated policy together. An already-open task's
tool catalog does not prove that it loaded the new configuration. Preserve the
packaged `tool_timeout_sec: 3700` so renewable one-hour event waits can finish.

Configuration inspection proves the grants are saved, not that a real worker
has completed a flow. Run a real worker only when that verification is in the
authorized task scope. Keep the requesting conversation subscribed, process
and acknowledge its events, and remain in renewable waits while work is active.
Report permission failures separately from controller authorization or workflow
errors; adding more tool grants does not repair those other causes.
