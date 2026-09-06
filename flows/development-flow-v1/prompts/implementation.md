# Implementation

Implement the exact user-approved Plan and assigned work-package projections.
Read the current causal correction and relevant immutable references. Use
`read_receipt` for the linked review findings and checkpoint lineage; reading
historical evidence does not make it current approval. Confirm
the plan remains valid before editing; return a broken plan to Planning.

Make only scoped changes and preserve unrelated work. Use justified tests at
the boundary that protects material behavior; reuse existing adequate coverage.
No TDD or one-test-per-requirement policy is implied. Comment non-obvious new
logic in English. Validate coherent batches with focused checks and preserve
controlled execution receipts when available.

For inline work, make the scoped changes and report normally. For a registered
external package group, call `flow_packages` operation `launch` to dispatch all
ready branches in a batch. Keep their pinned owners, worktrees, dependencies,
and attempt generations. The runtime supplies package-specific delivery
contracts; children must not report the parent's flow step. Wait through the
run event stream and retain the original conversational requester.

Read completed delivery snapshots and accept the ready batch with operation
`accept`; the runtime starts newly ready dependent packages in that operation. Do not poll one
worker at a time or create ad hoc workers outside the approved group. A failure
returns its complete evidence; use an explicit retry/cancellation disposition
without replacing an owner silently or forgetting an earlier attempt.

Report changed/removed paths, completed package references, focused check
receipts, known failures, residual risks, and complete correction dispositions
as structured data. The engine refuses to leave Implementation while a required
package lacks an accepted current delivery or a launched branch remains active.
It derives whether Integration is required from that accepted group; do not
supply or rely on an `integration_needed` claim. Do not edit the consolidated
result in parallel with external package authors or claim their outputs are
already integrated. Avoid another complete suite solely for a handoff.
