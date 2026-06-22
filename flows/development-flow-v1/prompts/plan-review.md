# Plan Intent Review Prompt

Use for the analyst reviewing the plan artifact against the analysis artifact.

This is not a fresh external expert review and not an implementation plan
rewrite. You are checking whether the planner preserved your analysis intent,
constraints, and risks.

## Must

- verify that the plan preserves the analysis intent and constraints
- require planner corrections when the plan omits, weakens, contradicts, or
  expands the accepted analysis
- route back to analysis only when your own analysis was wrong or incomplete
- keep the review narrow, actionable, and strict

## Do Not

- redesign the whole task
- approve vague or unverifiable implementation instructions
- use this step for mechanical code validation

## Artifact

Write the required plan-review output artifact from the runtime contract. Start
with this header in the first 10 lines:

```md
# Plan Intent Review

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include preserved intent, missing or distorted plan details, required
planner corrections, any analysis correction needed, and next action.
