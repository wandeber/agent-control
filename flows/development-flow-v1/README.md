# Development Flow v1

Version 1.2.2 aligns phase instructions with executable routes: optional UAT
documents, plan correction during UAT preparation, and guarded reuse of current
expert approval after mechanical refresh. The workflow follows HDT's
responsibility and evidence model. Agent Control owns durable phases,
decisions, owners, reports,
execution receipts, and transitions. Models own technical judgment and declared
impact; identical hashes do not establish semantic independence.

## Phase Contract

| Phase | Authority and inputs | Result / required evidence | Owner | Omission / correction |
| --- | --- | --- | --- | --- |
| Clarification | User request, prior decisions, applicable constraints | Durable acceptance revision with no unresolved material user choice | Original conversation | Before launch; repository facts go to Context |
| Context | Acceptance and actual repository | Grounded Context document with source pointers | Separate context researcher, Luna `max` | Refresh only affected factual gaps |
| Analysis | Acceptance and Context | Solution decisions, invariants, boundaries, risks | Analyst, Astra `xhigh` | Corrections amend decisions; material user ambiguity returns to clarification |
| Analysis intent | Current Analysis and accepted user intent | Recorded content-bound intent decision | Original clarification owner | Narrow intention check; no second technical review |
| Planning | Intent-approved Analysis | Stable package/section IDs, dependencies, paths, interfaces, affected mechanical gate | Planner | Wrong solution returns to Analysis |
| Plan intent | Current Plan and Analysis | Strict composed plan-review receipt | Exact analyst | First review full; later changed/dependent sections and findings |
| Human plan approval | Exact analyst-approved Plan and registered package manifest | One recorded user decision bound to both digests | Original conversation | Reuse valid explicit approval; changed plan repeats analyst and human gates |
| Implementation | Exact approved plan/projections, registered packages, and causal corrections | All required current deliveries accepted, no active branches, focused check evidence | Implementer | Broken plan returns to Planning; only scoped changes |
| Integration | Exact accepted delivery group and approved interfaces | Verified binding of the group to the consolidated current result | Dedicated integrator | Required for every nonempty external package group; skipped for inline work |
| Focused validation | Known correction bundle and affected boundaries | Controlled narrow recheck receipts | Validator, no-edit | Only on correction; cannot satisfy complete closure |
| Complete validation | Current checkpoint and complete affected closure | GREEN controlled/reused receipts with paths, consumers, mandatory gates, risks | Validator, no-edit | Run once per relevant coherent result; failures return as a bundle |
| Implementation intent | GREEN complete gate and exact approved Plan | Strict conformance receipt and first-approval milestone | Exact planner | Skip after first approval unless explicitly requested again |
| UAT choice | Existing user preference or one concise question | Recorded `prepare` / `skip` | Original conversation | Apply already expressed preference without asking again |
| UAT preparation | Validated result and selected experience | Structured access/steps; optional useful guide; no product edits | Implementer | Only when selected; result defects return to Implementation, plan defects to Planning |
| UAT observation | User's actual observations | Recorded acceptance, correction, explicit skip, or blocker | Original conversation | Preparation and elapsed time never imply approval |
| Independent review | Current acceptance, exact Plan, result, mechanical evidence | Strict full/incremental expert receipt with complete finding dispositions | New independent expert first; exact same expert thereafter | Earliest useful correction route; no automatic second review under single-review instruction |
| Closure | Current expert + complete validation evidence and earlier gates | Provider-verified closure receipt bound to unchanged result | Runtime verification requested by coordinator | Stale mechanical evidence returns to Validation; unchanged approved result can reuse the expert receipt |

Context has its own researcher; Analysis and plan-intent review share the exact
analyst. The clarification-owner
analysis-intent gate is retained as an additional user-intent safeguard. There
is one independent heavy reviewer. Coordinator decision steps are separate
flow states without delegated workers.

## Corrections And Reuse

