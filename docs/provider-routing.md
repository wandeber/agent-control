# Verifying external provider routing

A model's answer to an identity question is generated text, not transport
evidence. In particular, a Codex model-metadata fallback does not establish that
the request switched to an OpenAI model or provider.

Keep these observations separate:

| Evidence | What it establishes |
| --- | --- |
| Profile, controller `resolved_model`, and rollout model/provider | The recorded selection; not the HTTP destination or underlying model |
| Actual outbound endpoint and request `model` | The route used for that request |
| HTTP status, response `model`, and returned assistant message | What that endpoint returned; a response alias may hide another upstream |
| Gateway deployment metadata | Only the mapping actually disclosed; an alias repeated as the upstream does not identify weights or vendor |

For an authorized live diagnostic, preserve the selected profile, authentication
helper, sandbox, and session continuity. Capture only allowlisted transport
metadata and the relevant final assistant response. Do not record authorization
headers, helper output, complete payloads, or reasoning. A temporary local
pass-through may forward unchanged request bytes to the existing HTTPS endpoint;
keep its overrides process-scoped and remove its listener after the check. This
proves the instrumented request, not the wire route of an older untraced run.

Inspect the actual instructions as well as the response. Do not inject a desired
model identity, substitute another provider, or remove isolation to make an
identity answer look correct. If requested, send the identity question verbatim.
An authorized comparison without Codex instructions is a separate diagnostic,
not a replacement or continuation of the managed session.

## Local transport regression

The opt-in test uses an installed Codex executable and a local Responses fixture.
It creates a temporary configuration home and project, supplies a fixture-only
credential, and makes no real provider inference calls. It verifies the actual
endpoint, request model, credential channel, returned messages, and same-session
history for both `exec` and managed `app-server`, on start and resume. The profile
differs from the base defaults; explicit model/provider overrides are covered.

From `mcp/agent-control`:

```sh
AGENT_CONTROL_CODEX_ROUTING_BIN=/absolute/path/to/codex \
  pnpm exec vitest run tests/codex-cli-provider-routing.test.ts
```

Without that environment variable the test is skipped. A skipped test is not
evidence that the installed CLI preserves routing. Ordinary adapter tests remain
available without a local Codex installation.

## Yoda diagnostic, 2026-10-08

Codex CLI 0.156.1 and the existing `softec-yoda` profile were checked without
changing the profile or credentials. The older execution recorded `yoda` and
`softec-ai-lab`, warned about missing model metadata, and answered `Soy GPT-5.6.`
Its saved base/developer instructions contained no explicit GPT-5.6 identity.
That older execution had no captured HTTP request.

Fresh bounded checks of the managed CLI adapter captured the following:

- Start and exact-session resume both sent `POST` to
  `https://ailab.softecinnovation.es/v1/responses` with `model: "yoda"`.
- Both responses were HTTP 200 and reported `model: "yoda"` through completion.
- The user query was exactly `qué modelo eres?` in each turn. Under the normal
  Codex context the gateway returned assistant text claiming GPT-5. No GPT-5.6
  identity assertion appeared in the captured instructions.
- A separate request to the same endpoint with the same model and question,
  without supplied Codex instructions, returned `Soy GLM, un modelo de lenguaje
  grande desarrollado por Z.ai.` Its response model still reported `yoda`.
- The gateway's model-info endpoint returned `yoda` for both the public alias
  and its exposed upstream-model field; it did not disclose a GLM/MiMo version.

No transport substitution was reproduced. The contradictory identity claims
come from the gateway's generated responses and vary with the supplied context;
they are not evidence that Agent Control selected GPT-5.6. This comparison
supports context-sensitive self-description, but does not independently identify
the underlying model or establish the gateway's internal routing. No identity
prompt override or speculative routing change was applied.
