# Integration

Consolidate the exact accepted delivery group into one coherent result. This
phase is required whenever work arrived from an external worktree, even a
single package. The engine joins all required current deliveries before entry;
read their immutable references and preserve the approved plan and unrelated
work. Do not import a later unaccepted workspace state or silently omit a branch.

Verify every required package and deliverable is represented with its exact
accepted content. If integration requires changing a delivered file, return the
correction through `needs_package_changes` to Implementation for the same
package owner, a new attempt, and an accepted delivery; do not
mutate an already accepted snapshot. Additional consolidation edits outside
package-owned files must remain in the approved plan. Route a broken plan to
Planning. Run focused integration checks and report all unresolved failures
together. The subsequent no-edit Validation phase owns the complete affected
gate, so do not duplicate that suite just to record consolidation.

Prepare a result checkpoint for the consolidated current result through
`flow_evidence`, reusing an unchanged existing checkpoint where appropriate.
Call `flow_packages` operation `integrate` with its `result_receipt_id`. This
binds the exact accepted delivery IDs, plan/acceptance revision, and result
snapshot. A plain `ready` report cannot replace that integration evidence; the
engine verifies the binding again before advancing. Submit the structured
integration result only after this operation succeeds.