- Every correction carries its source report, outstanding findings, and current
  acceptance/plan references. A stale artifact alias is not the correction cause.
- First semantic reviews are complete. Successors use immutable checkpoints,
  direct changes, dependencies, prior blockers, and evidence-provider scope.
  The model returns direct judgments; the tool composes eligible closed coverage.
- Context loss, missing/corrupt evidence, cross-cutting changes, or unbounded
  impact requires full review by the same owner. Missing owner continuity blocks;
  explicit recovery must not reuse the previous owner's approval silently.
- The planner's first approval is permanent history. Expert and UAT corrections
  pass through implementation, conditional integration, and relevant checks,
  then return to the owning loop; they do not repeat planner review by default.
  This milestone is not current-code approval. Changed plans still need current
  plan intent and explicit human approval.
- Collect all reasonably discoverable in-scope findings and independent failures.
  Preserve stable identities and every prior blocker's disposition. A second
  recurrence of the same underlying problem without material progress, or
  conflicting correction approaches, returns to a concrete user decision.
- An explicit single-review-only instruction stops automatic expert rework.
  Nothing approves due to a timeout or lack of user response.

When a complete mechanical receipt becomes stale after expert approval, the
coordinator returns to `validation` with the specific refresh reason. The
validator executes or reuses the applicable checks and may report
`request_closure: true` only for the same currently approved result. This flag
requests routing; both current owner-bound receipts must pass the transition
guards, and `verify_closure` still checks their common snapshot and earlier
gates. Missing, rejected, changed, or uncertain expert evidence follows the
existing route to the same reviewer. No expert command execution, new reviewer,
or renewed first-planner approval is implied by a mechanical refresh.

## Evidence Contract

Only Context, Analysis, Plan, and a useful UAT guide are document artifacts.
Implementation outcomes, reviews, ledgers, mechanical runs, decisions, and
closure are structured runtime records; do not duplicate them in Markdown.
Current aliases remain readable while evidence binds immutable revisions.
Keep the same current Plan path on correction. For UAT, report `access_details`
for the current attempt and include `uat_guide` only when actually written;
an omitted optional output does not publish a previous file as a new delivery.

Use `flow_evidence` with the operation allowed by the active step. Read its
current generated schema. Preparation, scope, and delta operations return
`payload.draft_contracts` with paths and digests for the packaged canonical
semantic and incremental contracts; load only the applicable contract. The
shared provider is the authority for complete draft structure. Typical operations are:

| Need | Operation | Model responsibility |
| --- | --- | --- |
| Prior evidence and lineage | `read_receipt` | Read relevant historical findings/checkpoint references without treating them as current approval |
| Plan snapshot and delta | `prepare_plan`, `diff_plan` | Stable sections, honest dependencies, relevant review intent |
| Result snapshot and pending scope | `prepare_result`, `diff_result`; `review_scope` for the planner | Task-owned scope, cumulative changed paths, affected surfaces |
| Plan review | `record_plan_review` | Direct decisions and prior finding dispositions |
| Planner or expert review | `record_review` with the assigned gate | Direct semantic evidence; tools compose closed ledger entries |
| Package handoff | `project_plan` | Select the approved package and cross-cutting constraints |
| Mechanical checks | `validation_run` | Declare complete affected checks, execution context, and safe independence |
| Final binding | `verify_closure` | Supply current expert and complete validation receipt references |

Checkpoint IDs identify immutable captures. Reuse the current unchanged
checkpoint by reading its receipt when a later phase needs it; do not recreate
the same ID. New content gets a new ID with a valid `previous` lineage.

Use explicit paths unless the entire worktree is truly isolated. Never declare
`all_changes` and isolation over unrelated dirty work. Keep secrets out of
artifacts, invocation descriptors, and reports; the evidence provider validates
snapshots and sanitizes controlled output. Technical no-edit capability must be
reported separately from instructions to avoid editing.

