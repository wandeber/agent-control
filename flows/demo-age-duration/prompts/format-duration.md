# Format Duration Prompt

Convert the verified millisecond duration into days, hours, minutes, seconds,
and remaining milliseconds.

## Must

- use integer arithmetic
- preserve the original millisecond value
- show the breakdown formula
- if a review artifact is present, address its correction request directly

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Human Duration

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include source milliseconds, days, hours, minutes, seconds, remaining
milliseconds, formula, assumptions, and any blocker.
