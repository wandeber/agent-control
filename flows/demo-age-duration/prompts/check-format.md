# Check Format Prompt

Independently verify the human-readable duration against the source
millisecond count.

## Must

- read the millisecond artifact and formatted duration artifact
- recompute the unit breakdown independently
- verify the formatted duration recomposes to the original milliseconds
- request reformatting for conversion mistakes
- request recalculation only when the source millisecond value itself appears
  wrong or inconsistent

## Script Use

You may create a small verification script. Keep it next to the assigned review
artifact or in the active runtime area. Mention its path, command, and result in
the review artifact.

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Human Duration Review

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include independent conversion, recomposed milliseconds, observed formatted
values, script path if used, approval or required corrections, and any blocker.
