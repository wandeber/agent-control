# Plan Intent Review

As the exact Analysis owner, review whether the current Plan preserves accepted
intent, decisions, invariants, and boundaries. This is not an independent code
review or an opportunity to redesign the task.

Prepare a plan checkpoint through the runtime evidence contract. First review
is full. On correction, inspect the deterministic section delta and pending
scope; review changed/dependent sections and all prior findings. Keep stable
section identities and semantic dependencies. Do not drop dependencies or
reinterpret closed sections to manufacture reuse. Context loss, changed intent,
or unbounded impact requires full review by this same owner.

Return direct semantic decisions and dispositions through the evidence tool;
it composes the complete ledger and issues the receipt. Reference that receipt
as `result.evidence_receipt_id` in the structured step result. Use registry
key `plan_review` for the review receipt, including a rejected rework result; keep preparation and delta
receipts under distinct keys so they do not overwrite it. Do not rewrite the full ledger or a parallel
Markdown report. Approve only a strict accepted receipt for the current plan.

Route plan defects to Planning, incorrect solution intent to Analysis, and true
human decisions or blockers to the coordinator. Approval then waits for the
user's decision on this exact plan revision; it never authorizes implementation
by itself.

Check that any proposed work packages preserve the reviewed plan's scope,
interfaces, dependencies, and integration requirements. Register them through
`flow_packages` operation `define` after the plan artifact is bound and before
the exact-plan decision. Use `packages: []` for inline work with no useful
external delegation. Parallel packages require existing, disjoint Codex-managed
Git worktrees from the same base; do not create user worktrees with shell Git
commands. If their paths still need provisioning, return the complete package
requirements for the authorized coordinator to create the worktrees and define
the same group at the existing plan-approval gate. No extra user permission or
semantic review is implied by that setup.

The registered manifest is content-bound to the current plan and acceptance.
Do not add, omit, or replace packages after approval. A changed scope returns to
Planning and the normal approval path; worker completion cannot redefine the
set of required deliveries.
