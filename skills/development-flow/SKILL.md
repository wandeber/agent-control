---
name: development-flow
description: Run the default Agent Control development-flow-v1 workflow for a software feature, fix, refactor, or approved implementation plan that needs coordinator-owned clarification, delegated execution, artifact handoffs, intent-preservation gates, implementation checks, final review, and concise supervision.
---

# Development Flow

Use this skill as the shortcut for the default complex development workflow.
It selects the catalog flow `development-flow-v1`, defines the visible
coordinator's entry and analysis-intent gates, and then follows `flow-runner`
for declarative step execution.

## Coordinator Clarification Gate

The visible coordinator that receives the user's request owns clarification.
Do not delegate clarification and do not launch a worker with an
`orchestrator` role to perform it.

Before starting Agent Control:

1. Reconstruct the user's complete intent from the request, active user and
   repository constraints, and any artifacts the user supplied.
2. Make the intended goal, requested behavior, in-scope and out-of-scope work,
   acceptance criteria, constraints, and confirmed decisions explicit.
3. Ask the user about every point that is ambiguous, underspecified,
   conflicting, or reasonably open to multiple interpretations. In particular,
   never silently choose an interpretation that could change scope,
   user-visible behavior, compatibility, data or API contracts, security,
   rollout, or destructive actions.
4. Group related questions so the user can resolve the ambiguity efficiently.
   If any answer is required, stop and wait for it; do not launch the flow with
   guesses or unconfirmed assumptions.

Do not ask ceremonial questions when the request has only one reasonable
interpretation. The gate is complete only when the coordinator can form a
clarified objective with no point that remains ambiguous or reasonably open to
misinterpretation. Use this structure for the objective passed to Agent
Control:

```text
Goal:
Requested behavior:
Scope:
Acceptance criteria:
Constraints:
Explicit exclusions:
Confirmed decisions:
Open questions: none
```

This normalized objective is coordinator-owned launch context, not a flow-step
artifact. Preserve the same conversational thread as the clarification owner
and let the launch tool attach it to the run with all-event observation.
Do not add separate login or subscription calls. If another thread executes the flow,
forward the original requester identity on launch and keep the two roles
distinct. The clarification owner still performs the analysis-intent gate;
the executing coordinator waits for its decision before advancing.

## Analysis Intent Gate

When the `analysis` step reports `ready`, the flow notifies the orchestrator
instead of advancing automatically. The same coordinator that clarified the
request must read `analysis.md` and check it against the clarified objective.

- If the analysis preserves the complete intent, manually start `planning` and
  record the approval in the transition reason.
- If the analysis misses or changes the intent, return to `analysis` with the
  complete clarified objective and the concrete correction required in the
  transition `reason` so Agent Control delivers both to the analyst.
- If repository discovery exposes a new ambiguity, ask the user, wait for the
  answer, update the clarified objective, and only then resume analysis with
  that full objective and answer in the transition `reason`.

This is a coordinator decision gate, not an independent expert review. The
coordinator must not rewrite the analyst's artifact or submit a semantic report
on the analyst's behalf.

## Procedure

1. Complete the coordinator clarification gate. Do not resolve or launch the
   flow while any clarification question remains open.
2. Resolve the flow through Agent Control discovery:
   - Prefer `flow_catalog_get` with `flow_id: "development-flow-v1"`.
   - If unavailable, use `flow_catalog_list` and select the exact
     `development-flow-v1` entry.
   - CLI fallback: `agentctl flow catalog get --flow development-flow-v1`.
3. After clarification and discovery have both succeeded, call
   `open_agent_control_console` exactly once, with no `run_id`, immediately
   before the first launch operation. The run does not exist yet, so the
   console opens in `follow_latest` mode and selects it as soon as launch
   creates it.
   - This native MCP App tool is a required pre-dispatch gate. If the tool is
     unavailable or its call fails, stop and report the problem before
     `flow_launch`, `flow_start`, `flow_continue`, `agentctl flow launch`, or any worker
     dispatch.
   - Do not replace it with Codex Browser, `agentctl web start`, an HTTP URL,
     or any other web-console fallback.
   - This call belongs only to the first launch turn. Never call it again on an
     Agent Control notification, wakeup, resume, retry, or manual transition.
4. Use `flow-runner` behavior for execution, starting with the launch itself;
   its normal no-reopen rule applies to every subsequent turn.
5. Use one `flow_launch` call with the discovered flow id, or pass the returned
   `config_path` to `agentctl flow launch`. Supply the normalized clarified
   objective as the run title. Launch owns automatic requester registration
   and subscription; forward the original identity when executing elsewhere.
6. Handle the configured analysis notification with the analysis-intent gate
   above before starting `planning`.
7. Keep updates concise. The initiating conversational thread retains the
   observer record returned by launch and uses `run_wait` with its cursor,
   indefinitely or with a one-hour timeout. It can report phase changes,
   blockers, and completion. It subscribes to all supported events by default;
   narrow filters only on an explicit request. Keep the launching conversation
   open while work remains. Answer new user messages in commentary, including
   unrelated questions, then resume the long wait with the last processed
   cursor. Preserve every active run. A short localized update may end with
   "The <flow> flow is still running; I am continuing to wait." Follow the
   `flow-runner` turn boundary contract for all waiting and resumption behavior.
   A separate coordinator with pending supervisory work follows the same rule;
   waiting does not transfer or duplicate orchestration ownership.

Do not ask the user for the flow path unless discovery fails. Do not manually
search the repository for flow files before using Agent Control discovery.