Use the `flow_evidence` top-level `key` to register final receipt aliases:
`plan_review`, `implementation_review`, `final_review`, `validation`,
`focused_validation`, and `closure`. Preparation/delta receipts use separate
keys and cannot replace a final approval alias. Controlled checks use
`coverage.validation_mode: focused` or `complete_gate`.

A report contains a compact `result.evidence_receipt_id` when its selected route
requires evidence. The runtime binds the receipt's actor, gate, flow, acceptance,
plan, and current snapshot. A plain `approved`, copied log, or self-declared
`evidence_valid` field cannot satisfy a guarded transition.

## Validation Cost Policy

Use tests that protect material behavior and reuse adequate coverage. No TDD,
mandatory RED phase, one test per requirement, or duplicate higher-level suite
is implied. Do not add production seams solely for tests without justification.

Validate coherent batches. Focused rechecks diagnose known failures; complete
gates cover affected packages, transitive consumers, mandatory checks, and
material risks. Resolve reusable expensive checks together, execute misses,
and join required outcomes. Reuse requires exact declared identity, intact
GREEN results, non-volatility, and verified provenance. Do not create extra
checks or records solely to populate a cache. Parallel execution is appropriate
only for disjoint mutable resources; keep shared ports, databases, locks, and
build outputs sequential.

## Coordinator Operation

Use `development-flow` for launch and decision policy, and `flow-runner` for
transport. `flow_launch` persists the complete initial `acceptance_context` before
dispatch; its short title is a label. `flow_context_update` appends subsequent
clarified acceptance revisions before dependent work. `flow_decision` records current configured choices and follows declarative
routes. Manual routing cannot bypass plan approval or evidence guards.

Keep the initiating conversation registered and subscribed to all run events.
Respond to new messages in commentary and re-enter `run_wait` while work remains.
Use renewable one-hour MCP waits below the verified client deadline. The bundled
Codex server allows 3,700 seconds; an internal timeout cannot extend a client
cap. Indefinite waits are reserved for CLI/internal runtime or an explicitly
verified host. Timeout is not completion. Keep each
run's last processed cursor and never rely on a notification to awaken an ended
Codex turn. Original requester and executing coordinator retain distinct roles
when they are different threads.

Decision `owner: requester` preserves the original conversation separately
from the executing coordinator. `authority` distinguishes coordinator judgment
from an actual user decision; ownership determines which thread may record it.

Model defaults align with HDT: Context Luna `max`, Analyst Astra `xhigh`,
Planner/Implementer/Integrator/Final reviewer Sol `xhigh`, Validator Luna `high`.
Override only model/effort per role through `.agents/models.toml` using
`[flows.development-flow-v1.<role>]`. Environment model variables are not used.


## Current Parallelism And Reuse Boundaries

Controlled validation has a native dependency graph and joins every required
check outcome. Implementation packages have a durable plan-bound group: batch
launch of ready branches, pinned owner/attempt, immutable deliveries, batch
acceptance, required-package join, and integration evidence tied to the current
result. The engine derives integration from the registered external group; a
worker cannot bypass it with `integration_needed: false`.

The same exact-plan decision binds the package-manifest digest. Provision
parallel worktrees through Codex before registration; runtime launches only the
registered disjoint worktrees from the same repository/base with configured
`codex-thread` roles. Package children
report their delivery, never the parent flow step. The original requester
remains attached. Empty manifests keep inline work simple, with no child
launch/acceptance/integration ceremony. One external worktree still requires
consolidation. This is a bounded package group inside a phase, not arbitrary
parallel flow graphs.

Selective declared-input reuse is eligible only where read restrictions and
complete input identity can be enforced. Otherwise the evidence service falls
back to exact-result reuse. Cross-worktree portability is not a guaranteed
optimization; use the returned effective reuse mode and provenance.

Planner `record_review` supplies its current passed complete validation receipt
in `source_receipt_ids`. The service derives the mechanical-report fingerprint;
the semantic draft must not invent it. A readable historical receipt provides
lineage and findings, not authority to satisfy a current gate.
