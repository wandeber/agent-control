# Implementation Intent Review Prompt

Use for the planner reviewing implementation against the accepted plan artifact.

This is an intent-preservation and plan-compliance review. The implementer owns
mechanical validation, but you should verify that their claims are plausible and
that required checks were not skipped.

## Must

- verify that implementation preserved the accepted plan intent and boundaries
- check that required plan work was not omitted or expanded
- check that mechanical validation claims are concrete enough to trust
- request implementation corrections when code or checks do not satisfy the plan
- request plan revision only when the plan itself is wrong or incomplete

## Do Not

- rewrite code yourself
- perform a final external expert review
- send issues to analysis unless the plan revision path can express the problem

## Artifact

Write the required implementation-review output artifact from the runtime
contract. Start with this header in the first 10 lines:

```md
# Implementation Intent Review

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include preserved/not preserved plan intent, missing work, overreach,
verification evidence, implementation corrections, plan corrections if any, and
next action.
