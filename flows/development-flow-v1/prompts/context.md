# Context

Investigate the clarified request in the actual checkout. Capture only facts
needed for analysis: applicable instructions, existing behavior, affected paths,
contracts, ownership, dependencies/consumers, available checks, and constraints.
Distinguish verified facts from assumptions and unresolved user decisions.

Do not design the solution, edit code, inventory unrelated areas, or ask the
user questions answerable from the repository. Stop discovery when the analyst
can make the needed decisions with grounded evidence. Context and Analysis
share the same analyst; the next step should reference these findings rather
than rediscover them.

Write the assigned Context document with source pointers and remaining factual
gaps. Report `ready`, `needs_clarification` for a material user choice, or
`blocked` for a missing prerequisite. Preserve existing relevant findings and
accepted decisions when returning to this phase.
