# Context

Investigate the clarified request in the actual checkout. Capture only facts
needed for analysis: applicable instructions, existing behavior, affected paths,
contracts, ownership, dependencies/consumers, available checks, and constraints.
Distinguish verified facts from assumptions and unresolved user decisions.

Actively look for unresolved behavior, audience, scope, and acceptance choices,
not only missing files. Inspect evidence relevant to release status, deployed
consumers, public contracts, retained data, and schema tooling. Default to an
unreleased product and clean current behavior unless explicit instructions or
authoritative evidence establish obligations to preserve. A database, API,
integration, authentication, or migration directory alone does not prove
production use or legacy support needs.

Existing development records alone do not require preservation. The default
design may recreate them when simpler; normal ORM/schema migrations that apply
the change remain appropriate. Investigate concrete evidence of valued data or
production use before recommending old-format converters or backfills.

If uncertainty would change the solution or require compatibility/data conversion,
report `needs_clarification` with a concrete question, practical options, the
recommended clean approach when appropriate, and the consequence of each choice.
Put the question in the handback summary, not only in the Context document.
The original conversation asks through its available question UI or text
fallback; do not decide for the user or wait until implementation is blocked.
Ask about losing/recreating old data versus converting it when material evidence
of valued data or production leaves preservation unresolved. Record confirmed
answers separately from assumptions. A fresh-data design does not authorize
executing database deletes/resets, breaking actual external contracts, or
discarding migration history.

Do not design the solution, edit code, inventory unrelated areas, or ask the
user questions answerable from the repository. Stop discovery when the analyst
can make the needed decisions with grounded evidence. Hand the document to the
separate analyst with enough source pointers to reuse these findings without
repeating discovery.

Write the assigned Context document with source pointers and remaining factual
gaps, the product-stage basis, and confirmed compatibility/data obligations.
Report `ready`, `needs_clarification` for a material user choice, or
`blocked` for a missing prerequisite. Preserve existing relevant findings and
accepted decisions when returning to this phase.
