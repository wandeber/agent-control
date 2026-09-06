# Strict Planner And Expert Review Contract

Use this contract only for implementation-intent (`planner`) and final-expert
(`expert`) reports. New reports use `report_schema_version: 1`. Older
records without it remain integrity-readable but cannot satisfy a required
review gate or provide carry-forward evidence.

## Owner Draft And Helper Composition

The schema below describes the complete persisted record. The owner returns its
semantic fields and an explicit coverage mode for `record-review --compose`.
Omit `report_schema_version`, `checkpoint_id`, `snapshot_sha256`,
`task_result_snapshot_sha256`, `previous_checkpoint_id`,
`previous_snapshot_sha256`, `previous_review_sha256`, and `delta`; the helper
binds them from the selected checkpoint and immutable predecessor. Supplied
identities must match exactly and are never silently replaced.

In `full` mode, include direct review of every current surface. In `incremental`
mode, include only directly reviewed surfaces; do not copy carried records or
supply `carry_forward_rationale`. Findings, prior-finding dispositions,
transitions, dependencies, invariants, limitations, and impact judgments remain
explicit owner decisions. The helper inserts eligible unaffected records and
runs the same complete-record validator before immutable persistence. Missing
required review or unusable predecessor evidence fails; it never invents a
review, approval, or full-mode fallback.

The helper returns a compact receipt with the record path, fingerprint, verdict,
and reviewed/carried IDs. Keep the complete record accessible by reference;
do not reinject it after every iteration. Existing complete reports remain
supported without `--compose`.

## Common Object

Return one JSON object containing exactly:

- `report_schema_version: 1`;
- `verdict: approved | rework_required | blocked`;
- non-empty `summary`, `checkpoint_id`, and `recommended_next_phase`;
- `snapshot_sha256` and equal `task_result_snapshot_sha256`, both matching
  the current implementation manifest digest;
- nullable `previous_checkpoint_id`, `previous_snapshot_sha256`, and
  `previous_review_sha256`; all are null on a first report;
- `delta`, null on the first report, otherwise an object with exactly
  `from_checkpoint_id`, `to_checkpoint_id`, and the helper-produced
  canonical `sha256`;
- arrays `blocking_findings`, `non_blocking_findings`,
  `required_corrections`, and `prior_finding_results`;
- nullable `recommended_rollback_phase`, required for `rework_required`;
- `coverage_ledger`; and
- nullable `impact_analysis`, used only in incremental mode.

A later full recovery may use null `previous_review_sha256` only when no
qualifying strict record exists; the checkpoint, snapshot, and delta still bind
the direct predecessor. Only `rework_required` has a non-null rollback phase.
Planner reports add exactly `mechanical_validation_report_sha256`. Expert
reports instead add exactly `safe_to_close`, a boolean true only when
approved.

## Findings And Continuity

Each blocking item contains exactly `finding_id`, `kind`, `summary`,
`impact`, `recommended_action`, `evidence`, `affected_surface_ids`, and
the gate-specific field below. IDs are unique and safe; `kind` is `finding |
blocker`; the three descriptive strings are non-empty; and `evidence` and
`affected_surface_ids` are non-empty unique string arrays.

- Planner findings add non-empty unique `plan_clause_ids` and omit severity.
- Expert findings add `severity: critical | high | medium | low` and omit
  `plan_clause_ids`.

`required_corrections` items contain exactly `finding_id` and non-empty
`action`, once for every current `kind: finding` ID; blockers are not
corrections. Each non-blocking item contains exactly `observation_id`,
`summary`, and `evidence`, with a unique safe ID, non-empty summary, and a
non-empty unique evidence array.

On a successor, each `prior_finding_results` item contains exactly
`finding_id`, `result`, `evidence`, and `reviewed_surface_ids`. It
accounts exactly once for every prior blocking finding using its stable ID,
`result: resolved | still_open | blocked`, and non-empty unique evidence and
reviewed-surface arrays. Referenced surfaces must be directly reviewed or
transition sources. Still-open or blocked IDs remain in the current blocking
set; resolved IDs do not. The first report has no prior results.

## Semantic Coverage Ledger

`coverage_ledger` contains exactly `mode`, `surfaces`,
`surface_transitions`, and `limitations`. Mode is `full | incremental`;
`surfaces` is a non-empty object keyed by stable surface ID, not an array;
limitations is a unique string array. Each surface value records exactly:

