# Mechanical Validation

Remain no-edit. This single Validation phase handles both initial work and
corrections. Consume the current result checkpoint, supplied affected closure,
current correction, and relevant prior findings. Preserve unresolved findings
and changed-path coverage until verified; a partial check does not clear them.
Resolve receipts with `read_receipt`; reuse the checkpoint while the result
remains unchanged across checks within this phase. Create a new
checkpoint ID only for a new snapshot, with the previous ID when lineage is
valid. Checkpoints are immutable: do not call preparation again using an
existing checkpoint ID. Every changed path must belong to a plan package.
Use the current snapshot rather than assuming a historical receipt is fresh.
Validate the approved current behavior and confirmed compatibility obligations;
do not invent old-client coverage or data-conversion checks for hypothetical
legacy support. Accept normal ORM/schema migrations and an approved design using
recreated development data. That design does not authorize resetting a database
to run checks: use safe fixture boundaries and report a required unsafe check
as blocked.
Use `complete_gate` evidence before reporting success, including after a
correction and when refreshing closure evidence. Focused checks are optional
diagnostic operations within this phase, not a separate stage or mandatory
preliminary pass. They cannot stand in for unexecuted complete affected coverage. A failed focused check
can report `failed` with its current receipt and return the correction bundle
to Implementation; a failure does not require a complete success receipt.

Resolve existing expensive check candidates together. Reuse only intact GREEN,
non-volatile receipts with exact canonical result, command, working directory,
inputs, toolchain, configuration, and relevant environment/service identity.
Execute cache misses through the runtime evidence operation. Missing identity
means execute, not assume. Do not create extra checks merely to populate cache.

Run independent commands concurrently only when their ports, locks, databases,
build outputs, and other mutable resources are disjoint. Keep conflicting checks
sequential. After a failure, collect remaining independent failures; avoid
restarting an aggregate command whose independent surfaces already ran.

Use the narrowest coherent check set during diagnosis, including the smallest
ordered sequence for order-dependent failures. Never repeat a failed command
without a changed implementation, environment, concrete hypothesis, or the
isolated-test recovery below. After correction, validate the applicable affected
coverage, reusing eligible evidence.

When a complete run has test failures, rerun the failed cases in isolation with
unchanged assertions and relevant configuration. If all pass, continue without
another complete run, a new waiver, or proof of the flaky root cause. Preserve
the failed full receipt and create passing `focused` receipts with unique check
IDs for the actual isolated reruns. Use `validation_resolve_isolated_tests` with
`validation_receipt_id`, `isolated_receipt_ids` and `isolated_test_resolutions`
from the canonical mechanical-validation contract. Register the composed
`complete_gate` receipt as `validation` and report its distinct conclusion
`accepted_with_isolated_test_passes`. Never relabel the original failures GREEN.
Still-failing isolated tests and non-test failures require correction; run any
missing mandatory checks without repeating already covered work. Do not skip
cases or weaken assertions/configuration to produce a pass.

Return one structured bundle with mode, covered packages/consumers, path mapping,
commands, actual/reused receipt IDs, failures, justified skips, and corrections.
A missing required surface or result drift is blocked. A failed check is failed,
even if pre-existing; provenance does not turn it GREEN. Preserve current
checkpoint identity and route corrections to Implementation or Integration.

Use registry key `validation` for the final complete receipt; optional focused
checks and preparation receipts use separate keys. The tool's
`coverage.validation_mode` values remain `complete_gate` and `focused`. Reuse
eligible focused results when composing complete evidence in this same phase.
Submit the current complete receipt as `result.evidence_receipt_id`; a focused
receipt alone cannot satisfy the success transition even when its checks are
GREEN; the verified complete receipt may be `passed` or
`accepted_with_isolated_test_passes`.

When refreshing a complete gate after expert approval, read the registered
`final_review` receipt. Set `result.request_closure: true` only when that strict
approval covers this unchanged result and the same current plan/acceptance,
with no unresolved semantic correction. This requests a guarded route; the
controller rechecks the exact expert owner and both current receipts, and
closure verifies their common result. It is not a new semantic approval.
For missing, rejected, changed, or uncertain expert evidence, omit the flag or
use `false`; the existing route returns to the same expert after prior gates.
A focused receipt never authorizes closure. If a guard rejects a reuse request,
report the observed blocker to the coordinator; do not retry with weaker proof.
