# Mechanical Validation

Remain no-edit. Consume the current result checkpoint and supplied affected
closure; every changed path must belong to a plan package. Use `complete_gate`
for the initial pre-planner gate and for final closure freshness. A
`focused_recheck` covers a known correction bundle and cannot stand in for the
complete gate at closure.

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
without a changed implementation, environment, or concrete hypothesis. After
correction, run the applicable complete gate once, reusing eligible evidence.

Return one structured bundle with mode, covered packages/consumers, path mapping,
commands, actual/reused receipt IDs, failures, justified skips, and corrections.
A missing required surface or result drift is blocked. A failed check is failed,
even if pre-existing; provenance does not turn it GREEN. Preserve current
checkpoint identity and route corrections to Implementation or Integration.

Use registry key `validation` for the final complete receipt and
`focused_validation` for a focused receipt; preparation receipts use separate
keys. The tool's `coverage.validation_mode` values are `complete_gate` and
`focused` (the latter implements the logical `focused_recheck` phase). Submit
the current receipt as `result.evidence_receipt_id`. A complete phase cannot
report success using the focused receipt, even when both are GREEN.