- non-empty unique current-manifest `paths`;
- `disposition: reviewed | carried_forward`;
- `status: validated | finding | blocked`;
- unique current-surface `depends_on` IDs;
- non-empty unique `invariants`;
- unique current `finding_ids`; and
- a non-empty `carry_forward_rationale` only when carried forward; reviewed
  records omit that key.

Surfaces may overlap, but their path union equals the complete current manifest
path set. Dependencies reference current surfaces. Validated surfaces have no
finding IDs; finding and blocked surfaces reference matching current findings;
every blocking finding is referenced by a directly reviewed surface.

`surface_transitions` is empty on a first report. Every later item contains
exactly `kind`, `from_surface_ids`, `to_surface_ids`, and non-empty
`rationale`. Kind and required cardinality are: `added` zero-to-one,
`removed` one-to-zero, `renamed` one-to-one, `split` one-to-many, or
`merged` many-to-one. Sources are unique prior IDs and destinations unique
current IDs; each non-stable ID appears in exactly one transition.
Incremental mode is allowed only when mapping and impact are unambiguous and
every involved current or removed surface is directly reviewed.

The first report, and every fallback full report, directly reviews all current
surfaces. Full mode is mandatory after context loss, missing or corrupt
evidence, target drift, cross-cutting change, unbounded impact, or absence of
qualifying strict prior evidence.

Incremental mode requires exact predecessor, prior-review, and delta bindings.
It directly reviews prior-finding surfaces, transitioned surfaces, changed-path
owners, and their transitive dependents. The helper computes the planner
minimum from the prior ledger. A carried surface keeps its prior validated,
finding-free paths, dependencies, invariants, and unchanged manifest entries.
Planner incremental mode cannot remove dependency edges or transition a
helper-confirmed closed surface; use full mode for such remapping.

`impact_analysis` is null in first and full reports. In incremental mode it
contains exactly a non-empty `summary` and unique
`additionally_affected_surface_ids`. That list equals every directly reviewed
surface beyond the mechanically required set. For planner reports, each
additional surface adds a new dependency edge leading to helper-required scope
and the summary cites the pending evidence that revealed it.

## Verdict Coherence

- `approved`: all surfaces validated, no blocking findings or corrections,
  and next phase `post_planner_choice` for planner or `closure` for expert.
- `rework_required`: at least one actionable finding, matching corrections,
  a finding surface, and a rollback phase.
- `blocked`: at least one blocker and blocked surface.

Expert reports set `safe_to_close: false` for both non-approved verdicts.
Never approve because time elapsed.

## Draft Shape

This first expert-review example illustrates one reviewed surface and an
approved outcome. Replace its scope and judgments with actual evidence; include
every current path and use the finding/blocked forms above when needed. An
example is not permission to approve. The owner sends this semantic draft,
without the checkpoint identities supplied by `--compose`:

```json
{
  "verdict": "approved",
  "summary": "The assigned implementation preserves the reviewed contract and has no actionable findings.",
  "recommended_next_phase": "closure",
  "blocking_findings": [],
  "non_blocking_findings": [],
  "required_corrections": [],
  "prior_finding_results": [],
  "recommended_rollback_phase": null,
  "coverage_ledger": {
    "mode": "full",
    "surfaces": {
      "input-contract": {
        "paths": ["src/example.ts"],
        "disposition": "reviewed",
        "status": "validated",
        "depends_on": [],
        "invariants": ["Valid inputs preserve the documented output; invalid inputs fail without side effects."],
        "finding_ids": []
      }
    },
    "surface_transitions": [],
    "limitations": []
  },
  "impact_analysis": null,
  "safe_to_close": true
}
```

For a planner draft, omit `safe_to_close` and use `post_planner_choice` when
approved. Supply the mechanical binding through the active execution boundary:

- Direct `record-review --compose`: include the observed
  `mechanical_validation_report_sha256` in the draft.
- Authenticated Agent Control evidence `record_review`: include the verified
  current complete-validation receipt for the same result in the request's
  `source_receipt_ids`, outside `draft`, and omit
  `mechanical_validation_report_sha256`. Agent Control derives the hash from
  that receipt before invoking the helper; never fabricate or copy a placeholder
  hash to satisfy the complete persisted-record schema.

For incremental mode, send only directly reviewed surface records, the required
transitions and prior-finding results, and the exact impact object. The helper
composes eligible closed records; the owner does not reproduce them.
