# Plan Intent Review Record

Every persisted plan-intent report binds to a section-aware plan checkpoint ID
and snapshot fingerprint. It includes `previous_checkpoint`, null on the first
pass, and a section-complete `coverage_ledger`.

The owner returns a semantic draft for `record-plan-review --compose`, omitting
`checkpoint_id`, `snapshot_sha256`, and `previous_checkpoint`; the helper derives
these existing bindings and rejects any conflicting supplied values. In full
mode, the draft directly reviews every section. In incremental mode, it contains
only directly reviewed sections, with explicit deleted-section dispositions,
impact, dependencies, invariants, and findings. Do not include carried records
or carry-forward rationales. The helper restores eligible closed records from
immutable evidence and validates the complete result before storing it.

A missing required section or unusable prior evidence fails composition. The
helper returns a compact receipt; the complete record remains accessible by its
path and fingerprint. Existing complete reports remain supported without
`--compose`.

For each current section, record:

- `disposition: reviewed | carried_forward`;
- `status: validated | finding | blocked`;
- `depends_on`: current section IDs whose changes invalidate its evidence;
- non-empty `invariants`; and
- a non-empty `carry_forward_rationale` only when carried forward.

The ledger also contains `mode: full | incremental`, every deleted section
reviewed, and limitations. The first pass is full and directly reviews every
section. A later incremental report directly reviews every helper-required and
analyst-affected section; the helper composes the closed records without asking
the owner to reproduce or revalidate them.

Incremental reports include `impact_analysis` with a non-empty summary and
the exact `additionally_affected_section_ids`. Reopen an additional closed
section only when pending evidence reveals a previously unrecorded dependency;
cite that evidence and record the new edge. An approved verdict requires every
current section to be validated.

The report also states:

- whether completed analysis was preserved;
- proposed refinements and their dispositions;
- exact adopted analysis amendments and rationale, or that there were none;
- missing, unnecessary, or inconsistent work;
- decision-history completeness;
- whether analysis itself needs revision;
- the plan artifact checked;
- whether its summary and link are ready for user approval; and
- the correct verdict and route.
