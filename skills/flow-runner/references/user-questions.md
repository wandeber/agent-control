# User Questions

The conversation receiving the user's request owns clarification and actual
user decisions. A worker reports a missing decision and its consequences to
that conversation through the configured clarification/blocker route. A worker
or a separate executing coordinator must not answer on the user's behalf.

Review the request, prior answers, and repository evidence before asking. Raise
unresolved choices about desired behavior, users, scope, acceptance, and material
tradeoffs while establishing context or planning, before committing to one
interpretation. Do not wait until execution is blocked, silently invent a
requirement, or treat a technical implementation choice as a user decision.
Resolve repository facts through inspection. Reuse answers already given; new
evidence warrants a follow-up only when it changes the decision.

Use an available native question interface that is callable in the current
host and mode. Prefer `request_user_input_async` when available so independent
work can continue. Use `request_user_input` only in modes where it is supported;
its name appearing in a catalog does not make it callable. Another supplied
question interface is suitable when its declared purpose covers the task. If
none is usable, ask directly in text. An unavailable UI is not a reason to omit
a needed question or switch modes merely to obtain a popover. Do not use a
question tool for permission or approval when its contract forbids that purpose.

Group related questions in a small coherent batch within the tool's limits.
Give concrete options, a recommended choice when justified, and their practical
consequences; allow a different answer. Use free text for facts that cannot be
represented honestly as options. Ask as many questions as the unresolved
decisions warrant. Do not add a redundant "Other" option when the interface
already provides a free-form answer. Ask without a quota or a generic questionnaire.
A recommendation, preselected default, silence, timeout, or empty result is not
a user answer.
Keep required decisions pending and continue only independent authorized work.
For a genuinely optional preference, state the assumption if proceeding; never
record it as an answered question or an approved decision.

Persist actual answers and explicit assumptions distinctly in `acceptance_context`
or `flow_context_update` before dependent dispatch. Carry material decisions,
constraints, and unresolved questions into the affected phase and package
handoffs. Keep the existing exact-content approval and requester ownership
contracts; clarification does not replace plan approval.

For example, ask which users and visible outcomes a vaguely requested dashboard
must support before designing it. For a software change, material evidence of
valued data or production may require asking whether old data can be lost/recreated
or must be converted. Existing development records alone do not mandate preservation;
prefer a fresh-data design when simpler, keeping normal ORM/schema migrations.
That design does not authorize executing destructive database actions.
A clear task on a confirmed unreleased prototype needs
neither a repeated lifecycle question nor invented compatibility work.
