# Implementation

Implement the exact user-approved Plan and assigned work-package projections.
Read the current causal correction and relevant immutable references. Confirm
the plan remains valid before editing; return a broken plan to Planning.

Make only scoped changes and preserve unrelated work. Use justified tests at
the boundary that protects material behavior; reuse existing adequate coverage.
No TDD or one-test-per-requirement policy is implied. Comment non-obvious new
logic in English. Validate coherent batches with focused checks and preserve
controlled execution receipts when available.

Report changed/removed paths, completed packages, required integration, relevant
checks, known failures, residual risks, and the complete correction disposition
as structured data. Set `integration_needed` only when multiple outputs still
need consolidation. Do not claim individual worker outputs are integrated.
When integration is unnecessary, the flow proceeds directly to the no-edit
mechanical gate. Do not run another complete suite solely for a report.
