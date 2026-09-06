# Run-owned evidence

`EvidenceService` is the transport and provenance facade for the pinned HDT
checkpoint provider. It does not duplicate the provider's review, dependency,
composition, projection, or complete-coverage rules. The provider owns those
rules; models own semantic judgments and affected-scope declarations.

The controller constructs `EvidenceContext` from the authenticated run, flow
instance, step owner, acceptance revision, and current plan revision. Workers
cannot supply that context. Runtime step capabilities restrict operations and
review gates; review transitions additionally specify the expected owner.
`planRevision` is the SHA-256 of the controller-bound plan bytes. Preparation
checks the requested plan before capturing it, and every receipt gate compares
the provider manifest's plan digest with that trusted revision. An arbitrary
revision label or another plan path cannot confer approval on different bytes.

## API

- `execute(context, request)` prepares snapshots/deltas/scopes, composes semantic
  review drafts, projects approved plan sections, executes validation batches,
  or verifies final closure. The strict operation union is `schema.ts`.
- `verifyReceiptSync(context, receiptId, expectation)` is suitable inside a
  transition transaction. `requireCurrent` rechecks both repository identity and
  actual command inputs/toolchain/environment. `requireApproved` requires a
  complete gate unless `validationMode: 'focused'` explicitly requests a GREEN
  focused check; a supplied mode must match before the transition commits.
  A historical planner milestone can be checked
  without claiming it validates later changes.
- `readReceipt(context, receiptId)` and the `read_receipt` operation verify and
  return historical records using their original revisions. Reading must not
  register an old receipt as current evidence or advance a flow.

Preparation and delta responses include `draft_contracts` with the exact bundled
canonical contract paths and hashes. Review responses contain compact reviewed
and carried scope lists plus the immutable full provider `record_path`. Pass a
semantic draft containing directly reviewed sections/surfaces to `record_review`
or `record_plan_review`; never synthesize carried records. The provider composes
eligible history. A plan successor may refer to its explicit predecessor's old
plan revision, but acceptance and authenticated review ownership must match.
Review predecessor lookup uses a per-kind/checkpoint index. Legacy lookup skips
malformed unrelated receipts but never treats a missing or corrupt selected
origin as reusable evidence. Recovery uses an explicitly fresh full-review
checkpoint and records no inherited approval.
For a planner implementation review, `source_receipt_ids` must explicitly include
the current complete validation receipt for the same result. Omit
`mechanical_validation_report_sha256` from the semantic draft: Agent Control
derives it from that verified receipt. A contradictory supplied hash is rejected,
and later gates dereference and check that exact mechanical binding again.

All records and snapshot blobs live under the run's evidence directory, outside
the repository. Historical integrity verification remains available after the
worktree is removed. A current gate requires the worktree to exist and match.

## Mechanical execution and reuse

`validation_run` accepts a declared check set, its dependency DAG and affected
coverage. It launches actual processes with an explicit environment, records
exit status/output hashes, then joins every result. Independent checks may run
concurrently only when explicitly marked independent and their declared resource
sets do not overlap. Undeclared independence serializes. A failed launch joins
other launched processes before the tool returns. Timeouts terminate the child
process group.

The command context includes actual executable and declared toolchain/config
identities, OS identity, argv hash, timeout, sandbox, working directory, and every
environment value actually passed, including deterministic scratch paths.
Commands cannot obtain a cache hit by submitting their own execution status or
digest. Incomplete contexts and volatile checks always execute. Exact-result
reuse goes through the canonical helper's batch resolver and then dereferences
the original native execution and provider records. Corrupt candidates miss the
cache; a referenced corrupt origin rejects a gate.

`declared_inputs` reuse additionally needs a supported read boundary. On macOS,
the service denies undeclared reads (including metadata), repository writes and
network access, permitting declared inputs/config/toolchain, the executable,
scratch storage and protected OS runtime roots. A literal root-directory read
needed for process startup is included in identity. Mutable `/usr/local`, `/opt`,
arbitrary `/Library`, user directories and `/System/Volumes/Data` are not blanket
allowed. A command depending on an undeclared file fails; it is not retried with
broader permissions. Workspace execution and unsupported selective backends
fall back to exact-result identity. Unsupported requested read-only execution
fails instead of silently removing the sandbox.

Input identity includes content and observable metadata. `portability_key` only
names a dependency contract; it is never proof of equivalence. Relocating inputs
or execution roots can conservatively miss, including across worktrees. This
does not claim general portable caching. Expanding it requires a stable isolated
filesystem/toolchain identity, not weaker declaration flags.

Standard output and error are hashed in full. Private immutable diagnostic
artifacts retain a bounded tail with known secret environment values, credential
assignments, common tokens and private keys redacted. Failure receipts include
a bounded redacted diagnostic and artifact paths. Redaction is best effort;
command authors should never print credentials. Raw argv and environment values
are not persisted in public receipts.

Coverage is structural evidence over model-declared semantic scope. The helper
checks every manifest path, package/consumer/mandatory/material-risk surface and
check reference. It cannot discover undeclared semantic dependencies. Focused
or failing coverage is shape-checked through the same canonical validator, but
the actual mode/verdict is preserved and cannot close a run. Closure requires
an authenticated strict-approved expert result and a GREEN complete gate for
the same current snapshot; every reused source is dereferenced.

## Packaging and regression checks

`vendor/hdt/provider.json` records the canonical source version, commit, paths
and hashes. `scripts/sync-hdt-evidence.mjs --check` checks bundled bytes;
`--source <agent-settings-checkout> --check` also checks the canonical source.
Omit `--check` only for an explicit provider update. The canonical helper and
its contract/test companions are copied byte-for-byte, not edited here.

Run the 46 canonical fixtures with:

```sh
python3 -B -m unittest discover -s mcp/agent-control/vendor/hdt/tests -p test_review_checkpoint.py
```

The service regression suite verifies actual process receipts and repeat-check
counts (first batch: one executed; second identical batch: zero executed and one
reused), current-environment drift, corrupt/missing origins, strict closure,
revision-aware plan reuse, owner continuity, projection and durable history.
The selective sandbox case actually denies undeclared reads/writes and preserves
a valid check across an unrelated result change. DAG fixtures verify the join
and resource serialization. These are measured scenarios, not a promised token
or time-saving percentage for arbitrary tasks.
