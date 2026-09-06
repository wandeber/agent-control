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
