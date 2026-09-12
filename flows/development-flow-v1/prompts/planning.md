# Planning

Build an executable plan from the intent-approved Analysis and current acceptance
revision. Inspect the current correction capsule when reworking. Return an
incorrect or materially incomplete analysis to its owner; do not silently
replace its decisions.

Define stable work-package and section IDs, owned paths, interfaces, dependencies,
consumer impact, ordered steps, integration needs, and acceptance evidence.
Prefer a coherent current implementation for an unreleased product. Exclude
speculative compatibility layers, aliases, old-client conditionals, dual
reads/writes, legacy fallbacks, old-to-new data format converters, and backfills.
Prefer a design that loses/recreates old development data when simpler; existing
records alone are not a preservation requirement. Keep normal ORM/schema
migrations that apply the change. Include a compatibility/conversion
exception only for explicit user requirements or authoritative evidence of a
real obligation, naming the affected consumers/data and minimum necessary work.
A plan may state that old development data is disposable, but does not itself
authorize executing a destructive database reset/delete. Keep actual execution
scoped to the authorized action and target. Do not discard migration history,
break actual external contracts, or add unrelated cleanup under this default.

Review unresolved product, acceptance, scope, and lifecycle choices before
turning them into work packages. When an answer would materially change the
plan, including loss/recreation versus conversion when material evidence of
valued data or production leaves preservation uncertain, report `blocked` with
a concrete question and practical options in the handback summary for the
original conversation's available question interface
(text fallback). Preserve prior answers and independent findings; do not
silently assume a required answer, publish a speculative approved plan, or add
compatibility work "just in case". Use `needs_analysis_revision` when the
accepted solution itself must change.

Include only justified tests and documentation.
Map every expected changed path to a package and define the complete affected
mechanical gate: relevant packages, transitive consumers, mandatory repository
checks, and checks for material risks. Explain omitted independent surfaces.

Keep package boundaries usable for safe parallel work and verified projections:
include cross-cutting constraints and interfaces, not only a task summary.
Every isolated projection must retain the product-stage basis, compatibility
exceptions, data/contract obligations, and unresolved user questions relevant
to its package; a child must not have to infer them from omitted parent context.
Preserve IDs across edits, moves, and insertions. Record dependencies honestly;
removing edges or semantically remapping scope requires full plan review.

Write or update the same assigned Plan path with exact done criteria and rationale
for material choices. Runtime checkpoints preserve earlier revisions; do not
create numbered plan files for corrections. A material correction goes through
the same analyst's review
and explicit user approval of the resulting plan before implementation resumes.

Use external packages only when parallel work materially helps. Identify each
package's configured `codex-thread` role, required deliverables, and needed
Codex-managed worktree; keep concurrent writers disjoint. External groups need
a clean consolidated baseline and clean worktrees at registration. Preserve
uncommitted changes and choose inline work when that baseline is unavailable.
A single inline owner uses an empty external package manifest;
do not create workers or worktrees merely to populate a group. One external
worktree still requires consolidation. The existing exact-plan decision also
approves the registered package-manifest digest; there is no additional human
gate for delegation.

For material user decisions, use the available Agent Control `question_ask`
interface and resume its `question_wait` after timeouts. Report actual answers
and question ids to the original conversation for accepted-context updates
before dependent work. If unavailable, use the configured clarification route.
A clarification answer is not permission approval or a flow-gate decision.
