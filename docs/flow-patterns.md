# Agent Control Flow Patterns

This guide describes the recommended semantics for declarative Agent Control
flows. Keep workflow state in flow instances, step reports, artifacts, and
events. Use visual links to explain what happened, not to decide what happens.

## Source Of Truth

- Flow config: roles, steps, artifacts, report schemas, and transition rules.
- Flow instance: active step, completed steps, selected transitions, blockers,
  and terminal status.
- Artifacts: named inputs and outputs referenced by steps.
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

Subscriptions wake agents on events. They are useful for:

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
              result.size: s
            to: small_worker
          - when:
              result.size: m
            to: medium_worker
          - when:
              result.size: l
            to: large_worker
          - when:
              result.size: xl
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
              result.conclusion: approved
            to: final_answer
          - when:
              result.conclusion: needs_correction
            to: implement
          - when:
              result.conclusion: blocked
            notify: orchestrator
```

The loop is explicit in the config. The coordinator does not infer it from chat
history or visual edges.

## Visual Relationships

Render relationships from actual records:

- `parent_child`: who launched or owns a worker;
- `handoff`: configured step-to-step or role-to-role flow relationship;
- `subscribed_to`: who receives which event from whom;
- `blocks`: current blocker explanation.

Avoid `waits_for` for workflow meaning. If a future UI wants a dependency view,
derive it from active step inputs, selected transitions, and subscriptions
rather than storing it as control state.
