# Planning

Build an executable plan from the intent-approved Analysis and current acceptance
revision. Inspect the current correction capsule when reworking. Return an
incorrect or materially incomplete analysis to its owner; do not silently
replace its decisions.

Define stable work-package and section IDs, owned paths, interfaces, dependencies,
consumer impact, ordered steps, integration needs, and acceptance evidence.
Include only justified tests, documentation, migration, and compatibility work.
Map every expected changed path to a package and define the complete affected
mechanical gate: relevant packages, transitive consumers, mandatory repository
checks, and checks for material risks. Explain omitted independent surfaces.

Keep package boundaries usable for safe parallel work and verified projections:
include cross-cutting constraints and interfaces, not only a task summary.
Preserve IDs across edits, moves, and insertions. Record dependencies honestly;
removing edges or semantically remapping scope requires full plan review.

Write the assigned Plan document with exact done criteria and rationale for
material choices. A material correction goes through the same analyst's review
and explicit user approval of the resulting plan before implementation resumes.

When parallel packages materially help, include their stable IDs, exact owned
relative paths, required deliverables, dependencies, and integration boundaries
in the Plan. Keep independent writers disjoint and identify the Codex-managed
worktrees needed. A single inline owner uses an empty external package manifest;
do not create workers or worktrees merely to populate a group. One external
worktree still requires consolidation. The existing exact-plan decision also
approves the registered package-manifest digest; there is no additional human
gate for delegation.
