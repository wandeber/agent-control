# User Questions

The conversation receiving the user's request owns clarification and actual
user decisions. A worker can ask directly through Agent Control's `question_ask`
when available: its questions appear in the shared Full Console inbox and the
owning chat, with badges on the agent and room. Use your own registered
`agent_id`, a stable `request_key`, a short `title`, and one to three `questions`
with stable `id`, complete `prompt`, and optional answer `options` (`id`, `label`,
optional `description`). Free text is always available. Use authenticated native
identity or your own runtime credential; never copy credentials into prompts.

By default `question_ask` waits up to one hour and returns the actual saved
answers (`option_ids` and `text` by question id). Use `wait=false` for independent
work, then `question_wait`. Recover with `question_get` or `question_list`; after
a timeout or cancelled transport, resume the existing question's wait instead
of creating another request or ending the turn while required work is pending.
The user may answer from any visible room. Answers do not start another worker
turn. `question_answer` is for the verified requester/operator to relay an
answer the user actually gave, never for a worker to choose on their behalf.

Pass material answers back through the configured clarification route so the
original conversation records them in accepted flow context before dependent
work. If direct questions are unavailable or access is denied, report the
question and its consequences through that route for the original conversation
to ask. A worker or separate executing coordinator must not invent the answer.
Clarification does not approve backend permissions or content-bound flow gates.

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
