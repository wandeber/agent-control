// Fixtures explicitly opt into requester observation and authentication. Never
// inherit the real Codex conversation or credentials when running inside Codex.
for (const key of [
  "CODEX_THREAD_ID",
  "AGENT_CONTROL_REQUESTER_THREAD_ID",
  "AGENT_CONTROL_TOKEN",
  "AGENT_CONTROL_ADMIN_KEY"
]) {
  delete process.env[key];
}
