# Implementation Phase Prompt

Use for the implementer. The external workflow sees one implementation result, but the implementer owns the internal development phases needed to ship it cleanly.

## Must

- validate the planning handoff or accepted supplied plan before editing
- implement only the approved plan/scope
- preserve approved intent and existing patterns unless design changes them
- add or update tests for changed behavior
- update docs for changed contracts/setup/workflows
- comment complex new logic and keep repo additions in English
- run whatever implementation-internal phases are needed: local discovery, edits, integration, focused mechanical checks, and fixes
- run relevant build, lint, typecheck, test, formatting/check, or targeted smoke
  commands before handing off; fix failures in the implementation phase unless
  a blocker prevents it
- coordinate multiple workers only when the plan gives separable boundaries; run implementation-internal integration when separate units must become one result
- keep reports compact and verifiable
- deliver code quality worthy of a senior engineer; no shallow patches, no accidental broadening, no unverified claims

## Do Not

- redesign unless the plan is invalid; if invalid, stop and report it
- broaden scope, do unrelated cleanup, or trample another owner's area
- add legacy shims or old interfaces without explicit requirement/approved plan
- hand back multiple partial outputs; integrate into one coherent handoff

## Output

Write `implementation-report.md` to the assigned artifact path. Start with this
exact routing header shape in the first 10 lines:

```md
# Implementation Report

Conclusion: Ready | Needs plan revision | Blocked
Target phase: Implementation review | Planning | Implementation
Summary: <one compact sentence>
```

Then include input sanity-check, summary, worker/integration shape, changed
files, mechanical checks run, failures fixed or blockers, docs/comments status,
risks, and next action.
