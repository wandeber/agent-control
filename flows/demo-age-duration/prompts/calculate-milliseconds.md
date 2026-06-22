# Calculate Milliseconds Prompt

Calculate how many milliseconds elapsed between the normalized birth date and
the current date/time.

## Must

- read the date handoff artifact from the runtime contract
- use deterministic date/time arithmetic
- make timezone and precision assumptions explicit
- produce a single integer millisecond value
- if a review artifact is present, address its correction request directly

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Duration Milliseconds

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include inputs used, formula/tool/API used, millisecond value, assumptions,
and any blocker.
