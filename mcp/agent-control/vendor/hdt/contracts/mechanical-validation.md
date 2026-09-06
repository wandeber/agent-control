# Mechanical Validation Report

Return:

- `verdict: passed | failed | blocked`;
- `validation_mode: complete_gate | focused_recheck`;
- the validated revision or changed scope;
- every attempted command or configured check, its exit status, and concise
  first-party evidence;
- skipped checks and exact reasons;
- `executed | reused` for each result, with the matching source identity for
  reused evidence;
- one consolidated failure and correction bundle; and
- proof for any claimed pre-existing blocker without calling it GREEN.

A `complete_gate` report also records the supplied affected
package-and-consumer closure, mapping for every changed path, mandatory
repository gates, material-risk checks, and whether every applicable surface
ran, reused exact evidence, failed, or was skipped. Demonstrably independent
suites are outside the surface list. Bind the report to its gate-specific
`checkpoint_id` and canonical `task_result_snapshot_sha256`.

A `focused_recheck` report identifies the exact known failures and affected
scope covered, including the minimal ordered reproducer when order matters.

The report contains no plan-conformance, architecture, scope, documentation,
language, behavioral-completeness, or product-intent judgment. Final freshness
is governed only by [mechanical.md](../loops/mechanical.md) and
[final-expert.md](../loops/final-expert.md).

## Complete-Gate JSON For Closure

A complete gate supplies one JSON object with exactly these fields, using its
existing selected scope and evidence. Failed or blocked reports preserve the
actual partial scope and evidence, including empty collections when unavailable,
and describe missing inputs in summary and required corrections. Do not invent
a package map or checks to make a blocked report look complete. Full coverage
and the completeness rules below are required for passed closure candidates.
Focused rechecks keep the compact report above; do not manufacture cache
descriptors or additional checks for this shape.

- `report_schema_version`: integer `1`;
- `checkpoint_id` and `task_result_snapshot_sha256`: the validated checkpoint
  and canonical result identity;
- `validation_mode`, `verdict`, and non-empty `summary`;
- `path_packages`: every task-owned manifest path mapped to a package surface ID;
- a non-empty `surfaces` array, plus `checks` and `required_corrections` arrays.
  The latter two may be empty; correction strings must be non-empty and unique.

Each surface has exactly `surface_id`, `kind`, `check_ids`, and
`no_applicable_checks_reason`. IDs are unique safe identifiers; `kind` is
`package | consumer | mandatory | material_risk`. Check references are unique
and must exist. A surface with checks has a null reason; one without checks
has an explicit non-empty reason. Every mapped package is a declared package
surface, and every check belongs to at least one declared surface.

Each check has exactly `check_id`, `command`, `cwd`, `disposition`, `verdict`,
`exit_status`, `evidence`, `skip_reason`, and `source_identity`. Command is a
non-empty string, cwd is repository-relative, and evidence is a non-empty array
of unique concise strings. `disposition` is `executed | reused | skipped`.
Record actual outcomes; unsuccessful or skipped checks cannot satisfy closure.
Executed checks have null source identity. Reused checks supply exactly:

- `report_reference`: non-empty reference to the prior evidence;
- `check_id`: its source check ID;
- `task_result_snapshot_sha256`: the matching canonical result digest; and
- `invocation_context`: a concise explanation of the exact matching invocation,
  cwd, configuration, toolchain, environment, and relevant service state.

`verify-closure` requires `complete_gate`, a passed report, no corrections, and
every applicable check executed or reused with `verdict: passed`, integer exit
status `0`, and null skip reason. Mandatory and material-risk surfaces require
checks. Zero applicable checks is allowed only with concrete path-mapped package
surfaces and explicit reasons; never invent tests merely to populate the array.

The model determines affected packages, consumers, mandatory gates, and material
risks and remains responsible for honest execution and reuse evidence. The
helper validates the declared coverage and bindings, not those semantic choices.
Use concise non-secret evidence: the successful closure record preserves this
report. The separate optional reuse store continues to retain hashed descriptors.
