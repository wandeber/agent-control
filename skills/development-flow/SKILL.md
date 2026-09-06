---
name: development-flow
description: Run the Agent Control development-flow-v1 workflow with user-owned intent, exact plan approval, incremental evidence, delegated implementation, optional UAT, and independent verified closure. Use for a requested flow or substantial coordinated software work.
---

# Development Flow

Use catalog flow `development-flow-v1` and `flow-runner` for execution. This
skill owns the visible conversation's clarification and decision responsibilities;
the configured runtime owns phases, evidence, routing, and worker continuity.
Editing or discussing the flow does not itself request a flow execution.

## Establish Acceptance

The conversation receiving the request owns clarification. Preserve that
thread's identity when another coordinator executes the run. Do not delegate
clarification or create an `orchestrator` worker to impersonate the conversation.

Use the request, prior decisions, and applicable constraints to establish goal,
requested behavior, scope, acceptance criteria, exclusions, and confirmed
choices. Ask only for unresolved user decisions that materially affect those
items. Repository facts belong in Context; harmless explicit assumptions and
technical decisions already delegated to the team need no approval question.
Group related required questions and wait for answers before dependent work.
Do not manufacture a requirement to ask about every imaginable interpretation.

Capture the normalized acceptance context at launch. Later material clarification
uses `flow_context_update` with the current revision; a transient transition
reason or run title is not its durable replacement. Preserve prior decisions
and attach the concrete correction cause when resuming. Changed intent or plan
invalidates the dependent approvals; unchanged valid approval is reusable.

## Launch And Observe

1. Discover `development-flow-v1` through `flow_catalog_get`, then
   `flow_catalog_list` if needed. CLI fallback is `agentctl flow catalog get
   --flow development-flow-v1`. Do not search for a path before discovery.
2. Immediately before the first launch, call `open_agent_control_console` once
   without a `run_id`. It opens in `follow_latest` mode. This native MCP App
   tool is required; if unavailable or failed, report that exact blocker before
   dispatch. Do not replace it with a browser or web-console fallback. Never
   reopen it on notifications, retries, or resumption.
3. Call `flow_launch` once with the discovered flow and complete acceptance
   context. Launch automatically registers the original conversation and its
   all-event subscription. Forward its original requester identity through
   delegation; do not add routine login, worker registration, or subscription
   calls. Preserve returned run, flow, observer, cursor, and completion condition.
4. Follow `flow-runner` to dispatch, process events, and execute only required
   coordinator decisions. Do not write worker artifacts or reconstruct reports.

Keep the launching turn open while any supervised work remains. Use `run_wait`
with the last processed cursor, indefinitely or with a one-hour timeout (30
minutes when required by the host). Answer new user messages in commentary,
including other topics, then resume the wait. Preserve every active run and
independent cursor. Notification delivery cannot reliably awaken an ended Codex
turn. The same rule applies to a separate coordinator with pending supervision.
A concise update may end with a localized sentence such as: "The development
flow is still running; I am continuing to wait."

## Coordinator Decisions

Use `flow_decision` for configured decision steps. Consume the generated gate
contract and current revision; never infer approval from a timeout, a worker's
`approved` label, or the absence of an objection.

- **Analysis intent:** the exact clarification owner compares current Analysis
  with accepted user intent. Record approval or a concrete correction. Keep
  this check narrow: it is not another technical expert review. If execution
  is elsewhere, its coordinator waits for this owner's decision.
- **Exact plan approval:** after strict approval by the same Analysis owner,
  present the current plan and record the user's decision bound to its current
  artifact digest. Existing explicit approval of that exact content suffices;
  do not ask again. Changed plan content needs analyst review and renewed user
  approval before implementation.
- **Optional UAT:** apply a preference already stated by the user. Otherwise ask
  once after the first planner approval whether to prepare UAT or continue to
  final review. Record `prepare` or `skip`. Prepare the environment only when
  selected, wait for actual user observations, and record the result. Do not
  repeatedly ask on expert corrections or pretend preparation means approval.
- **No progress:** on the second recurrence of the same underlying issue without
  material progress, or incompatible correction approaches, preserve the
  findings and ask for a concrete approach decision. Normal actionable findings
  continue automatically. Honor an explicit single-review-only instruction.
- **Closure:** run `flow_evidence` operation `verify_closure` under key `closure`
  with current expert and complete validation receipt IDs, then submit the
  coordinator closure report with `conclusion: verified`. Finish only when strict
  expert approval and GREEN complete mechanical evidence cover the unchanged
  current result and all earlier user/workflow gates remain satisfied.

## Phase And Evidence Policy

Context and Analysis share an analyst with distinct responsibilities. The same
analyst reviews the plan, and the exact planner reviews implementation until
its first approval. Integration runs only when multiple outputs need it.
Mechanical Validation is a separate no-edit phase. The independent expert starts
with clean context and remains the same owner through corrections.

The first planner approval is permanent history; expert or UAT corrections go
through affected validation and back to the same expert without another planner
pass unless the user explicitly requests it. A historical milestone does not
prove that later code is unchanged. Route each root issue to the earliest phase
that must change; material plan changes still require their own approvals.

Use `flow_evidence` operations and compact receipts from generated contracts.
The model decides semantic scope, dependencies, and findings; tools snapshot,
calculate deltas, compose eligible closed evidence, execute checks, and verify
closure. Do not rewrite full ledgers, copy the helper into a prompt, or create
Markdown solely to transport structured reports. Reuse immutable references and
send continued owners only new directives, relevant changes, and pending scope.

Keep testing proportionate. Reuse adequate coverage, execute focused correction
checks, and run the relevant complete affected gate once when needed. Do not
impose TDD, duplicate suites, one test per requirement, or additional tests merely
to create cache entries. Real context loss, missing evidence, or unbounded impact
requires full review by the same owner; owner loss blocks rather than silently
substituting a reviewer.
