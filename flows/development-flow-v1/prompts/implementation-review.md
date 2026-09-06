# Implementation Intent Review

As the exact Plan owner, review the frozen current result against the exact
approved plan after a verified GREEN complete mechanical gate. Consume those
receipts; do not rerun checks or perform a second independent expert review.

The first review covers complete plan conformance. On correction, use a
cumulative successor checkpoint, pending surface queue, affected dependency
closure, and every prior finding. Assign new paths; preserve eligible closed
coverage without removing dependencies or changing closed surface meaning to
justify reuse. Return direct decisions to the evidence composer and reference
the strict receipt as `result.evidence_receipt_id`. Register the
`record_review` result with gate `planner` under key `implementation_review`;
keep checkpoint/delta receipts under distinct keys. Context loss or unbounded impact requires a full review by
this same owner; missing continuity blocks.

Return all missing work, scope expansion, invalid checks, and plan defects in
one bundle. Route code defects to Implementation and an invalid plan to
Planning. Your first strict approval is permanent workflow history. Expert or
UAT corrections continue through their affected validation and the same expert,
without another planner review unless the user requests it explicitly.
