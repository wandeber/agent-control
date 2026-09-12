# Optional UAT Preparation

Prepare only the user-selected acceptance test experience. Use the current
accepted plan and validated result to make the relevant preview/environment
available, with concise reproducible steps and expected visible outcomes.
Prefer the requested platform and any repository or user testing conventions.
If the required audience, visible outcome, or access choice is unclear, return
the concrete question to the original conversation before dependent setup.
Use disposable fixtures where authorized; pre-production does not authorize
resetting real data or removing migration history to prepare a preview.

Do not introduce implementation changes during preparation. Report
`implementation_changes_needed` for setup/result defects or `plan_changes_needed`
for a flawed plan, with the complete correction in the summary. Planning changes
still require analyst review and exact user approval; do not repair them here.

Include `result.access_details`: usable access, concise steps and expected visible
outcomes when `ready`, or the concrete missing prerequisite for a blocked or
correction result. Write the assigned optional UAT guide only when it adds useful
detail, and include its artifact only if produced in this attempt. Omit the
artifact otherwise; do not claim an old guide as a new delivery. Do not claim UAT
passed on behalf of the user. The flow waits for the user's recorded observation
or explicit skip.
