# Final Review Prompt

Review the final answer against the supporting duration artifacts.

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
