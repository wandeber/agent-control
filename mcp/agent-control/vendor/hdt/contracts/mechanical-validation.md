# Mechanical Validation Report

Return:

- `verdict: passed | accepted_with_isolated_test_passes | failed | blocked`;
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
scope covered. When it resolves tests from a complete run, preserve both reports
and compose their evidence into that unchanged complete-gate report as described
below; the focused report alone is not a complete gate.

`accepted_with_isolated_test_passes` permits progress and closure under the
[isolated-test policy](../loops/mechanical.md#isolated-test-failures). It does not
mean the complete run passed. Retain its failed command receipts and report the
isolated passes without requiring another complete run, new user approval, or
proof of a flaky root cause.

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
and the completeness rules below are required for accepted closure candidates.
Focused rechecks keep the compact report above; do not manufacture cache
descriptors or additional checks for this shape.

- `report_schema_version`: integer `1`;
- `checkpoint_id` and `task_result_snapshot_sha256`: the validated checkpoint
  and canonical result identity;
- `validation_mode`, `verdict`, and non-empty `summary`;
- `path_packages`: every task-owned manifest path mapped to a package surface ID;
- a non-empty `surfaces` array, plus `checks` and `required_corrections` arrays.
  The latter two may be empty; correction strings must be non-empty and unique.
- only for `accepted_with_isolated_test_passes`, a non-empty
  `isolated_test_resolutions` array with the exact shape below. Existing
  `passed | failed | blocked` reports retain their original fields.

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
Record actual outcomes. A failed complete-run check remains `failed` with its
nonzero exit status; only an explicit isolated-test resolution can make that
test failure non-blocking. Skipped checks cannot satisfy closure.
Executed checks have null source identity. Reused checks supply exactly:

- `report_reference`: non-empty reference to the prior evidence;
- `check_id`: its source check ID;
- `task_result_snapshot_sha256`: the matching canonical result digest; and
- `invocation_context`: a concise explanation of the exact matching invocation,
  cwd, configuration, toolchain, environment, and relevant service state.

Each isolated-test resolution has exactly:

- `failed_check_id`: the unique ID of an executed complete-run check whose
  verdict remains `failed` and whose integer exit status is nonzero;
- `failure_kind`: exactly `tests_only`; non-test failures, including lint,
  typecheck, build, and incomplete execution, are ineligible;
- `failed_test_ids`: non-empty unique test identifiers from that failed run;
- `isolated_rechecks`: a non-empty array of objects with exactly `check_id` and
  `test_ids`. Each ID references an actually executed passing check in this
  report, with exit status `0`, no skip, and null source identity. `test_ids`
  lists the non-empty unique failed test identifiers that execution covered.

Every failed check has exactly one resolution. Recheck IDs are unique within a
resolution, and their combined test IDs equal all its failed test IDs. Preserve
first-party output showing which failed tests actually ran and passed; a zero
exit with no matching tests is insufficient. All evidence binds the same
canonical result, with unchanged assertions and relevant configuration. Include
every original and isolated check in the surface mapping. Do not add root-cause
claims or approval records as acceptance prerequisites.

`verify-closure` requires `complete_gate`, a `passed` or
`accepted_with_isolated_test_passes` report, no unresolved corrections, and no
skips. Ordinary checks must execute or reuse passing evidence with integer exit
status `0`; only executed test failures with complete isolated resolutions are
accepted otherwise. Mandatory and material-risk surfaces require checks. Zero
applicable checks is allowed only with concrete path-mapped package surfaces
and explicit reasons; never invent tests merely to populate the array.

The model determines affected packages, consumers, mandatory gates, and material
risks and remains responsible for honest execution and reuse evidence. The
helper validates the declared coverage and bindings, not those semantic choices.
Use concise non-secret evidence: the successful closure record preserves this
report. The separate optional reuse store continues to retain hashed descriptors.
