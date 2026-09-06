# Integrated Codex Panel

Use the native Agent Control MCP App, opened with
`mcp__agent_control__open_agent_control_console`, in the initiating user
conversation. Omit `run_id` to follow the latest run, or supply a known run to
select it. The default screen is Subagents; Full console is a separate screen.

The required surface is the integrated side panel without a browser address
bar. Do not substitute `open_in_codex` with a browser target, a localhost page,
or the standalone runner HTML UI. A successful tool response confirms the open
request; verify the host has presented the integrated side panel before
claiming placement. If it remains inline, use the host's expand/open-in-panel
action when available. Report an unsupported placement honestly; never replace
it with a browser or claim that requesting fullscreen proves placement.

Reuse the original conversation's panel across launches, nested delegation,
and event waits. Nested workers do not open their own panels. Repair a lost
panel without relaunching work or discarding execution handles or event cursors.
Presentation does not replace requester registration, event subscription, or
continued supervision in the initiating conversation.
