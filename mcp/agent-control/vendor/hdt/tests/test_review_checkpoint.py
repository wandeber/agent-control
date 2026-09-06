from __future__ import annotations

import json
import hashlib
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "review_checkpoint.py"


class ReviewCheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Checkpoint Tests")
        self.git("config", "user.email", "checkpoint-tests@example.invalid")
        self.write(".gitignore", ".tmp/\n")
        self.write("plan.md", "# Approved plan\n\nImplement the behavior.\n")
        self.write("src/value.txt", "base\n")
        self.write("src/helper.txt", "helper\n")
        self.write("src/consumer.txt", "consumer\n")
        self.write("docs/note.md", "documentation\n")
        self.git("add", ".gitignore", "plan.md", "src", "docs/note.md")
        self.git("commit", "-qm", "baseline")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=check,
        )

    def write(self, relative: str, content: str | bytes) -> Path:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        return path

    def add_submodule(self, *, nested: bool = False) -> Path:
        source = Path(self.temporary.name) / "submodule-source"
        source.mkdir()
        self.git("-C", str(source), "init", "-q")
        self.git("-C", str(source), "config", "user.name", "Checkpoint Tests")
        self.git("-C", str(source), "config", "user.email", "checkpoint-tests@example.invalid")
        (source / "value.txt").write_text("base\n", encoding="utf-8")
        self.git("-C", str(source), "add", "value.txt")
        self.git("-C", str(source), "commit", "-qm", "submodule baseline")
        if nested:
            leaf = Path(self.temporary.name) / "leaf-source"
            self.git("clone", "-q", str(source), str(leaf))
            self.git(
                "-C", str(source), "-c", "protocol.file.allow=always",
                "submodule", "add", "-q", str(leaf), "nested/leaf",
            )
            self.git(
                "-C", str(source), "config", "--file", ".gitmodules",
                "submodule.nested/leaf.ignore", "all",
            )
            self.git("-C", str(source), "add", ".gitmodules", "nested/leaf")
            self.git("-C", str(source), "commit", "-qm", "nested submodule baseline")
        path = "deps/library with spaces"
        self.git(
            "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), path
        )
        self.git("config", "--file", ".gitmodules", f"submodule.{path}.ignore", "all")
        self.git("add", ".gitmodules", path)
        self.git("commit", "-qm", "add submodule")
        self.git("-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
        submodule = self.repo / path
        for directory in (self.repo, submodule, *((submodule / "nested/leaf",) if nested else ())):
            self.git("-C", str(directory), "config", "diff.ignoreSubmodules", "all")
            self.git("-C", str(directory), "config", "status.showUntrackedFiles", "no")
            self.git("-C", str(directory), "config", "user.name", "Checkpoint Tests")
            self.git(
                "-C", str(directory), "config", "user.email", "checkpoint-tests@example.invalid"
            )
        self.git("config", f"submodule.{path}.ignore", "all")
        if nested:
            self.git("-C", str(submodule), "config", "submodule.nested/leaf.ignore", "all")
        return submodule

    def run_helper(
        self,
        *args: str,
        expected: int = 0,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            expected,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        payload = json.loads(result.stdout) if result.stdout.strip() else None
        return result, payload

    def create(
        self,
        checkpoint_id: str,
        *scope_args: str,
        previous: str | None = None,
        expected: int = 0,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        args = [
            "create",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            checkpoint_id,
            "--repo",
            str(self.repo),
            "--plan",
            str(self.repo / "plan.md"),
            *scope_args,
        ]
        if previous:
            args.extend(["--previous", previous])
        return self.run_helper(*args, expected=expected)

    def strict_report(
        self,
        checkpoint: dict[str, object],
        gate: str,
        *,
        verdict: str = "approved",
        surfaces: dict[str, dict[str, object]] | None = None,
        previous_checkpoint: dict[str, object] | None = None,
        previous_review_sha256: str | None = None,
        delta_sha256: str | None = None,
        blocking_findings: list[dict[str, object]] | None = None,
        prior_finding_results: list[dict[str, object]] | None = None,
        impact_analysis: dict[str, object] | None = None,
        mode: str = "full",
    ) -> dict[str, object]:
        findings = blocking_findings or []
        if surfaces is None:
            surfaces = {
                "task-scope": {
                    "paths": sorted(checkpoint["files"]),
                    "disposition": "reviewed",
                    "status": "validated" if not findings else "finding",
                    "depends_on": [],
                    "invariants": ["The complete task scope was reviewed."],
                    "finding_ids": [item["finding_id"] for item in findings],
                }
            }
        previous_id = previous_checkpoint["checkpoint_id"] if previous_checkpoint else None
        report: dict[str, object] = {
            "report_schema_version": 1,
            "verdict": verdict,
            "summary": "Complete strict review report.",
            "checkpoint_id": checkpoint["checkpoint_id"],
            "snapshot_sha256": checkpoint["snapshot_sha256"],
            "task_result_snapshot_sha256": checkpoint["snapshot_sha256"],
            "previous_checkpoint_id": previous_id,
            "previous_snapshot_sha256": (
                previous_checkpoint["snapshot_sha256"] if previous_checkpoint else None
            ),
            "previous_review_sha256": previous_review_sha256,
            "delta": (
                {
                    "from_checkpoint_id": previous_id,
                    "to_checkpoint_id": checkpoint["checkpoint_id"],
                    "sha256": delta_sha256,
                }
                if previous_checkpoint
                else None
            ),
            "blocking_findings": findings,
            "non_blocking_findings": [],
            "required_corrections": [
                {
                    "finding_id": item["finding_id"],
                    "action": item["recommended_action"],
                }
                for item in findings
                if item["kind"] == "finding"
            ],
            "prior_finding_results": prior_finding_results or [],
            "recommended_next_phase": (
                "post_planner_choice" if gate == "planner" else "closure"
            ),
            "recommended_rollback_phase": "implementation" if verdict == "rework_required" else None,
            "coverage_ledger": {
                "mode": mode,
                "surfaces": surfaces,
                "surface_transitions": [],
                "limitations": [],
            },
            "impact_analysis": impact_analysis,
        }
        if gate == "planner":
            report["mechanical_validation_report_sha256"] = "a" * 64
        else:
            report["safe_to_close"] = verdict == "approved"
        return report

    def record_review(
        self,
        checkpoint: dict[str, object],
        gate: str,
        report: dict[str, object],
        *,
        workflow_id: str = "test-workflow",
        expected: int = 0,
        compose: bool = False,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        report_path = self.repo / f".tmp/{workflow_id}-{gate}-report.json"
        report_path.write_text(json.dumps(report), encoding="utf-8")
        return self.run_helper(
            "record-review",
            "--workflow-id",
            workflow_id,
            "--checkpoint-id",
            str(checkpoint["checkpoint_id"]),
            "--repo",
            str(self.repo),
            "--gate",
            gate,
            "--report",
            str(report_path),
            *(["--compose"] if compose else []),
            expected=expected,
        )

    @staticmethod
    def canonical_digest(payload: dict[str, object]) -> str:
        serialized = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(serialized).hexdigest()

    def create_plan(
        self,
        checkpoint_id: str,
        *,
        previous: str | None = None,
        expected: int = 0,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        args = [
            "create-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            checkpoint_id,
            "--repo",
            str(self.repo),
            "--plan",
            str(self.repo / "plan.md"),
        ]
        if previous:
            args.extend(["--previous", previous])
        return self.run_helper(*args, expected=expected)

    def record_plan_review(
        self,
        checkpoint: dict[str, object],
        report: dict[str, object],
        *,
        expected: int = 0,
        compose: bool = False,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        report_path = self.repo / ".tmp/plan-review-input.json"
        report_path.write_text(json.dumps(report), encoding="utf-8")
        return self.run_helper(
            "record-plan-review",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            str(checkpoint["checkpoint_id"]),
            "--repo",
            str(self.repo),
            "--report",
            str(report_path),
            *(["--compose"] if compose else []),
            expected=expected,
        )

    @staticmethod
    def semantic_draft(report: dict[str, object], *, plan: bool = False) -> dict[str, object]:
        draft = json.loads(json.dumps(report))
        identities = (
            ("checkpoint_id", "snapshot_sha256", "previous_checkpoint") if plan else
            ("report_schema_version", "checkpoint_id", "snapshot_sha256", "task_result_snapshot_sha256",
             "previous_checkpoint_id", "previous_snapshot_sha256", "previous_review_sha256", "delta")
        )
        for field in identities:
            draft.pop(field, None)
        key = "sections" if plan else "surfaces"
        draft["coverage_ledger"][key] = {
            record_id: record for record_id, record in draft["coverage_ledger"][key].items()
            if record["disposition"] == "reviewed"
        }
        return draft

    def closure_report(self, checkpoint: dict[str, object]) -> dict[str, object]:
        return {
            "report_schema_version": 1,
            "checkpoint_id": checkpoint["checkpoint_id"],
            "task_result_snapshot_sha256": checkpoint["snapshot_sha256"],
            "validation_mode": "complete_gate",
            "verdict": "passed",
            "summary": "The declared complete mechanical gate passed.",
            "path_packages": {path: "package" for path in checkpoint["files"]},
            "surfaces": [{
                "surface_id": "package", "kind": "package", "check_ids": ["unit"],
                "no_applicable_checks_reason": None,
            }],
            "checks": [{
                "check_id": "unit", "command": "pnpm test", "cwd": ".",
                "disposition": "executed", "verdict": "passed", "exit_status": 0,
                "evidence": ["Declared successful command output in this fixture."],
                "skip_reason": None, "source_identity": None,
            }],
            "required_corrections": [],
        }

    def close(
        self, expert_id: str, report: dict[str, object], *, expected: int = 0
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        path = self.repo / ".tmp/closure-input.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        return self.run_helper(
            "verify-closure", "--workflow-id", "test-workflow", "--repo", str(self.repo),
            "--expert-checkpoint-id", expert_id, "--mechanical-report", str(path), expected=expected,
        )

    def test_compose_strict_reviews_binds_identity_and_requires_pending_coverage(self) -> None:
        _, first = self.create("compose-1", "--path", "src/value.txt", "--path", "docs/note.md")
        assert first is not None
        surfaces = {
            "core": {"paths": ["src/value.txt"], "disposition": "reviewed", "status": "validated",
                     "depends_on": [], "invariants": ["Core behavior reviewed."], "finding_ids": []},
            "docs": {"paths": ["docs/note.md"], "disposition": "reviewed", "status": "validated",
                     "depends_on": [], "invariants": ["Documentation reviewed."], "finding_ids": []},
        }
        prior_records = {}
        for gate in ("planner", "expert"):
            full = self.strict_report(first, gate, surfaces=surfaces)
            draft = self.semantic_draft(full)
            omitted = json.loads(json.dumps(draft))
            del omitted["coverage_ledger"]["surfaces"]["docs"]
            self.record_review(first, gate, omitted, compose=True, expected=2)
            self.record_review(first, gate, {**draft, "snapshot_sha256": "f" * 64}, compose=True, expected=2)
            supplied_carry = json.loads(json.dumps(draft))
            supplied_carry["coverage_ledger"]["surfaces"]["docs"]["disposition"] = "carried_forward"
            self.record_review(first, gate, supplied_carry, compose=True, expected=2)
            invalid_mode = json.loads(json.dumps(draft))
            invalid_mode["coverage_ledger"]["mode"] = []
            self.record_review(first, gate, invalid_mode, compose=True, expected=2)
            _, receipt = self.record_review(first, gate, draft, compose=True)
            assert receipt is not None
            self.assertNotIn("report", receipt)
            self.assertEqual(receipt["reviewed_ids"], ["core", "docs"])
            self.assertEqual(json.loads(Path(receipt["record_path"]).read_text())["report"], full)
            prior_records[gate] = receipt

        self.write("src/value.txt", "changed core\n")
        _, second = self.create("compose-2", previous="compose-1")
        assert second is not None
        _, delta = self.run_helper(
            "diff", "--workflow-id", "test-workflow", "--repo", str(self.repo),
            "--from-checkpoint", "compose-1", "--to-checkpoint", "compose-2",
        )
        assert delta is not None
        for gate in ("planner", "expert"):
            sparse = self.strict_report(
                second, gate, surfaces={"core": surfaces["core"]}, previous_checkpoint=first,
                previous_review_sha256=prior_records[gate]["report_sha256"], delta_sha256=delta["delta_sha256"],
                mode="incremental", impact_analysis={"summary": "Only core changed.", "additionally_affected_surface_ids": []},
            )
            draft = self.semantic_draft(sparse)
            missing = json.loads(json.dumps(draft))
            missing["coverage_ledger"]["surfaces"] = {}
            self.record_review(second, gate, missing, compose=True, expected=2)
            self.record_review(second, gate, {**draft, "previous_review_sha256": "f" * 64}, compose=True, expected=2)
            prior_path = Path(prior_records[gate]["record_path"])
            original = prior_path.read_bytes()
            prior_path.unlink()
            self.record_review(second, gate, draft, compose=True, expected=2)
            prior_path.write_bytes(b"{}")
            prior_path.chmod(0o600)
            self.record_review(second, gate, draft, compose=True, expected=2)
            prior_path.write_bytes(original)
            _, receipt = self.record_review(second, gate, draft, compose=True)
            assert receipt is not None
            self.assertEqual(receipt["carried_forward_ids"], ["docs"])
            stored = json.loads(Path(receipt["record_path"]).read_text())["report"]
            self.assertEqual(stored["previous_review_sha256"], prior_records[gate]["report_sha256"])
            self.assertEqual(stored["delta"]["sha256"], delta["delta_sha256"])
            self.assertEqual(stored["coverage_ledger"]["surfaces"]["docs"]["invariants"], surfaces["docs"]["invariants"])
            self.run_helper(
                "verify", "--workflow-id", "test-workflow", "--repo", str(self.repo),
                "--checkpoint-id", "compose-2", "--require-review", gate,
            )

    def test_compose_plan_reviews_preserves_closed_sections_and_explicit_deletions(self) -> None:
        self.write("plan.md", "# Plan\n\nIntro.\n\n<!-- hdt-section: work -->\n## Work\n\nOriginal.\n\n<!-- hdt-section: notes -->\n## Notes\n\nStable.\n")
        _, first = self.create_plan("compose-plan-1")
        assert first is not None
        records = {section_id: {"disposition": "reviewed", "status": "validated", "depends_on": [],
                                "invariants": [f"Reviewed {section_id}."]} for section_id in first["sections"]}
        report = {"verdict": "approved", "checkpoint_id": first["checkpoint_id"],
                  "snapshot_sha256": first["snapshot_sha256"], "previous_checkpoint": None,
                  "coverage_ledger": {"mode": "full", "sections": records, "deleted_section_ids_reviewed": [], "limitations": []}}
        draft = self.semantic_draft(report, plan=True)
        omitted = json.loads(json.dumps(draft))
        del omitted["coverage_ledger"]["sections"]["notes"]
        self.record_plan_review(first, omitted, compose=True, expected=2)
        self.record_plan_review(first, {**draft, "checkpoint_id": "wrong"}, compose=True, expected=2)
        invalid_mode = json.loads(json.dumps(draft))
        invalid_mode["coverage_ledger"]["mode"] = {}
        self.record_plan_review(first, invalid_mode, compose=True, expected=2)
        _, receipt = self.record_plan_review(first, draft, compose=True)
        assert receipt is not None
        self.assertEqual(json.loads(Path(receipt["record_path"]).read_text())["report"], report)
        self.write("plan.md", (self.repo / "plan.md").read_text().replace("Original.", "Corrected."))
        _, second = self.create_plan("compose-plan-2", previous="compose-plan-1")
        assert second is not None
        _, delta = self.run_helper(
            "diff-plan", "--workflow-id", "test-workflow", "--repo", str(self.repo),
            "--from-checkpoint", "compose-plan-1", "--to-checkpoint", "compose-plan-2",
        )
        assert delta is not None
        draft = {"verdict": "approved", "coverage_ledger": {
            "mode": "incremental", "sections": {key: records[key] for key in delta["required_review_section_ids"]},
            "deleted_section_ids_reviewed": [], "limitations": [],
        }, "impact_analysis": {"summary": "Work changed; notes remain independent.", "additionally_affected_section_ids": []}}
        omitted = json.loads(json.dumps(draft))
        del omitted["coverage_ledger"]["sections"]["work"]
        self.record_plan_review(second, omitted, compose=True, expected=2)
        self.record_plan_review(second, {**draft, "previous_checkpoint": "wrong"}, compose=True, expected=2)
        prior_path = Path(receipt["record_path"])
        original = prior_path.read_bytes()
        for replacement in (None, b"{}"):
            if replacement is None:
                prior_path.unlink()
            else:
                prior_path.write_bytes(replacement)
                prior_path.chmod(0o600)
            self.record_plan_review(second, draft, compose=True, expected=2)
        prior_path.write_bytes(original)
        _, second_receipt = self.record_plan_review(second, draft, compose=True)
        assert second_receipt is not None
        self.assertEqual(second_receipt["carried_forward_ids"], ["notes"])
        self.write("plan.md", (self.repo / "plan.md").read_text().replace("<!-- hdt-section: work -->\n## Work\n\nCorrected.\n\n", ""))
        _, third = self.create_plan("compose-plan-3", previous="compose-plan-2")
        assert third is not None
        root_id = next(key for key in third["sections"] if key != "notes")
        deletion = {"verdict": "approved", "coverage_ledger": {
            "mode": "incremental", "sections": {root_id: records[root_id]},
            "deleted_section_ids_reviewed": [], "limitations": [],
        }, "impact_analysis": {"summary": "The work section was explicitly removed.", "additionally_affected_section_ids": []}}
        self.record_plan_review(third, deletion, compose=True, expected=2)
        deletion["coverage_ledger"]["deleted_section_ids_reviewed"] = ["work"]
        self.record_plan_review(third, deletion, compose=True)

    def test_compose_expert_uses_current_impact_graph_and_transition_sources(self) -> None:
        _, first = self.create("expert-compose-1", "--path", "src")
        assert first is not None
        records = {
            "core": {"paths": ["src/value.txt"], "disposition": "reviewed", "status": "validated",
                     "depends_on": [], "invariants": ["Core reviewed."], "finding_ids": []},
            "bridge": {"paths": ["src/consumer.txt"], "disposition": "reviewed", "status": "validated",
                       "depends_on": ["core"], "invariants": ["Bridge reviewed."], "finding_ids": []},
            "leaf": {"paths": ["src/helper.txt"], "disposition": "reviewed", "status": "validated",
                     "depends_on": ["bridge"], "invariants": ["Leaf reviewed."], "finding_ids": []},
        }
        self.record_review(first, "expert", self.strict_report(first, "expert", surfaces=records))
        self.write("src/value.txt", "updated core\n")
        _, second = self.create("expert-compose-2", previous="expert-compose-1")
        assert second is not None
        current = {"core": records["core"], "bridge": {**records["bridge"], "depends_on": []}}
        draft = self.semantic_draft(self.strict_report(second, "expert", surfaces=current, mode="incremental",
            impact_analysis={"summary": "Direct review established that bridge no longer depends on core.", "additionally_affected_surface_ids": ["bridge"]}))
        _, receipt = self.record_review(second, "expert", draft, compose=True)
        assert receipt is not None
        self.assertEqual(receipt["carried_forward_ids"], ["leaf"])
        _, third = self.create("expert-compose-3", previous="expert-compose-2")
        assert third is not None
        rename = self.semantic_draft(self.strict_report(third, "expert", surfaces={"leaf-renamed": records["leaf"]}, mode="incremental",
            impact_analysis={"summary": "Review owns the explicit semantic rename.", "additionally_affected_surface_ids": []}))
        rename["coverage_ledger"]["surface_transitions"] = [{"kind": "renamed", "from_surface_ids": ["leaf"], "to_surface_ids": ["leaf-renamed"], "rationale": "Stable path now has the clearer semantic identity."}]
        _, renamed = self.record_review(third, "expert", rename, compose=True)
        assert renamed is not None
        stored = json.loads(Path(renamed["record_path"]).read_text())["report"]
        self.assertEqual(set(stored["coverage_ledger"]["surfaces"]), {"core", "bridge", "leaf-renamed"})

    def test_hash_only_matches_never_persists_current_content_but_patches_work(self) -> None:
        _, checkpoint = self.create("hash-only", "--path", "src/value.txt")
        assert checkpoint is not None
        store = self.repo / ".tmp/hdt-review-checkpoints/test-workflow"
        def stored_state():
            return {str(path.relative_to(store)): (path.stat().st_size, path.stat().st_mtime_ns)
                    for path in store.rglob("*") if path.is_file()}
        before = stored_state()
        args = ("matches", "--workflow-id", "test-workflow", "--repo", str(self.repo), "--checkpoint-id", "hash-only")
        self.run_helper(*args)
        self.assertEqual(stored_state(), before)
        for kind in ("content", "mode", "plan", "guard"):
            with self.subTest(kind=kind):
                target = self.repo / ("plan.md" if kind == "plan" else "src/value.txt")
                original = target.read_bytes()
                if kind == "mode":
                    target.chmod(0o755)
                elif kind == "guard":
                    self.write("unrelated.txt", "outside-scope change\n")
                else:
                    target.write_bytes(original + b"changed\n")
                _, result = self.run_helper(*args, expected=1)
                assert result is not None
                self.assertFalse(result["matches"])
                self.assertEqual(stored_state(), before)
                target.write_bytes(original)
                target.chmod(0o644)
                (self.repo / "unrelated.txt").unlink(missing_ok=True)
        self.write("src/value.txt", "patch-visible new bytes\n")
        _, patched = self.run_helper(*args, "--include-patches", expected=1)
        assert patched is not None
        self.assertIn("+patch-visible new bytes", patched["delta"]["changes"][0]["patch"])
        self.assertNotEqual(stored_state(), before)
        _, plan = self.create_plan("hash-only-plan")
        assert plan is not None
        before = stored_state()
        self.write("plan.md", "# Changed plan\n\nNew plan bytes.\n")
        self.run_helper("matches-plan", "--workflow-id", "test-workflow", "--repo", str(self.repo), "--checkpoint-id", "hash-only-plan", expected=1)
        self.assertEqual(stored_state(), before)

    def test_closure_persists_equal_digest_different_ids_and_is_idempotent(self) -> None:
        _, expert = self.create("closure-expert", "--path", "src/value.txt")
        assert expert is not None
        self.record_review(expert, "expert", self.strict_report(expert, "expert"))
        _, mechanical = self.create("closure-mechanical", "--path", "src/value.txt")
        assert mechanical is not None
        self.assertEqual(expert["snapshot_sha256"], mechanical["snapshot_sha256"])
        report = self.closure_report(mechanical)
        _, receipt = self.close("closure-expert", report)
        assert receipt is not None
        self.assertTrue(receipt["closure_verified"])
        self.assertNotIn("mechanical_report", receipt)
        path = Path(receipt["record_path"])
        original = path.read_bytes()
        timestamp = path.stat().st_mtime_ns
        stored = json.loads(original)
        self.assertEqual(stored["mechanical_report"], report)
        self.assertEqual(stored["mechanical_report_sha256"], self.canonical_digest(report))
        _, repeated = self.close("closure-expert", report)
        self.assertEqual(repeated, receipt)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(path.stat().st_mtime_ns, timestamp)
        stored["verified_at"] = "2000-01-01T00:00:00Z"
        path.write_text(json.dumps(stored))
        self.close("closure-expert", report, expected=2)
        path.write_bytes(original)
        report["checks"][0]["disposition"] = "reused"
        report["checks"][0]["source_identity"] = {
            "report_reference": "immutable validation report", "check_id": "unit",
            "task_result_snapshot_sha256": mechanical["snapshot_sha256"],
            "invocation_context": "Same command, working directory and declared environment.",
        }
        self.close("closure-expert", report)

    def test_closure_rejects_incomplete_mechanical_evidence_and_allows_justified_no_checks(self) -> None:
        _, checkpoint = self.create("closure-shapes", "--path", "docs/note.md")
        assert checkpoint is not None
        self.record_review(checkpoint, "expert", self.strict_report(checkpoint, "expert"))
        report = self.closure_report(checkpoint)
        cases = [
            ("report_schema_version", True), ("report_schema_version", 1.0), ("validation_mode", "focused_recheck"),
            ("verdict", "failed"), ("required_corrections", ["Fix failures."]),
            ("path_packages", {}), ("surfaces", []), ("checkpoint_id", "missing"),
        ]
        for field, value in cases:
            with self.subTest(field=field):
                self.close("closure-shapes", {**report, field: value}, expected=2)
        for field, value in (
            ("evidence", []), ("exit_status", False), ("exit_status", None),
            ("disposition", "skipped"), ("disposition", "reused"), ("command", ""),
            ("disposition", []), ("disposition", {}),
            ("cwd", "../outside"), ("skip_reason", "Not attempted."),
        ):
            with self.subTest(check_field=field, value=value):
                malformed = json.loads(json.dumps(report))
                malformed["checks"][0][field] = value
                self.close("closure-shapes", malformed, expected=2)
        for mutation in ("unknown-check", "unreferenced-check", "non-package-path", "invalid-kind", "empty-mandatory"):
            with self.subTest(coverage=mutation):
                malformed = json.loads(json.dumps(report))
                if mutation == "unknown-check":
                    malformed["surfaces"][0]["check_ids"] = ["missing"]
                elif mutation == "unreferenced-check":
                    malformed["checks"].append({**malformed["checks"][0], "check_id": "orphan"})
                elif mutation == "non-package-path":
                    malformed["surfaces"][0]["kind"] = "consumer"
                elif mutation == "invalid-kind":
                    malformed["surfaces"][0]["kind"] = {}
                else:
                    malformed["surfaces"].append({"surface_id": "mandatory", "kind": "mandatory", "check_ids": [], "no_applicable_checks_reason": "Cannot waive a mandatory surface."})
                self.close("closure-shapes", malformed, expected=2)
        no_checks = json.loads(json.dumps(report))
        no_checks["checks"] = []
        no_checks["surfaces"][0]["check_ids"] = []
        self.close("closure-shapes", no_checks, expected=2)
        no_checks["surfaces"][0]["no_applicable_checks_reason"] = "This package changes only prose; the declared affected surface has no configured checks."
        self.close("closure-shapes", no_checks)

    def test_closure_rejects_unapproved_stale_corrupt_and_current_drift(self) -> None:
        _, old = self.create("closure-old", "--path", "src/value.txt")
        assert old is not None
        report = self.closure_report(old)
        self.close("closure-old", report, expected=2)
        finding = {"finding_id": "OPEN-1", "kind": "finding", "severity": "medium", "summary": "An unresolved issue.",
                   "impact": "The task is not ready.", "recommended_action": "Correct the issue.",
                   "evidence": ["Concrete fixture finding."], "affected_surface_ids": ["task-scope"]}
        self.record_review(old, "expert", self.strict_report(old, "expert", verdict="rework_required", blocking_findings=[finding]))
        self.close("closure-old", report, expected=2)
        self.write("src/value.txt", "corrected result\n")
        _, current = self.create("closure-current", "--path", "src/value.txt")
        assert current is not None
        self.record_review(current, "expert", self.strict_report(current, "expert"))
        self.close("closure-current", report, expected=2)
        report = self.closure_report(current)
        manifest_path = self.repo / ".tmp/hdt-review-checkpoints/test-workflow/checkpoints/closure-current.json"
        original = manifest_path.read_bytes()
        manifest_path.write_bytes(b"{}")
        self.close("closure-current", report, expected=2)
        manifest_path.write_bytes(original)
        self.write("src/value.txt", "drift after approval\n")
        self.close("closure-current", report, expected=2)
        self.assertFalse((self.repo / ".tmp/hdt-review-checkpoints/test-workflow/closures").exists())

    def test_composed_and_closure_records_cannot_exceed_their_read_limit(self) -> None:
        _, checkpoint = self.create("record-size", "--path", "src/value.txt")
        assert checkpoint is not None
        full = self.strict_report(checkpoint, "expert")
        draft = self.semantic_draft(full)
        draft["summary"] = "x" * (8 * 1024 * 1024 - len(json.dumps(draft).encode()) - 128)
        result, _ = self.record_review(checkpoint, "expert", draft, compose=True, expected=2)
        self.assertIn("read limit", result.stderr)
        self.record_review(checkpoint, "expert", full)
        mechanical = self.closure_report(checkpoint)
        mechanical["summary"] = "x" * (8 * 1024 * 1024 - len(json.dumps(mechanical).encode()) - 128)
        result, _ = self.close("record-size", mechanical, expected=2)
        self.assertIn("read limit", result.stderr)
        self.assertFalse((self.repo / ".tmp/hdt-review-checkpoints/test-workflow/closures").exists())
        _, plan = self.create_plan("record-size-plan")
        assert plan is not None
        plan_draft = {"verdict": "approved", "summary": "", "coverage_ledger": {
            "mode": "full", "sections": {section_id: {
                "disposition": "reviewed", "status": "validated", "depends_on": [],
                "invariants": ["Reviewed plan content."],
            } for section_id in plan["sections"]}, "deleted_section_ids_reviewed": [], "limitations": [],
        }}
        plan_draft["summary"] = "x" * (8 * 1024 * 1024 - len(json.dumps(plan_draft).encode()) - 128)
        result, _ = self.record_plan_review(plan, plan_draft, compose=True, expected=2)
        self.assertIn("read limit", result.stderr)

    def test_plan_revalidation_reopens_changes_dependencies_and_ancestors(self) -> None:
        self.write(
            "plan.md",
            """# Implementation Plan

Current executable plan.

<!-- hdt-section: scope -->
## Scope

Keep the existing API boundary.

<!-- hdt-section: wp-api -->
## WP-001 — API

Implement version one.

<!-- hdt-section: wp-tests -->
### WP-001.1 — Tests

Cover the API behavior.

<!-- hdt-section: wp-ui -->
## WP-002 — UI

Consume the API.
""",
        )
        _, first = self.create_plan("plan-1")
        assert first is not None
        first_sections = first["sections"]
        assert isinstance(first_sections, dict)
        root_id = next(
            section_id
            for section_id, section in first_sections.items()
            if section["title"] == "Implementation Plan"
        )
        dependencies = {
            "wp-tests": ["wp-api"],
            "wp-ui": ["wp-api"],
        }
        first_records = {
            section_id: {
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": dependencies.get(section_id, []),
                "invariants": [f"coverage:{section_id}"],
            }
            for section_id in first_sections
        }
        first_report = {
            "verdict": "approved",
            "checkpoint_id": "plan-1",
            "snapshot_sha256": first["snapshot_sha256"],
            "previous_checkpoint": None,
            "coverage_ledger": {
                "mode": "full",
                "sections": first_records,
                "deleted_section_ids_reviewed": [],
                "limitations": [],
            },
        }
        self.record_plan_review(first, first_report)

        plan_path = self.repo / "plan.md"
        plan_path.write_text(
            plan_path.read_text(encoding="utf-8").replace(
                "Implement version one.",
                "Implement version two.",
            ),
            encoding="utf-8",
        )
        _, second = self.create_plan("plan-2", previous="plan-1")
        assert second is not None
        _, delta = self.run_helper(
            "diff-plan",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "plan-1",
            "--to-checkpoint",
            "plan-2",
            "--repo",
            str(self.repo),
            "--include-patches",
        )
        assert delta is not None
        changes = {item["section_id"]: item for item in delta["changes"]}
        self.assertEqual(changes["wp-api"]["status"], "modified")
        self.assertEqual(changes[root_id]["status"], "descendant_changed")
        self.assertEqual(
            set(delta["dependency_affected_section_ids"]),
            {"wp-tests", "wp-ui"},
        )
        self.assertEqual(set(delta["carriable_section_ids"]), {"scope"})
        self.assertEqual(
            delta["carry_forward_sections"]["scope"]["disposition"],
            "carried_forward",
        )
        self.assertIn("-Implement version one.", changes["wp-api"]["patch"])
        self.assertIn("+Implement version two.", changes["wp-api"]["patch"])
        _, selected = self.run_helper(
            "diff-plan",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "plan-1",
            "--to-checkpoint",
            "plan-2",
            "--repo",
            str(self.repo),
            "--section",
            "wp-api",
            "--section",
            "scope",
        )
        assert selected is not None
        self.assertEqual(selected["selected_sections"]["wp-api"]["state"], "required")
        self.assertIn(
            "Implement version two.",
            selected["selected_sections"]["wp-api"]["current_text"],
        )
        self.assertEqual(selected["selected_sections"]["scope"]["state"], "closed")

        required = set(delta["required_review_section_ids"])
        second_records: dict[str, dict[str, object]] = {}
        for section_id in second["sections"]:
            if section_id == "scope":
                second_records[section_id] = {
                    **first_records[section_id],
                    "disposition": "carried_forward",
                    "carry_forward_rationale": "Exact content and dependencies are unaffected.",
                }
            else:
                self.assertIn(section_id, required)
                second_records[section_id] = {
                    **first_records[section_id],
                    "disposition": "reviewed",
                }
        second_report = {
            "verdict": "approved",
            "checkpoint_id": "plan-2",
            "snapshot_sha256": second["snapshot_sha256"],
            "previous_checkpoint": "plan-1",
            "impact_analysis": {
                "summary": "No unchanged section is affected beyond the dependency graph.",
                "additionally_affected_section_ids": [],
            },
            "coverage_ledger": {
                "mode": "incremental",
                "sections": second_records,
                "deleted_section_ids_reviewed": [],
                "limitations": [],
            },
        }
        invalid_impact_report = json.loads(json.dumps(second_report))
        invalid_impact_report["coverage_ledger"]["sections"]["scope"] = {
            **first_records["scope"],
            "disposition": "reviewed",
        }
        invalid_impact_report["impact_analysis"] = {
            "summary": "Scope was reopened even though it has no new dependency.",
            "additionally_affected_section_ids": ["scope"],
        }
        result, _ = self.record_plan_review(
            second,
            invalid_impact_report,
            expected=2,
        )
        self.assertIn("newly recorded dependency", result.stderr)
        self.record_plan_review(second, second_report)
        _, projection = self.run_helper(
            "plan-projection",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "plan-2",
            "--repo",
            str(self.repo),
            "--section",
            "wp-api",
            "--section",
            "scope",
        )
        assert projection is not None
        projected_sections = {
            section["section_id"]: section for section in projection["sections"]
        }
        self.assertIn("Implement version two.", projected_sections["wp-api"]["content"])
        self.assertIn("Keep the existing API boundary.", projected_sections["scope"]["content"])
        projection_identity = {
            key: value for key, value in projection.items() if key != "projection_sha256"
        }
        self.assertEqual(
            projection["projection_sha256"],
            self.canonical_digest(projection_identity),
        )
        _, verification = self.run_helper(
            "verify-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "plan-2",
            "--repo",
            str(self.repo),
        )
        assert verification is not None
        self.assertTrue(verification["valid"])

        _, match = self.run_helper(
            "matches-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "plan-2",
            "--repo",
            str(self.repo),
        )
        assert match is not None
        self.assertTrue(match["matches"])

        self.write(
            "plan.md",
            plan_path.read_text(encoding="utf-8").replace(
                "Keep the existing API boundary.",
                "Change the API boundary.",
            ),
        )
        _, mismatch = self.run_helper(
            "matches-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "plan-2",
            "--repo",
            str(self.repo),
            expected=1,
        )
        assert mismatch is not None
        self.assertFalse(mismatch["matches"])
        self.assertIn("scope", mismatch["delta"]["changed_section_ids"])

    def test_plan_review_rejects_incomplete_first_pass_and_unsafe_carry(self) -> None:
        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: scope -->
## Scope

Original scope.
""",
        )
        _, first = self.create_plan("plan-1")
        assert first is not None
        incomplete = {
            "verdict": "approved",
            "checkpoint_id": "plan-1",
            "snapshot_sha256": first["snapshot_sha256"],
            "previous_checkpoint": None,
            "coverage_ledger": {
                "mode": "full",
                "sections": {},
                "deleted_section_ids_reviewed": [],
                "limitations": [],
            },
        }
        result, _ = self.record_plan_review(first, incomplete, expected=2)
        self.assertIn("account for every current section", result.stderr)

        full_records = {
            section_id: {
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": [],
            }
            for section_id in first["sections"]
        }
        complete = {
            **incomplete,
            "coverage_ledger": {
                "mode": "full",
                "sections": full_records,
                "deleted_section_ids_reviewed": [],
                "limitations": [],
            },
        }
        self.record_plan_review(first, complete)

        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: scope -->
## Scope

Changed scope.
""",
        )
        _, second = self.create_plan("plan-2", previous="plan-1")
        assert second is not None
        unsafe_records = {
            section_id: {
                **full_records[section_id],
                "disposition": "carried_forward",
                "carry_forward_rationale": "Assumed unchanged.",
            }
            for section_id in second["sections"]
        }
        unsafe = {
            "verdict": "approved",
            "checkpoint_id": "plan-2",
            "snapshot_sha256": second["snapshot_sha256"],
            "previous_checkpoint": "plan-1",
            "impact_analysis": {
                "summary": "The changed scope is the only affected surface.",
                "additionally_affected_section_ids": [],
            },
            "coverage_ledger": {
                "mode": "incremental",
                "sections": unsafe_records,
                "deleted_section_ids_reviewed": [],
                "limitations": [],
            },
        }
        result, _ = self.record_plan_review(second, unsafe, expected=2)
        self.assertIn("omitted required sections", result.stderr)

    def test_plan_delta_tracks_explicit_move_rename_and_deletion(self) -> None:
        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: wp-one -->
## First package

One.

<!-- hdt-section: wp-two -->
## Second package

Two.
""",
        )
        self.create_plan("plan-1")
        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: wp-two -->
## Renamed second package

Two.
""",
        )
        self.create_plan("plan-2", previous="plan-1")
        _, delta = self.run_helper(
            "diff-plan",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "plan-1",
            "--to-checkpoint",
            "plan-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        changes = {item["section_id"]: item for item in delta["changes"]}
        self.assertEqual(changes["wp-one"]["status"], "deleted")
        self.assertEqual(changes["wp-two"]["status"], "modified")
        self.assertTrue(changes["wp-two"]["moved_or_renamed"])
        self.assertEqual(delta["deleted_section_ids"], ["wp-one"])

    def test_plan_insertion_does_not_mark_unchanged_siblings_as_moved(self) -> None:
        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: first -->
## First

One.

<!-- hdt-section: second -->
## Second

Two.
""",
        )
        self.create_plan("plan-1")
        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: inserted -->
## Inserted

New.

<!-- hdt-section: first -->
## First

One.

<!-- hdt-section: second -->
## Second

Two.
""",
        )
        self.create_plan("plan-2", previous="plan-1")
        _, delta = self.run_helper(
            "diff-plan",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "plan-1",
            "--to-checkpoint",
            "plan-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        changed_ids = {item["section_id"] for item in delta["changes"]}
        self.assertIn("inserted", changed_ids)
        self.assertNotIn("first", changed_ids)
        self.assertNotIn("second", changed_ids)

    def test_plan_review_must_account_for_deleted_sections(self) -> None:
        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: removable -->
## Removable package

Remove me later.
""",
        )
        _, first = self.create_plan("plan-1")
        assert first is not None
        first_records = {
            section_id: {
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": [],
            }
            for section_id in first["sections"]
        }
        self.record_plan_review(
            first,
            {
                "verdict": "approved",
                "checkpoint_id": "plan-1",
                "snapshot_sha256": first["snapshot_sha256"],
                "previous_checkpoint": None,
                "coverage_ledger": {
                    "mode": "full",
                    "sections": first_records,
                    "deleted_section_ids_reviewed": [],
                    "limitations": [],
                },
            },
        )
        self.write("plan.md", "# Plan\n")
        _, second = self.create_plan("plan-2", previous="plan-1")
        assert second is not None
        second_records = {
            section_id: {
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": [],
            }
            for section_id in second["sections"]
        }
        result, _ = self.record_plan_review(
            second,
            {
                "verdict": "approved",
                "checkpoint_id": "plan-2",
                "snapshot_sha256": second["snapshot_sha256"],
                "previous_checkpoint": "plan-1",
                "impact_analysis": {
                    "summary": "Removing the package affects the plan container.",
                    "additionally_affected_section_ids": [],
                },
                "coverage_ledger": {
                    "mode": "incremental",
                    "sections": second_records,
                    "deleted_section_ids_reviewed": [],
                    "limitations": [],
                },
            },
            expected=2,
        )
        self.assertIn("account for every deleted section", result.stderr)

    def test_plan_checkpoint_detects_blob_corruption(self) -> None:
        _, checkpoint = self.create_plan("plan-1")
        assert checkpoint is not None
        plan = checkpoint["plan"]
        digest = plan["sha256"]
        blob = self.repo / ".tmp/hdt-review-checkpoints/test-workflow/blobs" / digest[:2] / digest
        blob.write_bytes(b"corrupt")
        _, verification = self.run_helper(
            "verify-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "plan-1",
            "--repo",
            str(self.repo),
            expected=1,
        )
        assert verification is not None
        self.assertFalse(verification["valid"])

    def test_plan_parser_ignores_fenced_headings_and_rejects_duplicate_ids(self) -> None:
        self.write(
            "plan.md",
            """# Plan

```md
## Not a section
<!-- hdt-section: ignored -->
```

<!-- hdt-section: real -->
## Real section

Content.
""",
        )
        _, checkpoint = self.create_plan("plan-1")
        assert checkpoint is not None
        titles = {record["title"] for record in checkpoint["sections"].values()}
        self.assertEqual(titles, {"Plan", "Real section"})

        self.write(
            "plan.md",
            """# Plan

<!-- hdt-section: duplicate -->
## One

<!-- hdt-section: duplicate -->
## Two
""",
        )
        result, _ = self.create_plan("duplicate", expected=2)
        self.assertIn("Duplicate plan section ID", result.stderr)

        self.write(
            "plan.md",
            """Introductory contract.\n\n<!-- hdt-section: preamble -->\n# Reserved\n""",
        )
        result, _ = self.create_plan("reserved", expected=2)
        self.assertIn("reserved for document preamble", result.stderr)

    def test_dirty_submodules_reject_create_and_matches_despite_ignore_config(self) -> None:
        submodule = self.add_submodule()
        for scope in ("deps/library with spaces", "src/value.txt"):
            checkpoint_id = "scoped-submodule" if scope.startswith("deps/") else "outside-scope"
            self.create(checkpoint_id, "--path", scope)
            for kind in ("tracked", "staged", "untracked"):
                with self.subTest(scope=scope, kind=kind):
                    path = submodule / ("new.txt" if kind == "untracked" else "value.txt")
                    path.write_text("dirty content\n", encoding="utf-8")
                    if kind == "staged":
                        self.git("-C", str(submodule), "add", "value.txt")
                    created, _ = self.create(
                        f"{checkpoint_id}-{kind}", "--path", scope, expected=2
                    )
                    matched, _ = self.run_helper(
                        "matches", "--workflow-id", "test-workflow",
                        "--checkpoint-id", checkpoint_id, "--repo", str(self.repo), expected=2,
                    )
                    for result in (created, matched):
                        self.assertIn("dirty submodule: deps/library with spaces", result.stderr)
                    if kind == "untracked":
                        path.unlink()
                    else:
                        path.write_text("base\n", encoding="utf-8")
                        if kind == "staged":
                            self.git("-C", str(submodule), "add", "value.txt")

    def test_submodule_index_flags_cannot_hide_dirty_content(self) -> None:
        submodule = self.add_submodule(nested=True)
        self.create("visible-submodules", "--path", "deps/library with spaces")
        for directory in (submodule, submodule / "nested/leaf"):
            for flag in ("assume-unchanged", "skip-worktree"):
                with self.subTest(directory=directory.name, flag=flag):
                    self.git("-C", str(directory), "update-index", f"--{flag}", "value.txt")
                    result, _ = self.create("suppressed-submodule", "--path", "deps/library with spaces", expected=2)
                    self.assertIn("index flags", result.stderr)
                    (directory / "value.txt").write_text("hidden dirty bytes\n")
                    result, _ = self.run_helper(
                        "matches", "--workflow-id", "test-workflow", "--repo", str(self.repo),
                        "--checkpoint-id", "visible-submodules", expected=2,
                    )
                    self.assertIn("index flags", result.stderr)
                    (directory / "value.txt").write_text("base\n")
                    self.git("-C", str(directory), "update-index", f"--no-{flag}", "value.txt")
        self.run_helper("matches", "--workflow-id", "test-workflow", "--repo", str(self.repo), "--checkpoint-id", "visible-submodules")

    def test_nested_dirty_submodules_reject_create_and_matches(self) -> None:
        submodule = self.add_submodule(nested=True)
        leaf = submodule / "nested/leaf"
        self.create("nested-clean", "--path", "deps/library with spaces")
        for kind in ("tracked", "staged", "untracked"):
            with self.subTest(kind=kind):
                path = leaf / ("new.txt" if kind == "untracked" else "value.txt")
                path.write_text("dirty nested content\n", encoding="utf-8")
                if kind == "staged":
                    self.git("-C", str(leaf), "add", "value.txt")
                created, _ = self.create(
                    f"nested-{kind}", "--path", "deps/library with spaces", expected=2
                )
                matched, _ = self.run_helper(
                    "matches", "--workflow-id", "test-workflow",
                    "--checkpoint-id", "nested-clean", "--repo", str(self.repo), expected=2,
                )
                for result in (created, matched):
                    self.assertIn("dirty submodule: deps/library with spaces", result.stderr)
                if kind == "untracked":
                    path.unlink()
                else:
                    path.write_text("base\n", encoding="utf-8")
                    if kind == "staged":
                        self.git("-C", str(leaf), "add", "value.txt")

    def test_clean_submodule_head_changes_remain_checkpointable_and_detectable(self) -> None:
        submodule = self.add_submodule()
        _, first = self.create("gitlink-1", "--path", "deps/library with spaces")
        assert first is not None
        self.assertEqual(first["files"]["deps/library with spaces"]["kind"], "gitlink")
        _, unchanged = self.run_helper(
            "matches", "--workflow-id", "test-workflow",
            "--checkpoint-id", "gitlink-1", "--repo", str(self.repo),
        )
        assert unchanged is not None
        self.assertTrue(unchanged["matches"])
        (submodule / "value.txt").write_text("committed change\n", encoding="utf-8")
        self.git("-C", str(submodule), "add", "value.txt")
        self.git("-C", str(submodule), "commit", "-qm", "change submodule")
        _, changed = self.run_helper(
            "matches", "--workflow-id", "test-workflow",
            "--checkpoint-id", "gitlink-1", "--repo", str(self.repo), expected=1,
        )
        assert changed is not None
        self.assertFalse(changed["matches"])
        self.assertTrue(changed["delta"]["worktree_guard_changed"])
        self.assertEqual(changed["delta"]["changes"][0]["path"], "deps/library with spaces")
        _, second = self.create("gitlink-2", "--all-changes", "--isolated-worktree")
        assert second is not None
        self.assertIn("deps/library with spaces", second["files"])
        self.assertNotEqual(
            first["files"]["deps/library with spaces"]["sha256"],
            second["files"]["deps/library with spaces"]["sha256"],
        )

    def test_legacy_dirty_gitlink_checkpoint_cannot_match_different_dirty_bytes(self) -> None:
        submodule = self.add_submodule()
        _, legacy = self.create("legacy-gitlink", "--path", "deps/library with spaces")
        assert legacy is not None
        (submodule / "value.txt").write_text("legacy dirty version\n", encoding="utf-8")
        # Older checkpoints recorded only HEAD plus Git's generic '-dirty'
        # marker. Preserve that valid schema while recreating the unsafe state.
        diff = self.git(
            "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
            "--no-renames", "--no-color", "--ignore-submodules=none", legacy["base_commit"], "--",
        ).stdout.encode("utf-8")
        legacy["worktree_guard_sha256"] = hashlib.sha256(diff + b"\0UNTRACKED\0").hexdigest()
        legacy["snapshot_sha256"] = self.canonical_digest({
            key: legacy[key]
            for key in (
                "schema_version", "repo_root", "base_commit", "head_commit",
                "worktree_guard_sha256", "files", "plan",
            )
        })
        manifest_path = (
            self.repo / ".tmp/hdt-review-checkpoints/test-workflow/checkpoints/legacy-gitlink.json"
        )
        manifest_path.write_text(json.dumps(legacy), encoding="utf-8")
        _, verified = self.run_helper(
            "verify", "--workflow-id", "test-workflow",
            "--checkpoint-id", "legacy-gitlink", "--repo", str(self.repo),
        )
        assert verified is not None
        self.assertTrue(verified["valid"])
        (submodule / "value.txt").write_text("different dirty bytes\n", encoding="utf-8")
        result, _ = self.run_helper(
            "matches", "--workflow-id", "test-workflow",
            "--checkpoint-id", "legacy-gitlink", "--repo", str(self.repo), expected=2,
        )
        self.assertIn("dirty submodule: deps/library with spaces", result.stderr)

    def test_same_file_delta_and_worktree_drift_guard(self) -> None:
        self.write("src/value.txt", "first review\n")
        _, first = self.create("planner-1", "--path", "src/value.txt")
        assert first is not None
        self.assertTrue((self.repo / ".tmp").is_dir())
        store_mode = stat.S_IMODE((self.repo / ".tmp/hdt-review-checkpoints").stat().st_mode)
        self.assertEqual(store_mode, 0o700)

        self.write("src/value.txt", "corrected\n")
        self.write("unrelated.txt", "pre-existing user dirt\n")
        _, mismatch = self.run_helper(
            "matches",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "planner-1",
            "--repo",
            str(self.repo),
            expected=1,
        )
        assert mismatch is not None
        self.assertFalse(mismatch["matches"])
        self.assertTrue(mismatch["delta"]["worktree_guard_changed"])

        _, second = self.create(
            "planner-2",
            "--path",
            "src/value.txt",
            previous="planner-1",
        )
        assert second is not None
        self.assertNotIn("unrelated.txt", second["files"])

        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "planner-1",
            "--to-checkpoint",
            "planner-2",
            "--repo",
            str(self.repo),
            "--include-patches",
        )
        assert delta is not None
        self.assertEqual(delta["change_count"], 1)
        self.assertEqual(delta["changes"][0]["path"], "src/value.txt")
        self.assertIn("-first review", delta["changes"][0]["patch"])
        self.assertIn("+corrected", delta["changes"][0]["patch"])

        _, match = self.run_helper(
            "matches",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "planner-2",
            "--repo",
            str(self.repo),
        )
        assert match is not None
        self.assertTrue(match["matches"])

    def test_default_store_requires_ignored_tmp_without_creating_it(self) -> None:
        other = Path(self.temporary.name) / "unignored"
        other.mkdir()
        subprocess.run(["git", "-C", str(other), "init", "-q"], check=True)
        subprocess.run(
            ["git", "-C", str(other), "config", "user.name", "Checkpoint Tests"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(other), "config", "user.email", "checkpoint-tests@example.invalid"],
            check=True,
        )
        (other / "plan.md").write_text("plan\n", encoding="utf-8")
        (other / "value.txt").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(other), "add", "plan.md", "value.txt"], check=True)
        subprocess.run(["git", "-C", str(other), "commit", "-qm", "baseline"], check=True)
        (other / "value.txt").write_text("changed\n", encoding="utf-8")

        (other / ".git/info/exclude").write_text(".tmp/\n", encoding="utf-8")

        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "create",
                "--workflow-id",
                "test-workflow",
                "--checkpoint-id",
                "first",
                "--repo",
                str(other),
                "--plan",
                str(other / "plan.md"),
                "--path",
                "value.txt",
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("repository .gitignore", result.stderr)
        self.assertFalse((other / ".tmp").exists())

        (other / ".git/info/exclude").write_text("", encoding="utf-8")
        global_ignore = Path(self.temporary.name) / "global-ignore"
        global_ignore.write_text(".tmp/\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(other), "config", "core.excludesFile", str(global_ignore)],
            check=True,
        )
        result = subprocess.run(result.args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 2)
        self.assertIn("outside the repository", result.stderr)
        self.assertFalse((other / ".tmp").exists())

        subprocess.run(
            ["git", "-C", str(other), "config", "--unset", "core.excludesFile"],
            check=True,
        )
        (other / ".gitignore").write_text(
            ".tmp/*\n!.tmp/hdt-review-checkpoints/\n!.tmp/hdt-review-checkpoints/**\n",
            encoding="utf-8",
        )
        result = subprocess.run(result.args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not fully ignored", result.stderr)
        self.assertFalse((other / ".tmp").exists())

        (other / ".gitignore").write_text(
            "\n".join(
                [
                    ".tmp/hdt-review-checkpoints/.hdt-store-probe",
                    ".tmp/hdt-review-checkpoints/probe/checkpoints/checkpoint.json",
                    ".tmp/hdt-review-checkpoints/probe/blobs/aa/digest",
                    ".tmp/hdt-review-checkpoints/probe/reviews/expert/checkpoint.json",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        result = subprocess.run(result.args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not fully ignored", result.stderr)
        self.assertFalse((other / ".tmp").exists())

    def test_plan_change_duplicate_and_corruption_fail_closed(self) -> None:
        self.write("src/value.txt", "reviewed\n")
        _, first = self.create("expert-1", "--path", "src/value.txt")
        assert first is not None
        manifest_path = self.repo / ".tmp/hdt-review-checkpoints/test-workflow/checkpoints/expert-1.json"
        self.assertEqual(stat.S_IMODE(manifest_path.stat().st_mode), 0o600)

        duplicate, _ = self.create(
            "expert-1",
            "--path",
            "src/value.txt",
            expected=2,
        )
        self.assertIn("immutable", duplicate.stderr)

        self.write("plan.md", "changed plan\n")
        changed_plan, _ = self.create(
            "expert-2",
            "--path",
            "src/value.txt",
            previous="expert-1",
            expected=2,
        )
        self.assertIn("approved plan changed", changed_plan.stderr)
        self.write("plan.md", "# Approved plan\n\nImplement the behavior.\n")

        file_digest = first["files"]["src/value.txt"]["sha256"]
        blob = self.repo / ".tmp/hdt-review-checkpoints/test-workflow/blobs" / file_digest[:2] / file_digest
        blob.write_bytes(b"corrupt")
        _, verification = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "expert-1",
            "--repo",
            str(self.repo),
            expected=1,
        )
        assert verification is not None
        self.assertFalse(verification["valid"])

        blob.write_bytes(b"reviewed\n")
        blob.chmod(0o600)
        manifest_payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_payload["files"]["src/value.txt"]["sha256"] = "../not-a-digest"
        manifest_path.write_text(json.dumps(manifest_payload), encoding="utf-8")
        manifest_path.chmod(0o600)
        malformed, _ = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "expert-1",
            "--repo",
            str(self.repo),
            expected=2,
        )
        self.assertIn("lowercase SHA-256", malformed.stderr)

    def test_delta_tracks_rename_binary_mode_and_large_patch_limit(self) -> None:
        self.write("src/mode.sh", "#!/bin/sh\nexit 0\n")
        self.git("add", "src/mode.sh")
        self.git("commit", "-qm", "add mode fixture")

        self.write("src/new file.txt", "rename me\n")
        self.write("src/data.bin", b"\x00first")
        self.write("src/large.txt", b"a" * (2 * 1024 * 1024 + 1))
        self.write("src/value.txt", "will be deleted\n")
        os.symlink("../plan.md", self.repo / "src/plan-link")
        mode_path = self.repo / "src/mode.sh"
        mode_path.chmod(mode_path.stat().st_mode | stat.S_IXUSR)
        _, first = self.create(
            "expert-1",
            "--all-changes",
            "--isolated-worktree",
        )
        assert first is not None

        (self.repo / "src/new file.txt").rename(self.repo / "src/renamed file.txt")
        self.write("src/data.bin", b"\x00second")
        self.write("src/large.txt", b"b" * (2 * 1024 * 1024 + 1))
        (self.repo / "src/value.txt").unlink()
        (self.repo / "src/plan-link").unlink()
        os.symlink("renamed file.txt", self.repo / "src/plan-link")
        mode_path.chmod(mode_path.stat().st_mode & ~stat.S_IXUSR)
        self.create(
            "expert-2",
            "--all-changes",
            "--isolated-worktree",
            previous="expert-1",
        )

        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "expert-1",
            "--to-checkpoint",
            "expert-2",
            "--repo",
            str(self.repo),
            "--include-patches",
        )
        assert delta is not None
        self.assertEqual(
            delta["renames"],
            [{"from": "src/new file.txt", "to": "src/renamed file.txt"}],
        )
        changes = {item["path"]: item for item in delta["changes"]}
        self.assertEqual(changes["src/mode.sh"]["status"], "mode_changed")
        self.assertEqual(changes["src/value.txt"]["status"], "deleted")
        self.assertEqual(changes["src/plan-link"]["status"], "modified")
        self.assertTrue(changes["src/data.bin"]["binary_or_gitlink"])
        self.assertIsNone(changes["src/large.txt"]["patch"])

    def test_delta_digest_is_patch_presentation_independent_and_records(self) -> None:
        self.write("src/value.txt", "first delta value\n")
        _, first = self.create("patch-delta-1", "--path", "src/value.txt")
        assert first is not None
        _, first_record = self.record_review(
            first,
            "planner",
            self.strict_report(first, "planner"),
        )
        assert first_record is not None

        self.write("src/value.txt", "second delta value\n")
        _, second = self.create(
            "patch-delta-2",
            "--path",
            "src/value.txt",
            previous="patch-delta-1",
        )
        assert second is not None
        _, compact = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "patch-delta-1",
            "--to-checkpoint",
            "patch-delta-2",
            "--repo",
            str(self.repo),
        )
        _, detailed = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "patch-delta-1",
            "--to-checkpoint",
            "patch-delta-2",
            "--repo",
            str(self.repo),
            "--include-patches",
        )
        assert compact is not None and detailed is not None
        self.assertEqual(compact["delta_sha256"], detailed["delta_sha256"])
        self.assertNotIn("patch", compact["changes"][0])
        self.assertIn("second delta value", detailed["changes"][0]["patch"])

        report = self.strict_report(
            second,
            "planner",
            previous_checkpoint=first,
            previous_review_sha256=str(first_record["report_sha256"]),
            delta_sha256=str(detailed["delta_sha256"]),
            impact_analysis={
                "summary": "The changed task surface was directly reviewed.",
                "additionally_affected_surface_ids": [],
            },
            mode="incremental",
        )
        self.record_review(second, "planner", report)

    def test_sensitive_paths_and_symlink_traversal_are_rejected(self) -> None:
        self.write(".env.local", "TOKEN=secret\n")
        sensitive, _ = self.create(
            "sensitive",
            "--path",
            ".env.local",
            expected=2,
        )
        self.assertIn("sensitive-looking", sensitive.stderr)

        external = Path(self.temporary.name) / "external"
        external.mkdir()
        (external / "data.txt").write_text("outside\n", encoding="utf-8")
        os.symlink(external, self.repo / "linked-directory")
        escaped, _ = self.create(
            "escaped",
            "--path",
            "linked-directory/data.txt",
            expected=2,
        )
        self.assertIn("intermediate symlink", escaped.stderr)

    def test_previous_checkpoint_inherits_base_across_head_change(self) -> None:
        self.write("src/value.txt", "reviewed\n")
        _, first = self.create("planner-1", "--path", "src/value.txt")
        assert first is not None
        self.git("add", "src/value.txt")
        self.git("commit", "-qm", "checkpointed implementation")

        _, second = self.create(
            "planner-2",
            "--path",
            "src/value.txt",
            previous="planner-1",
        )
        assert second is not None
        self.assertEqual(first["base_commit"], second["base_commit"])
        self.assertNotEqual(first["head_commit"], second["head_commit"])

    def test_explicit_successor_keeps_new_path_after_deletion(self) -> None:
        self.write("src/new.txt", "first review\n")
        self.create("planner-1", "--path", "src/new.txt")
        (self.repo / "src/new.txt").unlink()
        self.create(
            "planner-2",
            "--path",
            "src/new.txt",
            previous="planner-1",
        )
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "planner-1",
            "--to-checkpoint",
            "planner-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        self.assertEqual(delta["changes"][0]["path"], "src/new.txt")
        self.assertEqual(delta["changes"][0]["status"], "deleted")

    def test_successor_rejects_identical_plan_at_a_different_path(self) -> None:
        self.write("src/value.txt", "reviewed\n")
        self.create("planner-1", "--path", "src/value.txt")
        second_plan = self.write(
            ".tmp/same-plan.md",
            "# Approved plan\n\nImplement the behavior.\n",
        )
        result, _ = self.run_helper(
            "create",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "planner-2",
            "--repo",
            str(self.repo),
            "--plan",
            str(second_plan),
            "--path",
            "src/value.txt",
            "--previous",
            "planner-1",
            expected=2,
        )
        self.assertIn("plan path changed", result.stderr)

    def test_filesystem_inputs_stores_and_outputs_reject_symlink_victims(self) -> None:
        self.write("src/value.txt", "filesystem hardening\n")
        external = Path(self.temporary.name) / "external"
        external.mkdir()

        (self.repo / ".tmp").mkdir(exist_ok=True)
        nested_store_target = external / "escaped-store"
        nested_store_target.mkdir()
        os.symlink(nested_store_target, self.repo / ".tmp/hdt-review-checkpoints")
        escaped, _ = self.create("escaped", "--path", "src/value.txt", expected=2)
        self.assertIn("symlink component", escaped.stderr)
        (self.repo / ".tmp/hdt-review-checkpoints").unlink()

        real_plan = external / "plan.md"
        real_plan.write_text("# External plan\n", encoding="utf-8")
        os.symlink(real_plan, self.repo / ".tmp/plan-link.md")
        final_plan, _ = self.run_helper(
            "create",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "plan-link",
            "--repo",
            str(self.repo),
            "--plan",
            str(self.repo / ".tmp/plan-link.md"),
            "--path",
            "src/value.txt",
            expected=2,
        )
        self.assertIn("symlink component", final_plan.stderr)

        paths_file = self.repo / ".tmp/paths.txt"
        paths_file.write_text("src/value.txt\n", encoding="utf-8")
        os.symlink(paths_file, self.repo / ".tmp/paths-link.txt")
        paths_link, _ = self.run_helper(
            "create",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "paths-link",
            "--repo",
            str(self.repo),
            "--plan",
            str(self.repo / "plan.md"),
            "--paths-from",
            str(self.repo / ".tmp/paths-link.txt"),
            expected=2,
        )
        self.assertIn("symlink component", paths_link.stderr)

        _, checkpoint = self.create("safe-output", "--path", "src/value.txt")
        assert checkpoint is not None
        report = self.strict_report(checkpoint, "expert")
        real_report = self.repo / ".tmp/real-report.json"
        real_report.write_text(json.dumps(report), encoding="utf-8")
        os.symlink(real_report, self.repo / ".tmp/report-link.json")
        report_link, _ = self.run_helper(
            "record-review",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "safe-output",
            "--repo",
            str(self.repo),
            "--gate",
            "expert",
            "--report",
            str(self.repo / ".tmp/report-link.json"),
            expected=2,
        )
        self.assertIn("symlink component", report_link.stderr)

        external_reviews = external / "reviews"
        external_reviews.mkdir()
        reviews_path = (
            self.repo / ".tmp/hdt-review-checkpoints/test-workflow/reviews"
        )
        os.symlink(external_reviews, reviews_path)
        internal_store_link, _ = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "safe-output",
            "--repo",
            str(self.repo),
            expected=2,
        )
        self.assertIn("symlink component", internal_store_link.stderr)
        reviews_path.unlink()

        victim = external / "victim.json"
        victim.write_text("preserve me\n", encoding="utf-8")
        output_link = external / "output.json"
        os.symlink(victim, output_link)
        output_rejected, _ = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "safe-output",
            "--repo",
            str(self.repo),
            "--output",
            str(output_link),
            expected=2,
        )
        self.assertIn("regular non-symlink", output_rejected.stderr)
        self.assertTrue(output_link.is_symlink())
        self.assertEqual(victim.read_text(encoding="utf-8"), "preserve me\n")

        external_store_target = external / "store-target"
        external_store_target.mkdir()
        os.symlink(external_store_target, external / "store-link")
        store_link, _ = self.run_helper(
            "create",
            "--workflow-id",
            "external-workflow",
            "--checkpoint-id",
            "store-link",
            "--repo",
            str(self.repo),
            "--store",
            str(external / "store-link"),
            "--plan",
            str(self.repo / "plan.md"),
            "--path",
            "src/value.txt",
            expected=2,
        )
        self.assertIn("regular directory", store_link.stderr)

        intermediate_store_target = external / "intermediate-store"
        intermediate_store_target.mkdir()
        os.symlink(intermediate_store_target, self.repo / ".tmp/store-parent")
        intermediate_store, _ = self.run_helper(
            "create",
            "--workflow-id",
            "external-workflow",
            "--checkpoint-id",
            "intermediate-store",
            "--repo",
            str(self.repo),
            "--store",
            str(self.repo / ".tmp/store-parent/nested"),
            "--plan",
            str(self.repo / "plan.md"),
            "--path",
            "src/value.txt",
            expected=2,
        )
        self.assertIn("symlink component", intermediate_store.stderr)

    def test_explicit_external_paths_allow_parent_aliases_and_write_private_outputs(self) -> None:
        self.write("src/value.txt", "external path support\n")
        external = Path(self.temporary.name) / "external-real"
        external.mkdir()
        alias = Path(self.temporary.name) / "external-alias"
        os.symlink(external, alias)
        (external / "plan.md").write_text("# External approved plan\n", encoding="utf-8")
        (external / "paths.txt").write_text("src/value.txt\n", encoding="utf-8")

        self.run_helper(
            "create",
            "--workflow-id",
            "external-workflow",
            "--checkpoint-id",
            "external-1",
            "--repo",
            str(self.repo),
            "--store",
            str(alias / "store"),
            "--plan",
            str(alias / "plan.md"),
            "--paths-from",
            str(alias / "paths.txt"),
            "--output",
            str(alias / "create-output.json"),
        )
        output = external / "create-output.json"
        self.assertTrue(output.is_file())
        checkpoint = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(checkpoint["checkpoint_id"], "external-1")
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertTrue((external / "store").is_dir())
        self.assertEqual(stat.S_IMODE((external / "store").stat().st_mode), 0o700)

        report = self.strict_report(checkpoint, "expert")
        (external / "report.json").write_text(json.dumps(report), encoding="utf-8")
        self.run_helper(
            "record-review",
            "--workflow-id",
            "external-workflow",
            "--checkpoint-id",
            "external-1",
            "--repo",
            str(self.repo),
            "--store",
            str(alias / "store"),
            "--gate",
            "expert",
            "--report",
            str(alias / "report.json"),
            "--output",
            str(alias / "review-output.json"),
        )
        review_output = external / "review-output.json"
        self.assertTrue(review_output.is_file())
        self.assertEqual(stat.S_IMODE(review_output.stat().st_mode), 0o600)

        source = SCRIPT.read_text(encoding="utf-8")
        write_output_source = source[
            source.index("def write_output(") : source.index("\ndef add_store_argument(")
        ]
        replace_offset = write_output_source.index("os.replace(")
        replace_tail = write_output_source[replace_offset:]
        self.assertIn(
            'os.mkdir(candidate, mode=0o700, dir_fd=parent_descriptor)',
            write_output_source,
        )
        self.assertIn("os.fchmod(temporary.fileno(), 0o600)", write_output_source)
        self.assertIn("src_dir_fd=staging_descriptor", replace_tail)
        self.assertEqual(replace_tail.count("output"), 1)

    def test_external_output_private_staging_blocks_parent_source_substitution(self) -> None:
        from unittest import mock
        import runpy

        external = Path(self.temporary.name) / "mutable-external"
        external.mkdir(mode=0o777)
        output = external / "result.json"
        output.write_text("preserve until replacement\n", encoding="utf-8")
        victim = external / "victim.txt"
        victim.write_text("victim stays unchanged\n", encoding="utf-8")
        runtime = runpy.run_path(str(SCRIPT))
        write_output = runtime["write_output"]
        original_replace = os.replace
        attack_attempted = False
        attack_blocked = False

        def adversarial_replace(source: str, destination: str, **kwargs: object) -> None:
            nonlocal attack_attempted, attack_blocked
            staging_directories = list(external.glob(".hdt-output-*"))
            self.assertEqual(len(staging_directories), 1)
            staging_metadata = staging_directories[0].lstat()
            self.assertTrue(stat.S_ISDIR(staging_metadata.st_mode))
            self.assertEqual(stat.S_IMODE(staging_metadata.st_mode), 0o700)
            attack_source = external / "attacker-source"
            os.symlink(victim, attack_source)
            attack_attempted = True
            try:
                original_replace(attack_source, staging_directories[0])
            except OSError:
                attack_blocked = True
            original_replace(source, destination, **kwargs)

        payload = {"installed_by_helper": True}
        with mock.patch.object(os, "replace", side_effect=adversarial_replace):
            write_output(payload, str(output), self.repo)

        metadata = output.lstat()
        self.assertTrue(attack_attempted)
        self.assertTrue(attack_blocked)
        self.assertTrue(stat.S_ISREG(metadata.st_mode))
        self.assertFalse(output.is_symlink())
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), payload)
        self.assertEqual(victim.read_text(encoding="utf-8"), "victim stays unchanged\n")
        self.assertEqual(list(external.glob(".hdt-output-*")), [])

    def test_strict_report_rejects_malformed_and_incomplete_surface_ledgers(self) -> None:
        self.write("src/value.txt", "strict schema\n")
        _, checkpoint = self.create(
            "strict-shapes",
            "--path",
            "src/value.txt",
            "--path",
            "src/helper.txt",
        )
        assert checkpoint is not None

        raw_report_path = self.repo / ".tmp/raw-review.json"
        for raw in (None, 7, []):
            with self.subTest(raw=raw):
                raw_report_path.write_text(json.dumps(raw), encoding="utf-8")
                result, _ = self.run_helper(
                    "record-review",
                    "--workflow-id",
                    "test-workflow",
                    "--checkpoint-id",
                    "strict-shapes",
                    "--repo",
                    str(self.repo),
                    "--gate",
                    "planner",
                    "--report",
                    str(raw_report_path),
                    expected=2,
                )
                self.assertIn("JSON object", result.stderr)

        base = self.strict_report(checkpoint, "planner")
        malformed_ledgers = [
            None,
            "not-an-object",
            {"mode": "full", "surfaces": {}, "surface_transitions": [], "limitations": []},
            {
                "mode": "full",
                "surfaces": {
                    "partial": {
                        "paths": ["src/value.txt"],
                        "disposition": "reviewed",
                        "status": "validated",
                        "depends_on": [],
                        "invariants": ["Partial coverage is intentionally invalid."],
                        "finding_ids": [],
                    }
                },
                "surface_transitions": [],
                "limitations": [],
            },
            {
                "mode": "full",
                "surfaces": {
                    "unknown": {
                        "paths": ["unknown.txt"],
                        "disposition": "reviewed",
                        "status": "validated",
                        "depends_on": [],
                        "invariants": ["Unknown paths are invalid."],
                        "finding_ids": [],
                    }
                },
                "surface_transitions": [],
                "limitations": [],
            },
        ]
        for index, ledger in enumerate(malformed_ledgers):
            with self.subTest(ledger=index):
                report = json.loads(json.dumps(base))
                report["coverage_ledger"] = ledger
                result, _ = self.record_review(checkpoint, "planner", report, expected=2)
                self.assertIn("coverage", result.stderr.lower())

    def test_strict_report_rejects_first_incremental_and_blank_semantic_text(self) -> None:
        self.write("src/value.txt", "semantic text review\n")
        _, first = self.create("semantic-text-1", "--path", "src/value.txt")
        assert first is not None

        first_incremental = self.strict_report(
            first,
            "expert",
            mode="incremental",
            impact_analysis={
                "summary": "A first pass cannot have incremental impact analysis.",
                "additionally_affected_surface_ids": [],
            },
        )
        rejected, _ = self.record_review(first, "expert", first_incremental, expected=2)
        self.assertIn("first review must use full", rejected.stderr)

        finding = {
            "finding_id": "SEMANTIC-001",
            "kind": "finding",
            "severity": "medium",
            "summary": "Semantic evidence must contain text.",
            "impact": "Blank evidence cannot support a strict finding.",
            "recommended_action": "Supply substantive evidence.",
            "evidence": ["Substantive evidence."],
            "affected_surface_ids": ["task-scope"],
        }
        finding_report = self.strict_report(
            first,
            "expert",
            verdict="rework_required",
            blocking_findings=[json.loads(json.dumps(finding))],
        )
        finding_report["blocking_findings"][0]["evidence"] = ["   "]
        rejected, _ = self.record_review(first, "expert", finding_report, expected=2)
        self.assertIn("non-empty strings", rejected.stderr)

        for field in ("invariants", "limitations"):
            with self.subTest(field=field):
                report = self.strict_report(first, "expert")
                if field == "invariants":
                    report["coverage_ledger"]["surfaces"]["task-scope"][field] = ["\t"]
                else:
                    report["coverage_ledger"][field] = ["\n"]
                rejected, _ = self.record_review(first, "expert", report, expected=2)
                self.assertIn("non-empty strings", rejected.stderr)

        _, first_record = self.record_review(
            first,
            "expert",
            self.strict_report(
                first,
                "expert",
                verdict="rework_required",
                blocking_findings=[finding],
            ),
        )
        assert first_record is not None
        self.write("src/value.txt", "semantic evidence corrected\n")
        _, second = self.create(
            "semantic-text-2",
            "--path",
            "src/value.txt",
            previous="semantic-text-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "semantic-text-1",
            "--to-checkpoint",
            "semantic-text-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        successor = self.strict_report(
            second,
            "expert",
            previous_checkpoint=first,
            previous_review_sha256=str(first_record["report_sha256"]),
            delta_sha256=str(delta["delta_sha256"]),
            prior_finding_results=[
                {
                    "finding_id": "SEMANTIC-001",
                    "result": "resolved",
                    "evidence": ["   "],
                    "reviewed_surface_ids": ["task-scope"],
                }
            ],
            mode="full",
        )
        rejected, _ = self.record_review(second, "expert", successor, expected=2)
        self.assertIn("non-empty strings", rejected.stderr)

    def test_two_checkpoint_planner_and_expert_cycles_reopen_and_carry_surfaces(self) -> None:
        self.write("src/value.txt", "first reviewed result\n")
        _, first = self.create(
            "strict-cycle-1",
            "--path",
            "src/value.txt",
            "--path",
            "src/helper.txt",
            "--path",
            "src/consumer.txt",
            "--path",
            "docs/note.md",
        )
        assert first is not None

        def surfaces_with_finding(finding_id: str) -> dict[str, dict[str, object]]:
            return {
                "core": {
                    "paths": ["src/value.txt", "src/helper.txt"],
                    "disposition": "reviewed",
                    "status": "finding",
                    "depends_on": [],
                    "invariants": ["Core behavior is internally consistent."],
                    "finding_ids": [finding_id],
                },
                "consumer": {
                    "paths": ["src/consumer.txt"],
                    "disposition": "reviewed",
                    "status": "validated",
                    "depends_on": ["core"],
                    "invariants": ["Consumer behavior follows the core contract."],
                    "finding_ids": [],
                },
                "documentation": {
                    "paths": ["docs/note.md"],
                    "disposition": "reviewed",
                    "status": "validated",
                    "depends_on": [],
                    "invariants": ["Documentation matches reviewed behavior."],
                    "finding_ids": [],
                },
            }

        records: dict[str, dict[str, object]] = {}
        for gate in ("planner", "expert"):
            finding_id = f"{gate.upper()}-001"
            finding: dict[str, object] = {
                "finding_id": finding_id,
                "kind": "finding",
                "summary": "The reviewed value still needs correction.",
                "impact": "The consumer can observe the wrong behavior.",
                "recommended_action": "Correct the value and re-review its dependents.",
                "evidence": ["src/value.txt contains the pre-correction value."],
                "affected_surface_ids": ["core"],
            }
            if gate == "planner":
                finding["plan_clause_ids"] = ["WP-CORE"]
            else:
                finding["severity"] = "medium"
            first_report = self.strict_report(
                first,
                gate,
                verdict="rework_required",
                surfaces=surfaces_with_finding(finding_id),
                blocking_findings=[finding],
            )
            _, record = self.record_review(first, gate, first_report)
            assert record is not None
            records[gate] = record

        _, first_verification = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "strict-cycle-1",
            "--repo",
            str(self.repo),
            "--require-review",
            "planner",
            expected=1,
        )
        assert first_verification is not None
        self.assertEqual(first_verification["planner_review_state"], "strict-rework-required")

        self.write("src/value.txt", "corrected reviewed result\n")
        _, second = self.create(
            "strict-cycle-2",
            "--path",
            "src/value.txt",
            previous="strict-cycle-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "strict-cycle-1",
            "--to-checkpoint",
            "strict-cycle-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        delta_sha256 = str(delta["delta_sha256"])
        second_surfaces = {
            "core": {
                "paths": ["src/value.txt", "src/helper.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Core behavior is internally consistent."],
                "finding_ids": [],
            },
            "consumer": {
                "paths": ["src/consumer.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": ["core"],
                "invariants": ["Consumer behavior follows the core contract."],
                "finding_ids": [],
            },
            "documentation": {
                "paths": ["docs/note.md"],
                "disposition": "carried_forward",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Documentation matches reviewed behavior."],
                "finding_ids": [],
                "carry_forward_rationale": "The correction cannot reach this independent surface.",
            },
        }
        for gate in ("planner", "expert"):
            finding_id = f"{gate.upper()}-001"
            second_report = self.strict_report(
                second,
                gate,
                surfaces=second_surfaces,
                previous_checkpoint=first,
                previous_review_sha256=str(records[gate]["report_sha256"]),
                delta_sha256=delta_sha256,
                prior_finding_results=[
                    {
                        "finding_id": finding_id,
                        "result": "resolved",
                        "evidence": ["src/value.txt contains the corrected value."],
                        "reviewed_surface_ids": ["core"],
                    }
                ],
                impact_analysis={
                    "summary": "Core changed and its transitive consumer reopened; documentation is independent.",
                    "additionally_affected_surface_ids": [],
                },
                mode="incremental",
            )
            self.record_review(second, gate, second_report)

        _, approved = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "strict-cycle-2",
            "--repo",
            str(self.repo),
            "--require-review",
            "planner",
            "--require-review",
            "expert",
        )
        assert approved is not None
        self.assertTrue(approved["required_reviews_satisfied"])

    def test_incremental_review_rejects_changed_affected_finding_and_modified_carry(self) -> None:
        self.write("src/value.txt", "first carry result\n")
        _, first = self.create(
            "carry-reject-1",
            "--path",
            "src/value.txt",
            "--path",
            "src/helper.txt",
            "--path",
            "src/consumer.txt",
            "--path",
            "docs/note.md",
        )
        assert first is not None
        finding = {
            "finding_id": "PLANNER-CARRY-001",
            "kind": "finding",
            "summary": "The risk surface is not yet validated.",
            "impact": "Its evidence cannot be carried into the next review.",
            "recommended_action": "Review the risk surface after correction.",
            "evidence": ["src/helper.txt still represents an open finding."],
            "affected_surface_ids": ["risk"],
            "plan_clause_ids": ["WP-RISK"],
        }
        first_surfaces = {
            "core": {
                "paths": ["src/value.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Core value is reviewed."],
                "finding_ids": [],
            },
            "consumer": {
                "paths": ["src/consumer.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": ["core"],
                "invariants": ["Consumer follows core."],
                "finding_ids": [],
            },
            "risk": {
                "paths": ["src/helper.txt"],
                "disposition": "reviewed",
                "status": "finding",
                "depends_on": [],
                "invariants": ["Risk evidence is resolved before approval."],
                "finding_ids": ["PLANNER-CARRY-001"],
            },
            "documentation": {
                "paths": ["docs/note.md"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Documentation is accurate."],
                "finding_ids": [],
            },
        }
        first_report = self.strict_report(
            first,
            "planner",
            verdict="rework_required",
            surfaces=first_surfaces,
            blocking_findings=[finding],
        )
        _, first_record = self.record_review(first, "planner", first_report)
        assert first_record is not None

        self.write("src/value.txt", "changed carry result\n")
        _, second = self.create(
            "carry-reject-2",
            "--path",
            "src/value.txt",
            previous="carry-reject-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "carry-reject-1",
            "--to-checkpoint",
            "carry-reject-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        second_surfaces = json.loads(json.dumps(first_surfaces))
        second_surfaces["risk"]["status"] = "validated"
        second_surfaces["risk"]["finding_ids"] = []
        second_surfaces["documentation"]["disposition"] = "carried_forward"
        second_surfaces["documentation"]["carry_forward_rationale"] = (
            "Documentation is independent of the code correction."
        )
        base = self.strict_report(
            second,
            "planner",
            surfaces=second_surfaces,
            previous_checkpoint=first,
            previous_review_sha256=str(first_record["report_sha256"]),
            delta_sha256=str(delta["delta_sha256"]),
            prior_finding_results=[
                {
                    "finding_id": "PLANNER-CARRY-001",
                    "result": "resolved",
                    "evidence": ["The risk surface was directly reviewed after correction."],
                    "reviewed_surface_ids": ["risk"],
                }
            ],
            impact_analysis={
                "summary": "Core, its consumer, and the prior-finding surface reopened.",
                "additionally_affected_surface_ids": [],
            },
            mode="incremental",
        )

        for surface_id in ("core", "consumer", "risk"):
            with self.subTest(surface=surface_id):
                report = json.loads(json.dumps(base))
                surface = report["coverage_ledger"]["surfaces"][surface_id]
                surface["disposition"] = "carried_forward"
                surface["carry_forward_rationale"] = "This invalid carry must be rejected."
                result, _ = self.record_review(second, "planner", report, expected=2)
                expected_message = (
                    "Prior result" if surface_id == "risk" else "omitted required surfaces"
                )
                self.assertIn(expected_message, result.stderr)

        metadata_changed = json.loads(json.dumps(base))
        metadata_changed["coverage_ledger"]["surfaces"]["documentation"]["invariants"] = [
            "Changed carry metadata is not prior evidence."
        ]
        result, _ = self.record_review(second, "planner", metadata_changed, expected=2)
        self.assertIn("changed its invariants", result.stderr)

    def test_surface_transitions_require_complete_mapping_and_direct_review(self) -> None:
        self.write("src/value.txt", "transition one\n")
        _, first = self.create(
            "transition-1",
            "--path",
            "src/value.txt",
            "--path",
            "src/helper.txt",
        )
        assert first is not None
        first_surfaces = {
            "legacy-core": {
                "paths": ["src/value.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Core behavior is reviewed."],
                "finding_ids": [],
            },
            "stable": {
                "paths": ["src/helper.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Stable helper behavior is reviewed."],
                "finding_ids": [],
            },
        }
        _, first_record = self.record_review(
            first,
            "planner",
            self.strict_report(first, "planner", surfaces=first_surfaces),
        )
        assert first_record is not None

        self.write("src/value.txt", "transition two\n")
        _, second = self.create(
            "transition-2",
            "--path",
            "src/value.txt",
            previous="transition-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "transition-1",
            "--to-checkpoint",
            "transition-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        current_surfaces = {
            "core": {
                "paths": ["src/value.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Core behavior is reviewed."],
                "finding_ids": [],
            },
            "stable": {
                "paths": ["src/helper.txt"],
                "disposition": "carried_forward",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Stable helper behavior is reviewed."],
                "finding_ids": [],
                "carry_forward_rationale": "The renamed core cannot affect this helper.",
            },
        }
        report = self.strict_report(
            second,
            "planner",
            surfaces=current_surfaces,
            previous_checkpoint=first,
            previous_review_sha256=str(first_record["report_sha256"]),
            delta_sha256=str(delta["delta_sha256"]),
            impact_analysis={
                "summary": "The renamed core is directly reviewed; the stable helper is unaffected.",
                "additionally_affected_surface_ids": [],
            },
            mode="incremental",
        )
        missing, _ = self.record_review(second, "planner", report, expected=2)
        self.assertIn("completely map", missing.stderr)

        report["coverage_ledger"]["surface_transitions"] = [
            {
                "kind": "renamed",
                "from_surface_ids": ["legacy-core"],
                "to_surface_ids": ["core"],
                "rationale": "The same semantic boundary now uses its current stable name.",
            }
        ]
        self.record_review(second, "planner", report)

    def test_missing_and_legacy_reviews_are_unqualified_but_full_strict_recovers(self) -> None:
        self.write("src/value.txt", "legacy review\n")
        _, first = self.create("legacy-1", "--path", "src/value.txt")
        assert first is not None
        _, missing = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "legacy-1",
            "--repo",
            str(self.repo),
        )
        assert missing is not None
        self.assertEqual(missing["planner_review_state"], "missing")

        legacy_report = {
            "verdict": "approved",
            "checkpoint_id": "legacy-1",
            "snapshot_sha256": first["snapshot_sha256"],
            "coverage_ledger": {"validated_surfaces": ["legacy"], "limitations": []},
        }
        legacy_path = (
            self.repo
            / ".tmp/hdt-review-checkpoints/test-workflow/reviews/planner/legacy-1.json"
        )
        legacy_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_envelope = {
            "schema_version": 1,
            "workflow_id": "test-workflow",
            "gate": "planner",
            "checkpoint_id": "legacy-1",
            "snapshot_sha256": first["snapshot_sha256"],
            "recorded_at": "2026-09-03T00:00:00Z",
            "report_sha256": self.canonical_digest(legacy_report),
            "report": legacy_report,
        }
        legacy_path.write_text(json.dumps(legacy_envelope), encoding="utf-8")
        legacy_path.chmod(0o600)

        _, legacy = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "legacy-1",
            "--repo",
            str(self.repo),
        )
        assert legacy is not None
        self.assertTrue(legacy["valid"])
        self.assertEqual(legacy["planner_review_state"], "legacy-unqualified")
        self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "legacy-1",
            "--repo",
            str(self.repo),
            "--require-review",
            "planner",
            expected=1,
        )

        self.write("src/value.txt", "strict recovery\n")
        _, second = self.create(
            "legacy-2",
            "--path",
            "src/value.txt",
            previous="legacy-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "legacy-1",
            "--to-checkpoint",
            "legacy-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        delta_sha256 = str(delta["delta_sha256"])
        incremental = self.strict_report(
            second,
            "planner",
            previous_checkpoint=first,
            delta_sha256=delta_sha256,
            mode="incremental",
            impact_analysis={
                "summary": "Attempted legacy carry is intentionally invalid.",
                "additionally_affected_surface_ids": [],
            },
        )
        rejected, _ = self.record_review(second, "planner", incremental, expected=2)
        self.assertIn("qualifying strict prior", rejected.stderr)

        full = self.strict_report(
            second,
            "planner",
            previous_checkpoint=first,
            delta_sha256=delta_sha256,
            mode="full",
        )
        self.record_review(second, "planner", full)
        _, recovered = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "legacy-2",
            "--repo",
            str(self.repo),
            "--require-review",
            "planner",
        )
        assert recovered is not None
        self.assertEqual(recovered["planner_review_state"], "strict-approved")

    def test_corrupt_prior_review_requires_and_allows_full_strict_recovery(self) -> None:
        self.write("src/value.txt", "first strict review\n")
        _, first = self.create("corrupt-review-1", "--path", "src/value.txt")
        assert first is not None
        _, first_record = self.record_review(
            first,
            "planner",
            self.strict_report(first, "planner"),
        )
        assert first_record is not None
        durable_path = Path(first_record["record_path"])
        envelope = json.loads(durable_path.read_text(encoding="utf-8"))
        envelope["report"]["summary"] = "Tampered prior evidence."
        durable_path.write_text(json.dumps(envelope), encoding="utf-8")
        durable_path.chmod(0o600)

        _, invalid = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "corrupt-review-1",
            "--repo",
            str(self.repo),
            expected=1,
        )
        assert invalid is not None
        self.assertEqual(invalid["planner_review_state"], "invalid")

        self.write("src/value.txt", "full recovery result\n")
        _, second = self.create(
            "corrupt-review-2",
            "--path",
            "src/value.txt",
            previous="corrupt-review-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "corrupt-review-1",
            "--to-checkpoint",
            "corrupt-review-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        full = self.strict_report(
            second,
            "planner",
            previous_checkpoint=first,
            delta_sha256=str(delta["delta_sha256"]),
            mode="full",
        )
        self.record_review(second, "planner", full)

    def test_corrupt_prior_only_blob_rejects_incremental_and_allows_full_recovery(self) -> None:
        self.write("src/value.txt", "prior-only content\n")
        _, first = self.create("corrupt-blob-1", "--path", "src/value.txt")
        assert first is not None
        _, first_record = self.record_review(
            first,
            "planner",
            self.strict_report(first, "planner"),
        )
        assert first_record is not None

        self.write("src/value.txt", "successor content\n")
        _, second = self.create(
            "corrupt-blob-2",
            "--path",
            "src/value.txt",
            previous="corrupt-blob-1",
        )
        assert second is not None
        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "corrupt-blob-1",
            "--to-checkpoint",
            "corrupt-blob-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None

        prior_digest = str(first["files"]["src/value.txt"]["sha256"])
        prior_blob = (
            self.repo
            / ".tmp/hdt-review-checkpoints/test-workflow/blobs"
            / prior_digest[:2]
            / prior_digest
        )
        prior_blob.write_text("corrupt prior-only blob\n", encoding="utf-8")
        prior_blob.chmod(0o600)

        incremental = self.strict_report(
            second,
            "planner",
            previous_checkpoint=first,
            delta_sha256=str(delta["delta_sha256"]),
            impact_analysis={
                "summary": "The changed task surface was directly reviewed.",
                "additionally_affected_surface_ids": [],
            },
            mode="incremental",
        )
        rejected, _ = self.record_review(second, "planner", incremental, expected=2)
        self.assertIn("qualifying strict prior", rejected.stderr)

        full = self.strict_report(
            second,
            "planner",
            previous_checkpoint=first,
            delta_sha256=str(delta["delta_sha256"]),
            mode="full",
        )
        self.record_review(second, "planner", full)

    def test_verdict_finding_surface_and_safe_to_close_coherence(self) -> None:
        self.write("src/value.txt", "coherence\n")
        _, checkpoint = self.create("coherence", "--path", "src/value.txt")
        assert checkpoint is not None

        approved = self.strict_report(checkpoint, "expert")
        approved["safe_to_close"] = False
        result, _ = self.record_review(checkpoint, "expert", approved, expected=2)
        self.assertIn("safe_to_close true", result.stderr)

        rework = self.strict_report(checkpoint, "expert", verdict="rework_required")
        result, _ = self.record_review(checkpoint, "expert", rework, expected=2)
        self.assertIn("actionable finding", result.stderr)

        blocker = {
            "finding_id": "BLOCK-001",
            "kind": "blocker",
            "severity": "high",
            "summary": "Required authority is unavailable.",
            "impact": "The review cannot safely close.",
            "recommended_action": "Obtain the missing authority.",
            "evidence": ["The required user decision is absent."],
            "affected_surface_ids": ["task-scope"],
        }
        blocked_surfaces = {
            "task-scope": {
                "paths": ["src/value.txt"],
                "disposition": "reviewed",
                "status": "blocked",
                "depends_on": [],
                "invariants": ["Closure requires explicit authority."],
                "finding_ids": ["BLOCK-001"],
            }
        }
        blocked = self.strict_report(
            checkpoint,
            "expert",
            verdict="blocked",
            blocking_findings=[blocker],
            surfaces=blocked_surfaces,
        )
        self.record_review(checkpoint, "expert", blocked)
        _, verification = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "coherence",
            "--repo",
            str(self.repo),
        )
        assert verification is not None
        self.assertEqual(verification["expert_review_state"], "strict-blocked")

    def test_task_result_digest_is_shared_and_ignored_scratch_does_not_create_drift(self) -> None:
        self.write("src/value.txt", "canonical result\n")
        _, mechanical = self.create("mechanical-result", "--path", "src/value.txt")
        _, expert = self.create("expert-result", "--path", "src/value.txt")
        assert mechanical is not None and expert is not None
        self.assertEqual(mechanical["snapshot_sha256"], expert["snapshot_sha256"])
        self.record_review(expert, "expert", self.strict_report(expert, "expert"))

        self.write(".tmp/validator-scratch.txt", "ignored scratch\n")
        _, ignored = self.create("ignored-scratch", "--path", "src/value.txt")
        assert ignored is not None
        self.assertEqual(expert["snapshot_sha256"], ignored["snapshot_sha256"])

        self.write("src/value.txt", "successor result\n")
        _, successor = self.create("task-drift", "--path", "src/value.txt")
        assert successor is not None
        self.assertNotEqual(expert["snapshot_sha256"], successor["snapshot_sha256"])

    def test_verify_plan_required_review_gate_reports_state(self) -> None:
        self.write("plan.md", "<!-- hdt-section: root -->\n# Reviewed plan\n")
        _, checkpoint = self.create_plan("required-plan")
        assert checkpoint is not None
        _, missing = self.run_helper(
            "verify-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "required-plan",
            "--repo",
            str(self.repo),
        )
        assert missing is not None
        self.assertEqual(missing["review_state"], "missing")
        self.run_helper(
            "verify-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "required-plan",
            "--repo",
            str(self.repo),
            "--require-review",
            expected=1,
        )
        report = {
            "verdict": "approved",
            "checkpoint_id": "required-plan",
            "snapshot_sha256": checkpoint["snapshot_sha256"],
            "previous_checkpoint": None,
            "coverage_ledger": {
                "mode": "full",
                "sections": {
                    section_id: {
                        "disposition": "reviewed",
                        "status": "validated",
                        "depends_on": [],
                        "invariants": ["The section was reviewed completely."],
                    }
                    for section_id in checkpoint["sections"]
                },
                "deleted_section_ids_reviewed": [],
                "limitations": [],
            },
        }
        self.record_plan_review(checkpoint, report)
        _, approved = self.run_helper(
            "verify-plan",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "required-plan",
            "--repo",
            str(self.repo),
            "--require-review",
        )
        assert approved is not None
        self.assertEqual(approved["review_state"], "strict-approved")

    def test_review_report_is_durable_immutable_and_checkpoint_bound(self) -> None:
        self.write("src/value.txt", "reviewed\n")
        _, checkpoint = self.create("expert-1", "--path", "src/value.txt")
        assert checkpoint is not None
        report_path = self.repo / ".tmp/expert-report.json"
        report_path.write_text(
            json.dumps(self.strict_report(checkpoint, "expert")),
            encoding="utf-8",
        )
        _, record = self.run_helper(
            "record-review",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "expert-1",
            "--repo",
            str(self.repo),
            "--gate",
            "expert",
            "--report",
            str(report_path),
        )
        assert record is not None
        durable_path = Path(record["record_path"])
        self.assertTrue(durable_path.is_file())
        self.assertEqual(stat.S_IMODE(durable_path.stat().st_mode), 0o600)

        duplicate, _ = self.run_helper(
            "record-review",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "expert-1",
            "--repo",
            str(self.repo),
            "--gate",
            "expert",
            "--report",
            str(report_path),
            expected=2,
        )
        self.assertIn("immutable", duplicate.stderr)

        report_payload = self.strict_report(checkpoint, "planner")
        report_payload["snapshot_sha256"] = "0" * 64
        report_path.write_text(json.dumps(report_payload), encoding="utf-8")
        mismatched, _ = self.run_helper(
            "record-review",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "expert-1",
            "--repo",
            str(self.repo),
            "--gate",
            "planner",
            "--report",
            str(report_path),
            expected=2,
        )
        self.assertIn("must equal the checkpoint snapshot", mismatched.stderr)

        durable_payload = json.loads(durable_path.read_text(encoding="utf-8"))
        durable_payload["report"]["coverage_ledger"]["limitations"] = ["tampered"]
        durable_path.write_text(json.dumps(durable_payload), encoding="utf-8")
        durable_path.chmod(0o600)
        _, verification = self.run_helper(
            "verify",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "expert-1",
            "--repo",
            str(self.repo),
            expected=1,
        )
        assert verification is not None
        self.assertFalse(verification["valid"])
        self.assertIn("Review report fingerprint mismatch", verification["errors"][-1])

    def test_review_scope_uses_prior_graph_and_requires_dependency_for_reopening(self) -> None:
        self.write("src/value.txt", "scope one\n")
        _, first = self.create(
            "scope-1",
            "--path",
            "src/value.txt",
            "--path",
            "src/helper.txt",
            "--path",
            "src/consumer.txt",
        )
        assert first is not None
        surfaces = {
            "core": {
                "paths": ["src/value.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Core behavior remains valid."],
                "finding_ids": [],
            },
            "consumer": {
                "paths": ["src/consumer.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": ["core"],
                "invariants": ["Consumer follows core."],
                "finding_ids": [],
            },
            "helper": {
                "paths": ["src/helper.txt"],
                "disposition": "reviewed",
                "status": "validated",
                "depends_on": [],
                "invariants": ["Helper remains independent."],
                "finding_ids": [],
            },
        }
        _, first_record = self.record_review(
            first,
            "planner",
            self.strict_report(first, "planner", surfaces=surfaces),
        )
        assert first_record is not None

        self.write("src/value.txt", "scope two\n")
        _, second = self.create(
            "scope-2",
            "--path",
            "src/value.txt",
            previous="scope-1",
        )
        assert second is not None
        _, scope = self.run_helper(
            "review-scope",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "scope-2",
            "--repo",
            str(self.repo),
            "--gate",
            "planner",
        )
        assert scope is not None
        self.assertEqual(scope["required_review_surface_ids"], ["consumer", "core"])
        self.assertEqual(scope["carriable_surface_ids"], ["helper"])
        self.assertEqual(set(scope["pending_paths"]), {"src/value.txt", "src/consumer.txt"})
        self.assertEqual(
            scope["carry_forward_surfaces"]["helper"]["disposition"],
            "carried_forward",
        )

        _, selected = self.run_helper(
            "review-scope",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "scope-2",
            "--repo",
            str(self.repo),
            "--gate",
            "planner",
            "--surface",
            "helper",
        )
        assert selected is not None
        self.assertEqual(selected["selected_surfaces"]["helper"]["state"], "closed")

        _, delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "scope-1",
            "--to-checkpoint",
            "scope-2",
            "--repo",
            str(self.repo),
        )
        assert delta is not None
        successor_surfaces = json.loads(json.dumps(surfaces))
        for surface_id in ("core", "consumer", "helper"):
            successor_surfaces[surface_id]["disposition"] = "reviewed"
        report = self.strict_report(
            second,
            "planner",
            surfaces=successor_surfaces,
            previous_checkpoint=first,
            previous_review_sha256=str(first_record["report_sha256"]),
            delta_sha256=str(delta["delta_sha256"]),
            impact_analysis={
                "summary": "The helper was reopened without dependency evidence.",
                "additionally_affected_surface_ids": ["helper"],
            },
            mode="incremental",
        )
        rejected, _ = self.record_review(second, "planner", report, expected=2)
        self.assertIn("newly recorded dependency", rejected.stderr)

        report["coverage_ledger"]["surfaces"]["helper"]["depends_on"] = ["core"]
        report["impact_analysis"]["summary"] = (
            "src/value.txt revealed that helper now depends on the changed core surface."
        )
        _, second_record = self.record_review(second, "planner", report)
        assert second_record is not None

        self.write("src/helper-extra.txt", "new helper path\n")
        _, third = self.create(
            "scope-3",
            "--path",
            "src/helper-extra.txt",
            previous="scope-2",
        )
        assert third is not None
        _, third_scope = self.run_helper(
            "review-scope",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "scope-3",
            "--repo",
            str(self.repo),
            "--gate",
            "planner",
        )
        assert third_scope is not None
        self.assertEqual(third_scope["unassigned_changed_paths"], ["src/helper-extra.txt"])

        _, third_delta = self.run_helper(
            "diff",
            "--workflow-id",
            "test-workflow",
            "--from-checkpoint",
            "scope-2",
            "--to-checkpoint",
            "scope-3",
            "--repo",
            str(self.repo),
        )
        assert third_delta is not None
        third_surfaces = json.loads(json.dumps(report["coverage_ledger"]["surfaces"]))
        third_surfaces["helper"]["paths"].append("src/helper-extra.txt")
        for surface_id in ("core", "consumer"):
            third_surfaces[surface_id]["disposition"] = "carried_forward"
            third_surfaces[surface_id]["carry_forward_rationale"] = (
                "The new helper path does not affect this prior surface."
            )
        third_report = self.strict_report(
            third,
            "planner",
            surfaces=third_surfaces,
            previous_checkpoint=second,
            previous_review_sha256=str(second_record["report_sha256"]),
            delta_sha256=str(third_delta["delta_sha256"]),
            impact_analysis={
                "summary": "The new path belongs to the directly reviewed helper surface.",
                "additionally_affected_surface_ids": [],
            },
            mode="incremental",
        )
        self.record_review(third, "planner", third_report)

    def test_mechanical_evidence_reuse_is_exact_and_fails_closed(self) -> None:
        self.write("src/value.txt", "mechanical evidence\n")
        _, checkpoint = self.create("mechanical-1", "--path", "src/value.txt")
        assert checkpoint is not None

        def descriptor(check_id: str) -> dict[str, object]:
            argv = ["python3", "-m", "unittest"]
            if check_id == "exact":
                argv.append("--token=TOPSECRET")
            return {
                "check_id": check_id,
                "invocation": {"kind": "argv", "argv": argv},
                "cwd": ".",
                "configuration": {"files": ["pyproject.toml"], "profile": "test"},
                "toolchain": {"python": "3.test"},
                "environment": {"services": "none"},
            }

        check_ids = ["exact", "command", "cwd", "config", "toolchain", "environment", "volatile", "failed"]
        checks: list[dict[str, object]] = []
        for check_id in check_ids:
            check = descriptor(check_id)
            check.update(
                {
                    "volatile": check_id == "volatile",
                    "verdict": "failed" if check_id == "failed" else "passed",
                    "exit_status": 1 if check_id == "failed" else 0,
                    "evidence": [
                        "Authorization: Bearer TOPSECRET"
                        if check_id == "exact"
                        else f"Evidence for {check_id}."
                    ],
                }
            )
            checks.append(check)
        evidence_report = {
            "schema_version": 1,
            "checkpoint_id": "mechanical-1",
            "task_result_snapshot_sha256": checkpoint["snapshot_sha256"],
            "producer": "implementation",
            "checks": checks,
        }
        evidence_path = self.repo / ".tmp/mechanical-evidence.json"
        evidence_path.write_text(json.dumps(evidence_report), encoding="utf-8")
        _, record = self.run_helper(
            "record-mechanical-evidence",
            "--workflow-id",
            "test-workflow",
            "--evidence-id",
            "implementation-batch",
            "--checkpoint-id",
            "mechanical-1",
            "--repo",
            str(self.repo),
            "--report",
            str(evidence_path),
        )
        assert record is not None
        durable_path = Path(record["record_path"])
        durable_text = durable_path.read_text(encoding="utf-8")
        self.assertNotIn("TOPSECRET", durable_text)
        durable_report = json.loads(durable_text)["report"]
        self.assertEqual(
            set(durable_report["checks"][0]),
            {
                "check_id",
                "identity_sha256",
                "volatile",
                "verdict",
                "exit_status",
                "evidence_sha256",
            },
        )

        requirements = [descriptor(check_id) for check_id in check_ids]
        requirements[1]["invocation"] = {"kind": "argv", "argv": ["python3", "-m", "pytest"]}
        requirements[2]["cwd"] = "src"
        requirements[3]["configuration"] = {"files": ["pyproject.toml"], "profile": "ci"}
        requirements[4]["toolchain"] = {"python": "3.other"}
        requirements[5]["environment"] = {"services": "database"}
        requirements_path = self.repo / ".tmp/mechanical-requirements.json"
        requirements_path.write_text(json.dumps({"checks": requirements}), encoding="utf-8")
        _, resolved = self.run_helper(
            "resolve-mechanical-evidence",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "mechanical-1",
            "--repo",
            str(self.repo),
            "--evidence-id",
            "implementation-batch",
            "--requirements",
            str(requirements_path),
        )
        assert resolved is not None
        dispositions = {
            item["check_id"]: item for item in resolved["resolutions"]
        }
        self.assertEqual(dispositions["exact"]["disposition"], "reused")
        for check_id in ("command", "cwd", "config", "toolchain", "environment"):
            self.assertEqual(dispositions[check_id]["disposition"], "execute")
            self.assertIn("invocation_context_mismatch", dispositions[check_id]["miss_reasons"])
        self.assertIn("volatile_evidence", dispositions["volatile"]["miss_reasons"])
        self.assertIn("not_green", dispositions["failed"]["miss_reasons"])

        self.write("src/value.txt", "worktree drift\n")
        _, drifted = self.run_helper(
            "resolve-mechanical-evidence",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "mechanical-1",
            "--repo",
            str(self.repo),
            "--evidence-id",
            "implementation-batch",
            "--requirements",
            str(requirements_path),
        )
        assert drifted is not None
        self.assertFalse(drifted["current_worktree_matches"])
        self.assertTrue(
            all(item["disposition"] == "execute" for item in drifted["resolutions"])
        )

        self.write("src/value.txt", "mechanical evidence\n")
        envelope = json.loads(durable_path.read_text(encoding="utf-8"))
        envelope["report"]["checks"][0]["evidence_sha256"] = "0" * 64
        durable_path.write_text(json.dumps(envelope), encoding="utf-8")
        durable_path.chmod(0o600)
        _, tampered = self.run_helper(
            "resolve-mechanical-evidence",
            "--workflow-id",
            "test-workflow",
            "--checkpoint-id",
            "mechanical-1",
            "--repo",
            str(self.repo),
            "--evidence-id",
            "implementation-batch",
            "--requirements",
            str(requirements_path),
        )
        assert tampered is not None
        self.assertIn("implementation-batch", tampered["invalid_candidates"])
        self.assertTrue(
            all("invalid_evidence_record" in item["miss_reasons"] for item in tampered["resolutions"])
        )


if __name__ == "__main__":
    unittest.main()
