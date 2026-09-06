"""Transport-only entry point for the canonical helper's mechanical validator.

The upstream helper intentionally exposes semantic validation as Python functions.
This bridge makes that validation callable without copying its schema/rules.
"""
import argparse
import copy
import json

import review_checkpoint as provider


parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--store", required=True)
parser.add_argument("--workflow-id", required=True)
parser.add_argument("--checkpoint-id", required=True)
parser.add_argument("--report")
parser.add_argument("--operation", choices=("validate-mechanical", "verify-stored", "verify-mechanical"), default="validate-mechanical")
parser.add_argument("--evidence-id")
parser.add_argument("--plan", action="store_true")
parser.add_argument("--require-review", action="append", default=[])
args = parser.parse_args()
try:
    repo = provider.lexical_absolute_path(args.repo)
    store = provider.resolve_store(args.store, repo)
    manifest = (provider.load_plan_manifest if args.plan else provider.load_manifest)(store, args.workflow_id, args.checkpoint_id)
    if manifest["repo_root"] != str(repo):
        raise provider.CheckpointError("Stored checkpoint belongs to another repository.")
    if args.operation == "verify-mechanical":
        envelope = provider.load_mechanical_evidence(store, args.workflow_id, args.evidence_id, repo)
        print(json.dumps({"evidence_id": envelope["evidence_id"], "report_sha256": envelope["report_sha256"]}))
        raise SystemExit(0)
    if args.operation == "verify-stored":
        result = (provider.verify_plan_manifest if args.plan else provider.verify_manifest)(store, args.workflow_id, manifest)
        if not result["valid"]:
            raise provider.CheckpointError("Stored checkpoint integrity failed.")
        for gate in args.require_review:
            state = result["review_state"] if args.plan else result["review_states"][gate]
            if state != "strict-approved":
                raise provider.CheckpointError("Stored review is not strictly approved.")
        result["plan_sha256"] = manifest["plan"]["sha256"]
        print(json.dumps(result))
        raise SystemExit(0)
    if not args.report:
        raise provider.CheckpointError("Mechanical validation requires a report.")
    report = provider.read_review_report(args.report, repo)
    if report.get("validation_mode") not in ("focused", "complete_gate"):
        raise provider.CheckpointError("Invalid mechanical validation mode.")
    if report.get("verdict") not in ("passed", "failed"):
        raise provider.CheckpointError("Invalid mechanical validation verdict.")
    shape = copy.deepcopy(report)
    if report["validation_mode"] == "focused":
        packages = report.get("path_packages")
        if not isinstance(packages, dict) or not set(packages) <= set(manifest["files"]):
            raise provider.CheckpointError("Focused coverage names unknown result paths.")
        manifest = {**manifest, "files": {path: manifest["files"][path] for path in packages}}
    # This projection validates coverage structure only. It is never stored as
    # GREEN evidence: the service persists the actual process verdict and mode.
    shape.update(validation_mode="complete_gate", verdict="passed", required_corrections=[])
    for check in shape.get("checks", []):
        check.update(verdict="passed", exit_status=0)
    provider.validate_closure_mechanical_report(shape, repo, manifest)
    print(json.dumps({"valid": True, "validation_mode": report["validation_mode"]}))
except (provider.CheckpointError, ValueError, OSError) as error:
    parser.exit(1, f"{error}\n")
