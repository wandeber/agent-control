# Optional UAT

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
passed on behalf of the user.

Stay in this phase while the user tests. Present access, steps and expected
outcomes through the available question interface, and collect actual acceptance,
requested changes, explicit skip, or a blocker. If direct questions are unavailable,
send the complete question to the original conversation. Do not report `ready`
just because preparation is finished, or infer acceptance from silence.

Return the actual answer and its question ID to the original conversation. Its
owner records `uat_result` with `flow_decision` for this active UAT attempt, then
explicitly resumes this same worker. A `question_wait` answer alone does not mean
the decision has been recorded. Once resumed, check that the stored decision names
this step instance, then report `ready` with `access_details` and any guide produced
in this attempt. The recorded answer selects acceptance, correction, skip, or a
blocker; the worker cannot approve UAT. A new UAT attempt needs a new user answer.
