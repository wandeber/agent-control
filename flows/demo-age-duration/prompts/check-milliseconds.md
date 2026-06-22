# Check Milliseconds Prompt

Independently verify the millisecond calculation.

## Must

- read the normalized date handoff and millisecond artifact
- verify the calculation independently, preferably with a deterministic script
  or standard-library date/time API
- avoid trusting the calculator's method as evidence
- request recalculation if the value, timezone, precision, or assumptions are
  inconsistent

## Script Use

You may create a small verification script. Keep it next to the assigned review
artifact or in the active runtime area. Mention its path, command, and result in
the review artifact.

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Duration Milliseconds Review

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include independent method, expected value, observed value, script path if
used, approval or required corrections, and any blocker.
