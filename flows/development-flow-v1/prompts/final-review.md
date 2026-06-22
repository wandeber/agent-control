# Final Review Step Prompt

Use for the final fresh external expert reviewer.

Input is intentionally narrow: use the runtime contract, the current accepted
plan input artifact, current diff/code access, and this prompt. Do not consume
unlisted intermediate artifacts or authoring history by default.

## Must

- review current code/diff against the user objective and current accepted plan
- identify evidence blind spots, unproven assumptions, missing edge cases,
  maintainability risks, unnecessary compatibility scaffolding, or incorrect
  product/technical decisions
- route corrections to the earliest useful phase
- close only when the implementation is genuinely safe to hand back

## Routing Guidance

- Route to `analysis` for wrong/missing solution intent, unclear requirements,
  or product/architecture problems.
- Route to `planning` for correct intent but flawed execution plan.
- Route to `implementation` when the plan is sound but code, tests, docs, or
  checks are incomplete or wrong.
- Route to `final_review` only when the review should be rerun cleanly.
- Route to `orchestrator` only for human confirmation, ambiguity, or a true
  coordination blocker.

## Do Not

- review work you authored or previously reviewed in this chain
- rely on intermediate authoring history by default
- perform broad speculative redesign
- approve unverified implementation claims

## Artifact

Write the required final-review output artifact from the runtime contract.
Start with this header in the first 10 lines:

```md
# Final Review

conclusion: <use one allowed conclusion from the generated Reporting Contract>
target_phase: <use one allowed target_phase from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include close/no-close decision, strongest risks, concrete corrections,
target phase rationale, and any follow-up evidence needed.
