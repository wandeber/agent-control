# Agent Control Flow Patterns

This guide describes the recommended semantics for declarative Agent Control
flows. Keep workflow state in flow instances, step reports, artifacts, and
events. Use visual links to explain what happened, not to decide what happens.

## Source Of Truth

- Flow config: roles, steps, artifacts, report schemas, and transition rules.
- Flow instance: active step, completed steps, selected transitions, blockers,
  and terminal status.
- Artifacts: real documents with named current aliases and immutable revisions.
- Evidence: provider-issued receipts for exact plans/results, semantic reviews,
  controlled validation, and closure.
- Decisions and state: revisioned acceptance, content-bound human approval,
  owner continuity, and declared historical milestones.
- Events: compact runtime facts such as `flow.step_started`,
  `flow.step_reported`, `flow.transition_selected`, `flow.notification`, and
  `flow.step_blocked`.

Agent links are a visual/explanatory layer. They can show parent-child,
handoff-like, subscription-like, and blocking relationships, but they are not
the state machine.

## Transitions

Use `on.reported` when a worker has written its required artifacts and reported
a structured result. This is the normal step-to-step path.

Prefer deterministic `to: "<step-id>"` transitions when the config can express
the routing safely from reported fields. For example, a classifier can report
`{"size":"s"}` and the config can route small tasks to a lightweight worker.

Use `notify: "orchestrator"` when a human or high-intelligence coordinator must
decide what happens next. This is appropriate for ambiguous blockers, final user
confirmation, or decisions that need information outside the flow config.

Use `finish: true` only when the flow is complete after the current report.

Do not encode workflow state with `waits_for`. A step is ready because a
transition activated it and required input artifacts exist, not because a visual
wait edge exists.

## Reports

Report schemas should include only the fields needed for routing or diagnosis.
Do not bake one workflow's domain labels into Agent Control itself; keep those
labels inside the flow config.

Workers should report through Agent Control tools or CLI using the generated
reporting contract. If a worker cannot produce valid structured data, Agent
Control should mark the step blocked and notify the configured owner instead of
guessing.

Use `status: "completed"` whenever the required artifact was written, even if a
structured conclusion routes to a correction or blocker step. Use `blocked`,
`failed`, or `cancelled` only when the worker cannot write the required artifact
or cannot produce a valid report.

## Artifacts

Model every handoff file as a named artifact. Steps declare `inputs` and
`outputs`; runtime contracts pass the resolved paths to workers.

Do not ask coordinators to create or rewrite step artifacts. If a worker
terminates without a required artifact, the step should block or the same worker
should be asked to write the missing artifact from its own work.

## Subscriptions And Notifications

Subscriptions deliver events to active observers; delivery alone does not prove
that an ended Codex turn resumed. They are useful for:

- notifying an orchestrator about `flow.notification` and `flow.step_blocked`;
- notifying a directly responsible owner after a worker terminal event;
- delivering goal confirmation prompts after descendants are terminal.

Subscriptions are not a substitute for transition rules. If the next action is
fully described by the flow config, let `flow_continue` dispatch it without
waking the orchestrator.

## Orchestrator-Driven Pattern

Use this when model quality, user confirmation, or ambiguity matters more than
full automation:

```yaml
steps:
  review:
    role: reviewer
    outputs:
      review:
        artifact: review
        required: true
    "on":
      reported:
        notify: orchestrator
```

The orchestrator receives a compact notification and then chooses a configured
step with `flow_step_start` or stops for user feedback.

When `flow_step_start` returns work to a worker, put the complete correction,
newly clarified user answer, or approval context in `reason`. Agent Control
records that reason and the source report as the causal handoff. Persist a
material clarified objective with `flow_context_update` before resuming; its
durable acceptance revision survives automatic transitions. Do not use an
opaque routing label when the worker needs a concrete correction.

## Automatic Routing Pattern

Use this when a worker can reliably report a small structured routing value and
the flow config knows all possible routes:

