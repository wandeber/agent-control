# Final Review Prompt

Review the final answer against the supporting duration artifacts.

Use the same independent reviewer for every iteration. On the first iteration,
start from clean context; on later iterations, verify the corrected answer
against that reviewer's own prior findings and current causal correction. Keep
resolved findings closed when their supporting inputs are unchanged; inspect
affected calculations or formatting when an input changes. Return all current
findings together, with concrete corrections and the configured target phase.

## Must

- verify the final answer uses the approved formatted duration
- ensure no unsupported extra claims were added
- route problems to the earliest useful phase
- approve only when the answer is clear, correct, and ready for the user

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Final Review

conclusion: <use one allowed conclusion from the generated Reporting Contract>
target_phase: <use one allowed target_phase from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include approval or specific corrections, target phase rationale, and any
blocker.
