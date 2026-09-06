# Incremental Same-Owner Review Handoff

Use this capsule only when continuing the exact plan, planner, or expert owner.
It is a transport projection, not a replacement for immutable evidence.

Send:

- gate and `full | incremental` mode;
- current checkpoint identity and direct predecessor reference;
- concise deterministic delta summary and immutable delta path;
- every prior finding that must be dispositioned, with its immutable source
  report reference;
- correction-report and affected mechanical-evidence references;
- raw limitations;
- immutable references to the approved plan, current target, manifests, and
  prior review records.

For plan-intent and planner revalidation, also send helper-required and reopened
IDs with reasons plus helper-confirmed closed IDs. The owner returns only its
direct-review records and semantic decisions. The orchestrator uses
`record-plan-review --compose` or `record-review --compose` to construct and
validate the complete immutable ledger; neither owner nor orchestrator copies
closed records into the draft.

For plan-intent revalidation, do not prepopulate impact analysis. The exact
analysis owner may reopen another section only when pending evidence reveals a
new dependency and must record that evidence.

For expert re-review, the helper does not provide a scope queue. Send the
deterministic changed paths and the orchestrator's current impact summary and
additional affected IDs. The same reviewer uses its prior ledger, rechecks
changed and potentially affected surfaces, and returns direct-review records,
transitions, finding dispositions, and its impact judgment. `record-review
--compose` supplies eligible unaffected records and validates the complete
strict ledger.

Do not inline full manifests, full prior ledgers, or stable artifacts already
available to the same owner. Use the compact composition receipt in subsequent
handoffs; the complete record stays available by immutable reference. Reload
selected sources after bounded uncertainty.
Actual context loss, corrupt or missing evidence, drift, cross-cutting change,
or unbounded impact switches the same owner to a full review. Owner loss blocks.

Completed Analysis remains authoritative. If the planner proposed a materially
better approach, pass only that proposal and rationale. An adopted refinement
is appended as an explicit Analysis amendment; do not mutate the original
report or silently replace its decision.
