# Intent Review Prompt

Use when the previous phase owner checks whether the next deliverable preserved its intent, constraints, and review scope. This is not implementation-owned mechanical checking and not a fresh external expert review.

## Scope

Review only these transformations:

- analyst reviewing `plan.md` against `analysis.md`, writing `plan-review.md`
- planner reviewing `implementation-report.md` and current code against `plan.md`, writing `implementation-review.md`

## Rules

- do not redesign the whole task
- require correction when the next phase contradicts, weakens, omits, or expands your intent
- if your own prior intent is wrong/incomplete, say so and ask for a fresh artifact from your phase; otherwise return to the current phase
- keep the bar high; approving vague, incomplete, or unverified work is a failure

## Output

Write the review to the assigned artifact path. Start with this exact routing
header shape in the first 10 lines:

```md
# Intent Review

Conclusion: Approved | Needs changes | Prior intent needs revision | Blocked
Target phase: <next phase, current phase, prior phase, or user>
Summary: <one compact sentence>
```

Then include preserved/not, current-phase corrections, prior-intent revision if
any, and next/rollback phase.