```yaml
steps:
  classify:
    role: classifier
    report:
      schema:
        size:
          enum: [s, m, l, xl]
    "on":
      reported:
        transitions:
          - when:
              equals:
                var: result.size
                value: s
            to: small_worker
          - when:
              equals:
                var: result.size
                value: m
            to: medium_worker
          - when:
              equals:
                var: result.size
                value: l
            to: large_worker
          - when:
              equals:
                var: result.size
                value: xl
            notify: orchestrator
```

If the worker reports a value that does not match the schema or no transition
matches, block and notify the configured owner.

## Review/Correction Loop Pattern

Use loops only when the report value names the needed correction route:

```yaml
steps:
  validate:
    role: validator
    report:
      schema:
        conclusion:
          enum: [approved, needs_correction, blocked]
    "on":
      reported:
        transitions:
          - when:
              equals:
                var: result.conclusion
                value: approved
            to: final_answer
          - when:
              equals:
                var: result.conclusion
                value: needs_correction
            to: implement
          - when:
              equals:
                var: result.conclusion
                value: blocked
            notify: orchestrator
```

The loop is explicit in the config. The coordinator does not infer it from chat
history or visual edges.

## Strict Evidence And Human Gates

A strict flow separates routing claims from evidence. `policy: { strict: true }`
enables its declared revision, owner, and receipt checks. Use `requires` on an
activation and `requires_evidence` on the target or transition. A receipt guard
names its reference, expected kind, currentness, and approval requirement:

```yaml
requires_evidence:
  - receipt: evidence.validation
    kind: validation
    require_current: true
    require_approved: true
    validation_mode: complete_gate
    owner_role: validator
```

The evidence registry is populated by verified `flow_evidence` operations.
`result.evidence_receipt_id` can reference the reporting worker's receipt when
selecting a transition; it does not make the receipt valid. The provider checks
its exact snapshot, actor/gate, provenance, and required evidence. Do not trust
nested `approved` or `evidence_valid` values supplied by the worker.

Use `execution: coordinator` and `decision: { key: plan_approval,
authority: user, owner: requester, artifact_key: plan }` for an explicit plan decision. No worker is dispatched. A coordinator-only intention check
uses `authority: coordinator` with the appropriate original `owner: requester`
so it does not ask the user for a redundant
decision. `flow_decision` records the authorized value and current revision, then routes
its generated `result.decision`. Current decisions are filtered by acceptance
and bound artifact revision; a changed plan cannot inherit its old approval.
Neither a timeout nor `flow_step_start` is an approval.

Transition `set` records configured milestones only after report validation.
For example, `planner_approved: true` can preserve a first conformance approval
so expert corrections bypass an unnecessary planner pass. That history is not
proof that later code remains identical. Current validation and expert receipts
still govern closure.

Reviewers submit direct semantic decisions, dependencies, and prior finding
dispositions. The evidence provider composes complete ledgers with eligible
unchanged coverage, returning compact receipts. First review is full; changed
or dependent scope reopens. Context loss or unbounded impact requires full
review by the same owner. A changed finding ID does not hide a recurring issue.

Keep mechanical modes distinct: focused checks diagnose a correction bundle;
a complete gate covers all affected packages, transitive consumers, mandatory
checks, and material risks. Resolve reuse candidates in a batch, run only misses,
and join all required outcomes before advancing. Reuse requires intact GREEN,
non-volatile execution evidence with exact declared identity. Parallel commands
must have disjoint mutable resources. A focused pass never replaces the final
complete gate.

Only real documents need artifact files. Use structured runtime records for
control reports, ledgers, decisions, check outcomes, and closure; generate a
human-readable view only when useful. The bundled development flow's
[phase contract](../flows/development-flow-v1/README.md) documents ownership,
omission, and correction policy without adding a worker for every phase.

## Role Agent Lifecycle

Roles reuse one persistent Agent Control agent by default. Use that `reuse`
lifecycle for an independent review gate that can loop through corrections:
the backend worker is created with clean context when the role is first
dispatched, and every later review iteration resumes that exact reviewer.

