# Resolve Current Date Prompt

Extract the user's birth date from the runtime contract objective/title and
resolve the current date/time.

## Must

- normalize the birth date to ISO format when possible
- record the current date/time with timezone or UTC marker
- state whether the calculation should use the current instant or a date-only
  boundary
- identify missing or ambiguous birth dates clearly
- return a missing date, ambiguous date format, or material precision/timezone
  choice to the original conversation in the handback summary; it asks through
  an available native question interface or text fallback before resuming
- reuse answers already given; do not silently choose an interpretation of an
  ambiguous birth date or treat silence as confirmation

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Current Date Handoff

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include the normalized birth date, current date/time, timezone, precision,
and any assumptions or blockers.
