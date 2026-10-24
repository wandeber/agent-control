# Codex update review — September 23, 2026

## Findings

GPT-6 Sol and Luna launched on September 22. The current documentation recommends
Sol for everyday and complex coding and Luna for focused, repeatable work. Codex
supports Luna through `max`, without `ultra`. GPT-5.5 will retire from Codex with
ChatGPT sign-in on October 14; its API availability is unaffected.
[Official models](https://learn.chatgpt.com/docs/models).

Standard short-context API prices, in USD per million tokens:

| Model | Input | Cached input | Cache writes | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Sol | 2 | 0.20 | 2.50 | 10 |
| GPT-5.6 Sol | 4 | 0.40 | 5 | 20 |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 | 0.50 |
| GPT-5.6 Luna | 0.20 | 0.02 | 0.25 | 1.20 |

Sol's rates are halved. Luna's input and cache rates are halved; output is about
58% cheaper. Agent Control's price display remains an API-equivalent estimate,
not subscription billing. Codex credits have separate published rates and no
separate cache-write fee. [API pricing](https://developers.openai.com/api/docs/pricing),
[Codex pricing](https://learn.chatgpt.com/docs/pricing#token-rates).

## External providers and the model picker

Custom providers and model catalogs are supported. However, this review found no
documented native aggregation of independently routed OpenAI and external models
in one picker. `model_provider` selects the active provider; `model_catalog_json`
describes models but does not assign a provider to each entry. Bedrock's documented
picker behavior explicitly follows the active provider.
[Provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers),
[Bedrock picker](https://learn.chatgpt.com/docs/amazon-bedrock#choose-a-model).

The installed desktop client's `model/list` schema and picker implementation also
operate on a host's current catalog. This supports the single-active-provider
interpretation; no visual mixed-provider acceptance test was performed. Keep
Softec profiles and Agent Control's explicit model/provider bindings. A merged
catalog alone is insufficient to prove routing or availability.

## Useful follow-up work

- Discover model efforts and capabilities from the selected runtime. The app
  server exposes model metadata including service tiers and multi-agent support;
  provider capabilities are a separate concern.
  [App server](https://learn.chatgpt.com/docs/app-server#models).
- Evaluate lifecycle hooks that call MCP tools for observability. Hooks with an
  unavailable MCP handler do not establish a mandatory validation gate; retain
  Agent Control's verified evidence and approval transitions.
  [Hooks](https://learn.chatgpt.com/docs/hooks).
- Track native agent configuration, inheritance and persistence while preserving
  explicit role ownership and model choices.
  [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- Check compatibility before upgrading the terminal CLI: recent releases retire
  `codex mcp-server` and remove `thread/rollback`, while adding provider catalog
  URLs and agent inspection/message boards. Neither retired call was found in
  Agent Control's active source or skills during this review.
  [Changelog](https://learn.chatgpt.com/docs/changelog).

Other useful recent features include the CLI usage dashboard, fullscreen history
navigation and voice, plus website tools through WebMCP. Event-triggered tasks
from Gmail, Slack and GitHub belong to eligible ChatGPT surfaces; their existence
does not imply that this local task has those integrations enabled.
[What's new](https://learn.chatgpt.com/docs/whats-new),
[Changelog](https://learn.chatgpt.com/docs/changelog).

## Local model migration

The bundled Agent Control catalog and agent-settings HDT policy now agree:

| Role | Model | Reasoning |
| --- | --- | --- |
| Context | `gpt-6-luna` | `max` |
| Analyst | `gpt-6-astra` | `xhigh` |
| Planner, implementer, integrator, final reviewer | `gpt-6-sol` | `xhigh` |
| Mechanical validator | `gpt-6-luna` | `high` |

Worker defaults, demo flow bindings, new-agent drafts, skill examples and HDT
templates use the new Sol/Luna IDs. Explicit overrides and Astra are preserved.
Existing saved personal agents, project overrides and running flow snapshots are
not rewritten. Historical pricing and compatibility fixtures remain valid.

The canonical private instruction-optimization skill also routes Sol/Luna to the
GPT-6 IDs, with a refreshed profile and a dated official-source dossier. Its
historical GPT-5.6 research remains unchanged. Local package versions are
Agent Control 0.2.25, development-workflow 0.1.25 and instruction-optimization 0.1.1.

At the initial review, terminal `codex` was 0.146.0 and its effective catalog did not list the new
IDs. The desktop application's bundled CLI is 0.155.0-alpha.16.3 and lists both
with `visibility=list`. Agent Control's default runtime resolver selects that
bundled executable when present, unless explicitly overridden. Catalog discovery
does not prove a successful model execution.

## Verification and delivery state

- Agent Control: 109 focused tests across model resolution, worker defaults,
  pricing and the simulated development lifecycle passed.
- Web: 25 agent-definition tests and the production build passed.
- Backend TypeScript checking and compilation passed; the compiled worker and
  static web runtime were synchronized with the source changes.
- Pricing refresh parser: six existing tests passed.
- Agent-settings: the plugin validator passed all 59 tests; all seven HDT role
  model/effort pairs match Agent Control.
- Instruction-optimization: plugin and both skill validators passed, and all
  29 local documentation links resolve.
- An additional general backend test run was not green. It exposed
  `codex-subagent` start-metadata failures outside the model migration. An obsolete
  model assertion observed during that run was corrected and passes in the
  focused run. Independent review reproduced one bridge failure with controller,
  adapter and fixture bytes identical to the initial checkout: the flow sends
  metadata keys that its native-subagent validator rejects. That failure predates
  this migration; the remaining general-suite failures were not individually
  attributed. Do not interpret focused results as a clean full-suite result.

At the initial review, model-policy changes were local and unpublished and their
installed plugin snapshots had not been refreshed. Pre-existing repository
changes were retained. No paid model execution was performed. The publication
and installation below supersede that initial delivery state.

## Rocket failure follow-up

The pinned Rocket task's original analyst launch used standalone Codex 0.146.0,
which rejected GPT-6 Astra. Its retry against an older desktop app-server build
returned `Not initialized`. The latter could not be reproduced with desktop
0.155.0-alpha.16.3: five sequential and 50 concurrent initialization/model-list
checks passed without creating threads or running models.

Reading the failed analyst through the installed Agent Control MCP reproduced
`paginated threads do not support thread/read(includeTurns=true)`. The adapter
now opts into experimental API support and handles that specific rejection with
a metadata read followed by `thread/turns/list` pages with full items. It preserves
chronological order, rejects repeated cursors, and never resumes a worker to read
history. Existing legacy reads and unrelated errors retain their behavior.
[App-server pagination](https://learn.chatgpt.com/docs/app-server#threads).

The official `codex update` upgraded the standalone CLI to 0.156.1. With no
threads loaded in the shared daemon, `codex app-server daemon update --from-cli
--yes` replaced and restarted it. Both installed and running daemon versions
are verified as 0.156.1. This explicitly pins the daemon package; future daemon
upgrades must use the supported updater. Its live model list includes GPT-6
Astra, Sol and Luna, with Luna supporting up to `max`.

Before publication, only the adapter source and compiled adapter were overlaid into the installed
Agent Control 0.2.24 cache. The marketplace identity and published version remain
unchanged; this is a local compatibility overlay, not a published 0.2.25 release.
Original files and SHA-256 fingerprints are retained under
`~/.agent-control/backups/codex-pagination-20260923-223701/`.

Verification: 32 adapter, interactive CLI and access-policy tests passed, including
three pagination regressions; TypeScript compilation passed. A fresh installed
MCP process exposed 94 tools and read the failed analyst successfully. The
current task's MCP also successfully read it after the daemon update: 0.156.1
accepts the legacy full-history read for this thread again, while the adapter's
fallback was verified against the previous daemon. All four
worker-facing flow tools already have explicit approval grants; configuration
was unchanged. Rocket's task, run ownership and failed analysis were not resumed
or modified. A successful new model execution remains unverified.

## Published and installed migration

The user authorized publication and installation. The following personal
marketplace commits are published on `origin/main` and installed/enabled:

| Plugin | Version | Commit |
| --- | --- | --- |
| Agent Control | 0.2.25 | `4aaf0a725debc1efd2f1994fa0d082a4aa47ee80` |
| Development Workflow | 0.1.25 | `82a849e30c27c09a6f1f9d56c0c8a58e068a37be` |
| Instruction Optimization | 0.1.1 | `f342f8afeb9927d744959f4233f0067734a0f546` |

Each commit was assembled and validated independently of unrelated dirty
changes. Agent Control's exact release snapshot passed 139 backend tests,
25 web tests, six pricing-parser tests, backend compilation and the production
web build. Development Workflow's release snapshot passed 58 tests.
Instruction Optimization passed the plugin and both skill validators and
29 local Markdown-link checks. Different earlier test counts include pending
unrelated tests that were deliberately not published.

All 448 Agent Control, 141 Development Workflow and 18 Instruction Optimization
installed files match the published snapshots. The installed Agent Control
catalog and HDT policy agree on all seven role/model/effort pairs. `agentctl`
points to 0.2.25; its command help, flow catalog and packaged evidence provider
checks pass. A fresh installed MCP process reports version 0.2.25, exposes
94 tools including every required launch/flow/question capability, and reads
the failed Rocket analyst successfully.

Existing flow snapshots and explicit project/agent overrides retain their
selected models. New tasks load the updated bundled skills; this publication
does not prove that already-open tasks have replaced their earlier instruction
context. No worker was launched solely for installation verification.