```yaml
roles:
  final_reviewer:
    backend: codex-thread
    agent_lifecycle: reuse
```

Declare `agent_lifecycle: fresh_per_step` only when every new step instance
intentionally requires a different agent and backend context. Do not use it for
an iterative independent-review gate, because that would replace the reviewer
after each correction instead of preserving review ownership.

Fresh-per-step roles are not pre-registered. Dispatch creates one deterministically
titled agent for the concrete step instance, without copying a backend handle;
for `codex-thread`, that means a new `thread/start`. Redispatching that same
step instance reuses its durable agent assignment (and any open native action),
while a transition to a new instance of the same step creates a different
agent. Do not combine `fresh_per_step` with a step-level `agent_id`, because a
persistent explicit agent would contradict the lifecycle.

## Native Codex Subagent Bridge Pattern

Use `backend: codex-subagent` only when a visible root Codex coordinator owns
the run and can execute native collaboration tools. A native-only role can set:

```yaml
roles:
  implementation_worker:
    backend: codex-subagent
    model: ""
    backend_options:
      codex_subagent:
        fork_turns: none
```

`model: ""` means inherit the root model; nonempty model overrides are not
supported. `fork_turns` accepts `none`, `all`, or a positive integer string and
defaults to `none`. Do not attach dormant `backend_options` to a role whose
resolved backend is not `codex-subagent`; validation rejects that mismatch so
the declared config cannot silently differ from the native operation.

The root coordinator is the only bridge executor. For each claimed action it
maps `spawn_agent`, `send_message`, `followup_task`, or `interrupt_agent` to
exactly one tool call with the same name and then acknowledges the result.
Workers implement their assigned step and report; they never coordinate
sibling agents.

If a spawn outcome is uncertain, recover before retrying: use `list_agents`
with the expected task path, reuse an exact match, and call
`agent_external_sync`. On the CLI path, `flow launch` persists the scoped
credential privately and returns only `bridge_grant.bridge_grant_id`. Pass that
reference through `--bridge-grant` to continue, dispatch, claim, and
external-sync commands. `action claim` likewise persists its one-time action
token, and `action ack --action <id> --status <status>` resolves it locally.
Raw token flags are advanced-only and normal CLI output never prints their
values.

Tokens and grant/claim references are root control state; never include them in
prompts, chat, logs, UI, artifacts, events, reports, summaries, or worker
messages. Keep the private claim envelope off those public surfaces and pass
only its declared arguments to the exact native tool. The worker receives its
intended task message, never bridge/action control data. A missing, revoked,
expired, unsafe, or ambiguous credential blocks the flow instead of triggering
a new login or broader fallback. After dispatch, the conversational thread
consumes `run_wait` and keeps the turn open while work remains. A separate
executing root that still supervises work follows the same policy; notification
delivery does not reliably reactivate an ended Codex turn.
`wait_agent` remains reserved for explicit native diagnostics; it is not the
Agent Control run event stream.

## Initiating Thread Observation

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


Identify the conversational requester in the run before dispatching either
free workers or a declared flow. The coordinator registers its own thread;
the launch operation attaches the requester separately when those identities differ.
One thread serving both purposes reuses its existing agent record. Observation
does not grant native bridge ownership and does not make the conversation a
worker that run shutdown should interrupt.

`agentctl flow launch` and `agentctl worker launch` accept
`--requester-thread-id`, repeated `--requester-event`, and
`--requester-delivery wait|notify`. They attach observation before dispatch and
return its control record. Forward the original requester identity through
nested delegation instead of replacing it with the executor's current thread.
The MCP `worker_launch` and `flow_launch` tools do the same in one call,
including local authorization and detached supervision. Lower-level
`agent_start` and `flow_start` also ensure observation before execution.
`run_observe` remains useful for an additional observer or explicit filter
changes; it is not a launch prerequisite.

The original requester is persisted in the run and inherited from parent runs
or the authenticated caller's run before consulting the executor environment.
An explicit requester overrides automatic resolution. Otherwise
`AGENT_CONTROL_REQUESTER_THREAD_ID` precedes `CODEX_THREAD_ID` as the final
fallback. Hosts without a conversation must supply a real requester identity;
headless operations never fabricate one. Reusing a run preserves its observer
filters and does not replace the original requester with a nested executor.

The default `wait` mode uses `run_wait` with the returned durable cursor,
without a timeout or with `timeout_ms: 3600000` (`--timeout 1h` in the CLI).
Consume the batch, retain its new cursor, and resume the long wait. Timeout is
not completion. Preserve the last processed cursor when reusing a launch.
When the user asks something else, answer in commentary and resume event waiting
in the same open turn. Do not cancel or forget the original work. Retain each
active run, observer, completion condition, and its own cursor. Where supported,
wait on active runs concurrently; closure of one observation does not close the
others. End only after all supervised work is resolved or the user explicitly
pauses or cancels supervision. A short localized update may mention that the
flow is still running and the conversation is returning to the wait.

`observer.wait_contract` on launch and `wait_contract` on open event/timeout
responses provide `run_wait` arguments with a one-hour timeout. A host that
requires a shorter wide timeout may use 30 minutes. The contract includes the
current response cursor; acknowledge it only after processing that batch. After
interruption, resume from the last processed cursor. A closed observation returns
`wait_contract: null`; check the remaining active runs before ending the turn.
By default every supported event type is selected, covering present and future
agents in the run, including phase changes, blockers, and completion. A completion-only flow observer uses
`flow.completed`; a free-worker observer chooses its agent terminal events.

Explicit `notify` delivers a compact informational injection to the requester.
It never falls back to starting a competing turn. Acceptance means context was
appended, not that an idle thread resumed. Use waiting for reliable event
wakeups. Delivery failure preserves the event for cursor-based consumption. Native action notifications do not
instruct the observer to claim the executor's bridge. Same-thread observation
must not create a second copy of the owner's delivery.

## Visual Relationships

Render relationships from actual records:

- `parent_child`: who launched or owns a worker;
- `handoff`: configured step-to-step or role-to-role flow relationship;
- `subscribed_to`: who receives which event from whom;
- `blocks`: current blocker explanation.

Avoid `waits_for` for workflow meaning. If a future UI wants a dependency view,
derive it from active step inputs, selected transitions, and subscriptions
rather than storing it as control state.

The agents view defaults to the selected agent's incoming and outgoing
relationships, or the active phase worker when no agent is selected. Other
agents retain main declared phase connections (or real structural links for
free workers). One connection per unordered pair combines all visible relation
types and conditions. Each endpoint has an arrowhead only when at least one
relation points toward it. Connections meeting the same side of a card share
one centered junction and one arrowhead when any branch points into the card.
Incoming and outgoing branches can share that junction; its popover retains
all their directed relationships. Hovering or focusing a line reveals the directed
relationships; clicking or pressing Enter keeps the popover open. Connection
styles do not encode combinations of relationship types.

Workers appear inside a Team frame; orchestrators and observers stay outside,
including after cards move. A relationship type that connects an outside role
to every current member uses the Team header as its endpoint. Its detail keeps
each original member, direction, and condition; this does not imply coverage
of future members. Explicit subscriptions with no source-agent filter target
the Team directly and do cover future members. Members can subscribe through
the inside of the shared header. Particular relationships remain attached to
individual cards. The dashboard includes applicable subscriptions with no run
filter and preserves each enabled event filter rather than inferring scope
from an observer's union of event types.

Cards show state, current or last phase, and a public activity line; technical metrics remain in the inspector. Activity is the latest public
output or tool use, including a completed tool. Running/completed labels come
from observed item state, never inferred private reasoning. Native workers
publish an explicit `public_activity` through external sync; private
`latest_message` content stays out of the card.
