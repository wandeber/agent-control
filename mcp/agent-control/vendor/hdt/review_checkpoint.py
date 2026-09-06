#!/usr/bin/env python3
"""Create and compare durable HDT implementation and plan-review checkpoints."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterable


SCHEMA_VERSION = 1
PLAN_RECORD_TYPE = "plan_checkpoint"
PLAN_PREAMBLE_SECTION_ID = "preamble"
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PLAN_SECTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_OBJECT_RE = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
PLAN_SECTION_MARKER_RE = re.compile(
    r"^[ \t]*<!--[ \t]*hdt-section:[ \t]*([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]*-->[ \t]*$",
    re.IGNORECASE,
)
ATX_HEADING_RE = re.compile(r"^[ ]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$")
SEMANTIC_HEADING_ID_RE = re.compile(
    r"^([A-Z][A-Z0-9]{1,15}-[0-9]+(?:\.[0-9]+)*)\b"
)
FENCE_RE = re.compile(r"^[ ]{0,3}(`{3,}|~{3,})(.*)$")
PRESENT_KINDS = {"file", "symlink", "gitlink"}
ENTRY_KINDS = PRESENT_KINDS | {"deleted", "absent"}
ENTRY_MODES = {"100644", "100755", "120000", "160000", None}
CHUNK_SIZE = 1024 * 1024
MAX_PATCH_BLOB_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_REVIEW_REPORT_BYTES = 8 * 1024 * 1024
MAX_PLAN_BYTES = 8 * 1024 * 1024
SENSITIVE_NAMES = {
    ".env",
    ".netrc",
    ".npmrc",
    "credentials",
    "credentials.json",
    "secrets.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
}
SENSITIVE_UNTRACKED_SUFFIXES = (".env", ".key", ".pem", ".p12", ".pfx")
SENSITIVE_DESCRIPTOR_KEYS = {
    "access_key",
    "api_key",
    "credential",
    "credentials",
    "password",
    "passwd",
    "private_key",
    "secret",
    "token",
}


class CheckpointError(RuntimeError):
    """A deterministic checkpoint operation could not be completed safely."""


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise CheckpointError(f"git {' '.join(args)} failed: {message}")
    return result


def split_nul(payload: bytes) -> list[str]:
    return [item.decode("utf-8", errors="surrogateescape") for item in payload.split(b"\0") if item]


def canonical_json(payload: Any) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def lexical_absolute_path(path_value: str | Path, base: Path | None = None) -> Path:
    path = Path(path_value).expanduser()
    if not path.is_absolute():
        path = (base or Path.cwd()) / path
    return Path(os.path.abspath(os.fspath(path)))


def path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def reject_symlink_components(path: Path, root: Path) -> None:
    """Reject symlinks from a trusted real root through the final component."""
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise CheckpointError(f"Path is outside the trusted root {root}: {path}") from exc

    current = root
    for part in relative.parts:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise CheckpointError(f"Refusing path through symlink component: {current}")


def ensure_private_directory_components(
    path: Path,
    root: Path,
    *,
    chmod_existing_final: bool = True,
) -> None:
    """Create a repository-local directory without traversing symlink components."""
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise CheckpointError(f"Directory is outside the trusted root {root}: {path}") from exc

    current = root
    for part in relative.parts:
        current /= part
        created = False
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
                created = True
            except FileExistsError:
                metadata = current.lstat()
            else:
                metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise CheckpointError(f"Checkpoint directory is not a regular directory: {current}")
        if created or (chmod_existing_final and current == path):
            current.chmod(0o700)


def ensure_private_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise CheckpointError(f"Checkpoint directory is not a regular directory: {path}")
    path.chmod(0o700)


def open_regular_file(path: Path, label: str) -> tuple[BinaryIO, os.stat_result]:
    """Open a stable regular final component without following a final symlink."""
    try:
        before = path.lstat()
    except FileNotFoundError as exc:
        raise CheckpointError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise CheckpointError(f"{label} must be a regular non-symlink file: {path}")

    flags = os.O_RDONLY
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is not None:
        flags |= nofollow
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise CheckpointError(f"Cannot safely open {label}: {path}: {exc}") from exc
    try:
        opened = os.fstat(descriptor)
        after = path.lstat()
        if (
            not stat.S_ISREG(opened.st_mode)
            or regular_file_identity(before) != regular_file_identity(opened)
            or regular_file_identity(after) != regular_file_identity(opened)
        ):
            raise CheckpointError(f"{label} changed identity while it was opened: {path}")
        return os.fdopen(descriptor, "rb"), opened
    except Exception:
        os.close(descriptor)
        raise


def regular_file_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return (metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode))


def verify_open_file_stability(
    path: Path,
    label: str,
    before: os.stat_result,
    after: os.stat_result,
) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError as exc:
        raise CheckpointError(f"{label} disappeared while it was open: {path}") from exc
    stable = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    if (
        stable != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        or regular_file_identity(current) != regular_file_identity(after)
    ):
        raise CheckpointError(f"{label} changed while it was open: {path}")


def prepare_input_path(
    path_value: str | Path,
    repo: Path,
    label: str,
    *,
    base: Path | None = None,
) -> Path:
    path = lexical_absolute_path(path_value, base)
    if path_is_within(path, repo):
        reject_symlink_components(path, repo)
    # External parent aliases are intentionally allowed; open_regular_file
    # applies the final-component non-follow and identity checks.
    handle, _metadata = open_regular_file(path, label)
    handle.close()
    return path


def read_regular_bytes(
    path: Path,
    label: str,
    max_bytes: int,
    *,
    trusted_root: Path | None = None,
) -> bytes:
    if trusted_root is not None:
        reject_symlink_components(path, trusted_root)
    handle, before = open_regular_file(path, label)
    try:
        payload = handle.read(max_bytes + 1)
        after = os.fstat(handle.fileno())
    finally:
        handle.close()
    verify_open_file_stability(path, label, before, after)
    if trusted_root is not None:
        reject_symlink_components(path, trusted_root)
    if len(payload) > max_bytes:
        raise CheckpointError(f"{label} exceeds {max_bytes} bytes: {path}")
    return payload


def write_immutable_json(path: Path, payload: dict[str, Any], *, trusted_root: Path) -> None:
    ensure_private_directory_components(path.parent, trusted_root)
    reject_symlink_components(path, trusted_root)
    if path.exists() or path.is_symlink():
        raise CheckpointError(f"Immutable record already exists: {path}")
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            mode="w",
            encoding="utf-8",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            os.chmod(temporary.name, 0o600)
            json.dump(payload, temporary, ensure_ascii=False, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        try:
            os.link(temporary_path, path)
            path.chmod(0o600)
            reject_symlink_components(path, trusted_root)
        except FileExistsError as exc:
            raise CheckpointError(f"Immutable record already exists: {path}") from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def file_sha256(path: Path, *, trusted_root: Path | None = None) -> tuple[str, int]:
    if trusted_root is not None:
        reject_symlink_components(path, trusted_root)
    handle, before = open_regular_file(path, "File")
    digest = hashlib.sha256()
    size = 0
    try:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
        after = os.fstat(handle.fileno())
    finally:
        handle.close()
    verify_open_file_stability(path, "File", before, after)
    if trusted_root is not None:
        reject_symlink_components(path, trusted_root)
    return digest.hexdigest(), size


def validate_digest(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        raise CheckpointError(f"{field_name} must be a lowercase SHA-256 digest.")
    return value


def sensitive_path(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    return (
        name in SENSITIVE_NAMES
        or name.startswith(".env.")
        or name.endswith(SENSITIVE_UNTRACKED_SUFFIXES)
    )


def default_store(repo: Path) -> Path:
    temporary_root = repo / ".tmp"
    return temporary_root / "hdt-review-checkpoints"


def safe_id(value: str, field_name: str) -> str:
    if not SAFE_ID_RE.fullmatch(value):
        raise CheckpointError(
            f"{field_name} must match {SAFE_ID_RE.pattern!r}; received {value!r}."
        )
    return value


def resolve_repo(path_value: str) -> Path:
    candidate = lexical_absolute_path(path_value)
    result = run_git(candidate, "rev-parse", "--show-toplevel")
    root = lexical_absolute_path(result.stdout.decode("utf-8", errors="strict").strip())
    if root.resolve() != candidate.resolve():
        raise CheckpointError(f"--repo must be the repository root: {root}")
    return candidate


def ensure_store_policy(store: Path, repo: Path) -> None:
    try:
        common = Path(os.path.commonpath([str(store), str(repo)]))
    except ValueError:
        return
    if common != repo:
        return

    temporary_root = repo / ".tmp"
    try:
        store.relative_to(temporary_root)
    except ValueError as exc:
        raise CheckpointError(
            "A repository-local checkpoint store must be under the ignored .tmp directory."
        ) from exc

    if temporary_root.is_symlink():
        raise CheckpointError("Repository-local '.tmp' checkpoint storage must not use a symlink.")

    relative_store = store.relative_to(repo).as_posix()
    probes = (
        ".tmp/",
        f"{relative_store}/.hdt-store-probe",
        f"{relative_store}/probe/checkpoints/checkpoint.json",
        f"{relative_store}/probe/plan/checkpoints/checkpoint.json",
        f"{relative_store}/probe/plan/reviews/checkpoint.json",
        f"{relative_store}/probe/blobs/aa/digest",
        f"{relative_store}/probe/reviews/expert/checkpoint.json",
    )
    for probe in probes:
        ignored = run_git(
            repo,
            "check-ignore",
            "--no-index",
            "-q",
            "--",
            probe,
            check=False,
        )
        if ignored.returncode != 0:
            raise CheckpointError(
                "Repository-local checkpoint storage is not fully ignored by a repository "
                ".gitignore. Ask the user for permission to add '.tmp/' to an applicable "
                ".gitignore, then retry."
            )
        result = run_git(
            repo,
            "check-ignore",
            "--no-index",
            "-v",
            "--",
            probe,
            check=False,
        )
        if result.returncode != 0:
            raise CheckpointError(
                "Repository-local checkpoint storage is not fully ignored by a repository "
                ".gitignore. Ask the user for permission to add '.tmp/' to an applicable "
                ".gitignore, then retry."
            )
        line = result.stdout.decode("utf-8", errors="surrogateescape").rstrip("\n")
        try:
            metadata, matched_path = line.rsplit("\t", 1)
            source, _line_number, _pattern = metadata.split(":", 2)
        except ValueError as exc:
            raise CheckpointError(f"Cannot parse git check-ignore output for {probe}") from exc
        source_path = Path(source)
        if not source_path.is_absolute():
            source_path = repo / source_path
        source_path = source_path.resolve()
        try:
            source_relative = source_path.relative_to(repo.resolve())
        except ValueError as exc:
            raise CheckpointError(
                "Checkpoint ignore policy comes from outside the repository. Ask the user "
                "for permission to add '.tmp/' to the repository .gitignore."
            ) from exc
        if (
            source_path.name != ".gitignore"
            or not source_relative.parts
            or source_relative.parts[0] == ".git"
            or matched_path != probe
        ):
            raise CheckpointError(
                "Checkpoint storage must be ignored by a repository .gitignore, not a "
                "global exclude or .git/info/exclude. Ask the user for permission to add "
                "'.tmp/' to an applicable repository .gitignore."
            )


def resolve_store(path_value: str | None, repo: Path) -> Path:
    explicit = path_value is not None
    store = lexical_absolute_path(path_value, repo) if explicit else default_store(repo)
    repository_local = path_is_within(store, repo)

    if not explicit or repository_local:
        reject_symlink_components(store, repo)
        ensure_store_policy(store, repo)
        ensure_private_directory_components(repo / ".tmp", repo)
        ensure_private_directory_components(store, repo)
        reject_symlink_components(store, repo)
        real_temporary_root = (repo / ".tmp").resolve()
        real_store = store.resolve()
        if not path_is_within(real_store, real_temporary_root):
            raise CheckpointError(
                "Repository-local checkpoint storage escaped the real .tmp directory."
            )
        return real_store

    # An explicitly authorized external path keeps its lexical classification.
    # Parent aliases are allowed, but the final store itself is never a symlink.
    ensure_private_directory(store)
    metadata = store.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise CheckpointError(f"External checkpoint store is not a regular directory: {store}")
    return store.resolve()


def normalize_repo_path(repo: Path, raw_value: str) -> str:
    raw_path = Path(raw_value).expanduser()
    if raw_path.is_absolute():
        try:
            raw_path = raw_path.relative_to(repo)
        except ValueError as exc:
            raise CheckpointError(f"Path is outside the repository: {raw_value}") from exc

    pure = PurePosixPath(raw_path.as_posix())
    if not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise CheckpointError(f"Unsafe repository-relative path: {raw_value!r}")
    if pure.parts[0] == ".git":
        raise CheckpointError("The .git directory cannot be checkpointed.")
    return pure.as_posix()


def reject_intermediate_symlinks(repo: Path, path: str) -> None:
    current = repo
    for part in PurePosixPath(path).parts[:-1]:
        current /= part
        if current.is_symlink():
            raise CheckpointError(
                f"Refusing repository path through intermediate symlink: {path}"
            )


def tracked_paths(repo: Path, base_commit: str) -> set[str]:
    result = run_git(
        repo, "diff", "--name-only", "--ignore-submodules=none", "-z", base_commit, "--"
    )
    return set(split_nul(result.stdout))


def untracked_paths(repo: Path) -> set[str]:
    result = run_git(repo, "ls-files", "--others", "--exclude-standard", "-z")
    return set(split_nul(result.stdout))


def reject_sensitive_paths(paths: Iterable[str]) -> None:
    for path in paths:
        if sensitive_path(path):
            raise CheckpointError(
                f"Refusing to checkpoint sensitive-looking path: {path}"
            )


def expand_scope_path(
    repo: Path,
    base_commit: str,
    raw_path: str,
    *,
    allow_missing: bool = False,
) -> set[str]:
    path = normalize_repo_path(repo, raw_path)
    reject_intermediate_symlinks(repo, path)
    candidates: set[str] = set()

    for args in (
        ("ls-files", "-z", "--", path),
        ("ls-files", "--others", "--exclude-standard", "-z", "--", path),
        ("ls-tree", "-r", "--name-only", "-z", base_commit, "--", path),
    ):
        candidates.update(split_nul(run_git(repo, *args).stdout))

    absolute = repo / Path(path)
    if absolute.is_file() or absolute.is_symlink():
        tracked = run_git(repo, "ls-files", "--error-unmatch", "--", path, check=False)
        if tracked.returncode != 0:
            ignored = run_git(repo, "check-ignore", "-q", "--", path, check=False)
            if ignored.returncode == 0:
                raise CheckpointError(f"Refusing to checkpoint ignored untracked path: {path}")
        candidates.add(path)

    if not candidates:
        base_exists = run_git(repo, "cat-file", "-e", f"{base_commit}:{path}", check=False)
        if base_exists.returncode == 0:
            candidates.add(path)
        elif allow_missing:
            return set()
        else:
            raise CheckpointError(f"Scope path does not exist in the base or worktree: {path}")

    normalized_candidates = {normalize_repo_path(repo, item) for item in candidates}
    for candidate in normalized_candidates:
        reject_intermediate_symlinks(repo, candidate)
    return normalized_candidates


def read_paths_file(path_value: str | None, repo: Path) -> list[str]:
    if not path_value:
        return []
    path = prepare_input_path(path_value, repo, "--paths-from file")
    payload = read_regular_bytes(path, "--paths-from file", MAX_REVIEW_REPORT_BYTES)
    values: list[str] = []
    for line in payload.decode("utf-8").splitlines():
        value = line.strip()
        if value and not value.startswith("#"):
            values.append(value)
    return values


def workflow_dir(store: Path, workflow_id: str) -> Path:
    return store / safe_id(workflow_id, "workflow ID")


def manifest_path(store: Path, workflow_id: str, checkpoint_id: str) -> Path:
    return (
        workflow_dir(store, workflow_id)
        / "checkpoints"
        / f"{safe_id(checkpoint_id, 'checkpoint ID')}.json"
    )


def review_path(store: Path, workflow_id: str, gate: str, checkpoint_id: str) -> Path:
    return (
        workflow_dir(store, workflow_id)
        / "reviews"
        / gate
        / f"{safe_id(checkpoint_id, 'checkpoint ID')}.json"
    )


def plan_manifest_path(store: Path, workflow_id: str, checkpoint_id: str) -> Path:
    return (
        workflow_dir(store, workflow_id)
        / "plan"
        / "checkpoints"
        / f"{safe_id(checkpoint_id, 'checkpoint ID')}.json"
    )


def plan_review_path(store: Path, workflow_id: str, checkpoint_id: str) -> Path:
    return (
        workflow_dir(store, workflow_id)
        / "plan"
        / "reviews"
        / f"{safe_id(checkpoint_id, 'checkpoint ID')}.json"
    )


def mechanical_evidence_path(store: Path, workflow_id: str, evidence_id: str) -> Path:
    return (
        workflow_dir(store, workflow_id)
        / "mechanical-evidence"
        / f"{safe_id(evidence_id, 'mechanical evidence ID')}.json"
    )


def store_path_exists(path: Path, store: Path) -> bool:
    reject_symlink_components(path, store)
    return path.exists()


def load_manifest(store: Path, workflow_id: str, checkpoint_id: str) -> dict[str, Any]:
    path = manifest_path(store, workflow_id, checkpoint_id)
    payload = json.loads(
        read_regular_bytes(
            path,
            "Checkpoint manifest",
            MAX_MANIFEST_BYTES,
            trusted_root=store,
        ).decode("utf-8")
    )
    validate_manifest_structure(payload, workflow_id, checkpoint_id)
    return payload


def load_plan_manifest(store: Path, workflow_id: str, checkpoint_id: str) -> dict[str, Any]:
    path = plan_manifest_path(store, workflow_id, checkpoint_id)
    payload = json.loads(
        read_regular_bytes(
            path,
            "Plan checkpoint manifest",
            MAX_MANIFEST_BYTES,
            trusted_root=store,
        ).decode("utf-8")
    )
    validate_plan_manifest_structure(payload, workflow_id, checkpoint_id)
    return payload


def blob_path(store: Path, workflow_id: str, digest: str) -> Path:
    validated = validate_digest(digest, "blob digest")
    return workflow_dir(store, workflow_id) / "blobs" / validated[:2] / validated


def store_blob(store: Path, workflow_id: str, payload: bytes) -> str:
    digest = sha256_bytes(payload)
    path = blob_path(store, workflow_id, digest)
    ensure_private_directory_components(path.parent, store)
    reject_symlink_components(path, store)
    if path.is_symlink():
        raise CheckpointError(f"Checkpoint blob must not be a symlink: {path}")
    if path.exists():
        if file_sha256(path, trusted_root=store)[0] != digest:
            raise CheckpointError(f"Corrupted existing blob: {path}")
        return digest
    try:
        with path.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        path.chmod(0o600)
    except FileExistsError:
        if file_sha256(path, trusted_root=store)[0] != digest:
            raise CheckpointError(f"Concurrent blob write produced invalid content: {path}")
    return digest


def store_file_blob(store: Path, workflow_id: str, source: Path) -> tuple[str, int]:
    incoming = workflow_dir(store, workflow_id) / "incoming"
    ensure_private_directory_components(incoming, store)
    source_handle, before = open_regular_file(source, "Checkpoint source file")
    digest = hashlib.sha256()
    size = 0
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=incoming, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            os.chmod(temporary.name, 0o600)
            try:
                while chunk := source_handle.read(CHUNK_SIZE):
                    digest.update(chunk)
                    size += len(chunk)
                    temporary.write(chunk)
                after = os.fstat(source_handle.fileno())
            finally:
                source_handle.close()
            temporary.flush()
            os.fsync(temporary.fileno())

        verify_open_file_stability(source, "Checkpoint source file", before, after)

        digest_value = digest.hexdigest()
        destination = blob_path(store, workflow_id, digest_value)
        ensure_private_directory_components(destination.parent, store)
        reject_symlink_components(destination, store)
        if destination.is_symlink():
            raise CheckpointError(f"Checkpoint blob must not be a symlink: {destination}")
        try:
            os.link(temporary_path, destination)
            destination.chmod(0o600)
        except FileExistsError:
            if file_sha256(destination, trusted_root=store)[0] != digest_value:
                raise CheckpointError(f"Corrupted existing blob: {destination}")
        return digest_value, size
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def verified_blob_bytes(
    store: Path,
    workflow_id: str,
    digest: str,
    *,
    max_bytes: int,
    label: str,
) -> bytes:
    path = blob_path(store, workflow_id, digest)
    payload = read_regular_bytes(path, label, max_bytes, trusted_root=store)
    if sha256_bytes(payload) != validate_digest(digest, "blob digest"):
        raise CheckpointError(f"Checkpoint blob failed SHA-256 verification: {digest}")
    return payload


def blob_bytes(store: Path, workflow_id: str, digest: str) -> bytes:
    return verified_blob_bytes(
        store,
        workflow_id,
        digest,
        max_bytes=MAX_PATCH_BLOB_BYTES,
        label="Blob",
    )


def index_modes(repo: Path) -> dict[str, str]:
    result = run_git(repo, "ls-files", "--stage", "-z")
    modes: dict[str, str] = {}
    for record in split_nul(result.stdout):
        metadata, path = record.split("\t", 1)
        modes.setdefault(path, metadata.split(" ", 1)[0])
    return modes


def base_has_path(repo: Path, base_commit: str, path: str) -> bool:
    return run_git(repo, "cat-file", "-e", f"{base_commit}:{path}", check=False).returncode == 0


def capture_entry(
    repo: Path,
    base_commit: str,
    path: str,
    store: Path,
    workflow_id: str,
    *,
    indexed_modes: dict[str, str],
    persist_blobs: bool = True,
) -> dict[str, Any]:
    normalized = normalize_repo_path(repo, path)
    reject_intermediate_symlinks(repo, normalized)
    absolute = repo / Path(normalized)
    mode = indexed_modes.get(normalized)

    if mode == "160000":
        result = run_git(absolute, "rev-parse", "HEAD", check=False)
        if result.returncode != 0:
            raise CheckpointError(f"Cannot resolve submodule HEAD for {normalized}")
        payload = result.stdout.strip()
        return {
            "kind": "gitlink",
            "mode": "160000",
            "sha256": store_blob(store, workflow_id, payload) if persist_blobs else sha256_bytes(payload),
            "size": len(payload),
        }

    if absolute.is_symlink():
        payload = os.readlink(absolute).encode("utf-8", errors="surrogateescape")
        return {
            "kind": "symlink",
            "mode": "120000",
            "sha256": store_blob(store, workflow_id, payload) if persist_blobs else sha256_bytes(payload),
            "size": len(payload),
        }

    if absolute.is_file():
        digest, size = (
            store_file_blob(store, workflow_id, absolute) if persist_blobs else file_sha256(absolute)
        )
        file_mode = absolute.stat().st_mode
        normalized_mode = "100755" if file_mode & stat.S_IXUSR else "100644"
        return {
            "kind": "file",
            "mode": normalized_mode,
            "sha256": digest,
            "size": size,
        }

    if absolute.exists():
        raise CheckpointError(f"Unsupported checkpoint path type: {normalized}")

    return {
        "kind": "deleted" if base_has_path(repo, base_commit, normalized) else "absent",
        "mode": None,
        "sha256": None,
        "size": 0,
    }


def reject_dirty_submodules(repo: Path) -> None:
    # A gitlink identifies a commit, never the bytes of a dirty submodule. Check
    # the whole worktree because its guard also covers paths outside task scope.
    pending = [repo]
    while pending:
        parent = pending.pop()
        entries = run_git(parent, "ls-files", "--stage", "-z")
        paths = {
            record.split("\t", 1)[1]
            for record in split_nul(entries.stdout)
            if record.startswith("160000 ")
        }
        for path in sorted(paths):
            submodule = parent / normalize_repo_path(parent, path)
            reject_symlink_components(submodule, repo)
            if not (submodule / ".git").exists():
                continue
            visibility = run_git(submodule, "ls-files", "-v", "-z")
            if any(record[0].islower() or record.startswith("S ") for record in split_nul(visibility.stdout)):
                raise CheckpointError(
                    f"Cannot verify clean submodule {submodule.relative_to(repo)}: "
                    "assume-unchanged or skip-worktree index flags can hide modified content."
                )
            # Parent status can hide child dirt through child-local Git config.
            # Inspect each initialized module with explicit flags of its own.
            status = run_git(
                submodule,
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=none",
            )
            if status.stdout:
                raise CheckpointError(
                    f"Cannot checkpoint or compare dirty submodule: {submodule.relative_to(repo)}. "
                    "Submodule gitlinks require clean tracked, staged, untracked, and nested content."
                )
            pending.append(submodule)


def worktree_guard_sha256(repo: Path, base_commit: str) -> str:
    reject_dirty_submodules(repo)
    digest = hashlib.sha256()
    command = [
        "git",
        "-C",
        str(repo),
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--ignore-submodules=none",
        base_commit,
        "--",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    while chunk := process.stdout.read(CHUNK_SIZE):
        digest.update(chunk)
    stderr = process.stderr.read() if process.stderr is not None else b""
    returncode = process.wait()
    if returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip()
        raise CheckpointError(f"git diff failed while freezing the worktree: {message}")

    digest.update(b"\0UNTRACKED\0")
    for path in sorted(untracked_paths(repo)):
        normalized = normalize_repo_path(repo, path)
        reject_intermediate_symlinks(repo, normalized)
        absolute = repo / Path(normalized)
        digest.update(normalized.encode("utf-8", errors="surrogateescape"))
        digest.update(b"\0")
        if absolute.is_symlink():
            digest.update(b"symlink\0")
            digest.update(os.readlink(absolute).encode("utf-8", errors="surrogateescape"))
        elif absolute.is_file():
            file_digest, size = file_sha256(absolute)
            digest.update(b"file\0")
            mode = "100755" if absolute.stat().st_mode & stat.S_IXUSR else "100644"
            digest.update(mode.encode("ascii"))
            digest.update(b"\0")
            digest.update(str(size).encode("ascii"))
            digest.update(b"\0")
            digest.update(file_digest.encode("ascii"))
        else:
            raise CheckpointError(f"Unsupported untracked path type: {normalized}")
        digest.update(b"\0")
    return digest.hexdigest()


def validate_manifest_structure(
    payload: Any,
    expected_workflow_id: str,
    expected_checkpoint_id: str,
) -> None:
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        raise CheckpointError("Unsupported or malformed checkpoint schema.")
    if payload.get("workflow_id") != safe_id(expected_workflow_id, "workflow ID"):
        raise CheckpointError("Checkpoint workflow ID does not match its storage path.")
    if payload.get("checkpoint_id") != safe_id(expected_checkpoint_id, "checkpoint ID"):
        raise CheckpointError("Checkpoint ID does not match its storage path.")
    if not isinstance(payload.get("repo_root"), str) or not Path(payload["repo_root"]).is_absolute():
        raise CheckpointError("Checkpoint repository root must be an absolute path.")
    if not isinstance(payload.get("base_commit"), str) or not GIT_OBJECT_RE.fullmatch(payload["base_commit"]):
        raise CheckpointError("Checkpoint base commit is malformed.")
    if not isinstance(payload.get("head_commit"), str) or not GIT_OBJECT_RE.fullmatch(payload["head_commit"]):
        raise CheckpointError("Checkpoint HEAD commit is malformed.")
    validate_digest(payload.get("worktree_guard_sha256"), "worktree guard")

    scope = payload.get("scope")
    if not isinstance(scope, dict) or scope.get("mode") not in {"explicit", "all_changes"}:
        raise CheckpointError("Checkpoint scope is malformed.")
    previous = scope.get("previous_checkpoint")
    if previous is not None:
        safe_id(previous, "previous checkpoint ID")

    plan = payload.get("plan")
    if not isinstance(plan, dict):
        raise CheckpointError("Checkpoint plan record is malformed.")
    if not isinstance(plan.get("path"), str) or not Path(plan["path"]).is_absolute():
        raise CheckpointError("Checkpoint plan path must be absolute.")
    validate_digest(plan.get("sha256"), "plan digest")
    if not isinstance(plan.get("size"), int) or plan["size"] < 0:
        raise CheckpointError("Checkpoint plan size is malformed.")

    files = payload.get("files")
    if not isinstance(files, dict) or not files:
        raise CheckpointError("Checkpoint files must be a non-empty object.")
    if scope.get("path_count") != len(files):
        raise CheckpointError("Checkpoint scope count does not match its file records.")
    for path, entry in files.items():
        if not isinstance(path, str):
            raise CheckpointError("Checkpoint file path must be a string.")
        pure = PurePosixPath(path)
        if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
            raise CheckpointError(f"Unsafe checkpoint file path: {path!r}")
        if pure.parts[0] == ".git" or pure.as_posix() != path:
            raise CheckpointError(f"Non-canonical checkpoint file path: {path!r}")
        if sensitive_path(path):
            raise CheckpointError(f"Sensitive-looking path is forbidden in a checkpoint: {path}")
        if not isinstance(entry, dict) or entry.get("kind") not in ENTRY_KINDS:
            raise CheckpointError(f"Malformed checkpoint entry for {path}")
        if entry.get("mode") not in ENTRY_MODES:
            raise CheckpointError(f"Malformed checkpoint mode for {path}")
        if not isinstance(entry.get("size"), int) or entry["size"] < 0:
            raise CheckpointError(f"Malformed checkpoint size for {path}")
        if entry["kind"] in PRESENT_KINDS:
            validate_digest(entry.get("sha256"), f"file digest for {path}")
            expected_modes = {
                "file": {"100644", "100755"},
                "symlink": {"120000"},
                "gitlink": {"160000"},
            }
            if entry.get("mode") not in expected_modes[entry["kind"]]:
                raise CheckpointError(f"Checkpoint kind and mode disagree for {path}")
        elif entry.get("sha256") is not None or entry.get("mode") is not None or entry["size"] != 0:
            raise CheckpointError(f"Absent checkpoint entry has content metadata: {path}")

    validate_digest(payload.get("snapshot_sha256"), "snapshot fingerprint")
    if payload["snapshot_sha256"] != checkpoint_fingerprint(payload):
        raise CheckpointError("Checkpoint snapshot fingerprint is invalid.")


def checkpoint_fingerprint(payload: dict[str, Any]) -> str:
    identity = {
        "schema_version": payload["schema_version"],
        "repo_root": payload["repo_root"],
        "base_commit": payload["base_commit"],
        "head_commit": payload["head_commit"],
        "worktree_guard_sha256": payload["worktree_guard_sha256"],
        "files": payload["files"],
        "plan": {
            "path": payload["plan"]["path"],
            "sha256": payload["plan"]["sha256"],
            "size": payload["plan"]["size"],
        },
    }
    return sha256_bytes(canonical_json(identity))


def normalize_heading_identity(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return " ".join(normalized.split())


def parse_plan_sections(payload: bytes) -> dict[str, dict[str, Any]]:
    if not payload:
        raise CheckpointError("Plan checkpoint requires a non-empty Markdown document.")
    if len(payload) > MAX_PLAN_BYTES:
        raise CheckpointError(f"Plan exceeds the {MAX_PLAN_BYTES}-byte checkpoint limit.")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CheckpointError("Plan checkpoints require UTF-8 Markdown.") from exc
    if "\x00" in text:
        raise CheckpointError("Plan checkpoints do not support NUL bytes.")

    lines = text.splitlines(keepends=True)
    if not lines:
        lines = [text]
    line_offsets: list[int] = []
    offset = 0
    for line in lines:
        line_offsets.append(offset)
        offset += len(line.encode("utf-8"))
    if offset != len(payload):
        raise CheckpointError("Plan byte offsets could not be reconstructed safely.")

    headings: list[dict[str, Any]] = []
    pending_marker: tuple[str, int] | None = None
    fence: tuple[str, int] | None = None
    for line_index, line in enumerate(lines):
        logical = line.rstrip("\r\n")
        parse_logical = logical.lstrip("\ufeff") if line_index == 0 else logical

        if fence is not None:
            fence_char, minimum_length = fence
            candidate = parse_logical.lstrip(" ")
            if len(parse_logical) - len(candidate) <= 3 and re.fullmatch(
                rf"{re.escape(fence_char)}{{{minimum_length},}}[ \t]*",
                candidate,
            ):
                fence = None
            continue

        fence_match = FENCE_RE.match(parse_logical)
        if fence_match:
            if pending_marker is not None:
                raise CheckpointError(
                    "An hdt-section marker must be immediately followed by an ATX heading."
                )
            token = fence_match.group(1)
            fence = (token[0], len(token))
            continue

        marker_match = PLAN_SECTION_MARKER_RE.fullmatch(parse_logical)
        if marker_match:
            if pending_marker is not None:
                raise CheckpointError("Consecutive hdt-section markers are not allowed.")
            pending_marker = (marker_match.group(1).lower(), line_index)
            continue

        heading_match = ATX_HEADING_RE.match(parse_logical)
        if heading_match:
            title = re.sub(r"[ \t]+#+[ \t]*$", "", heading_match.group(2)).strip()
            if not title:
                raise CheckpointError(f"Plan heading on line {line_index + 1} is empty.")
            marker_id = pending_marker[0] if pending_marker else None
            start_line_index = pending_marker[1] if pending_marker else line_index
            headings.append(
                {
                    "level": len(heading_match.group(1)),
                    "title": title,
                    "heading_line_index": line_index,
                    "start_line_index": start_line_index,
                    "start_byte": line_offsets[start_line_index],
                    "marker_id": marker_id,
                }
            )
            pending_marker = None
            continue

        if pending_marker is not None:
            raise CheckpointError(
                "An hdt-section marker must be immediately followed by an ATX heading."
            )

    if pending_marker is not None:
        raise CheckpointError(
            "An hdt-section marker must be immediately followed by an ATX heading."
        )
    if not headings:
        raise CheckpointError(
            "Plan checkpoints require at least one ATX Markdown heading."
        )

    stack: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for heading in headings:
        while stack and stack[-1]["level"] >= heading["level"]:
            stack.pop()
        parent = stack[-1] if stack else None
        heading_path = [*(parent["heading_path"] if parent else []), heading["title"]]
        semantic_match = SEMANTIC_HEADING_ID_RE.match(heading["title"])
        if heading["marker_id"]:
            section_id = heading["marker_id"]
            identity_kind = "marker"
        elif semantic_match:
            section_id = semantic_match.group(1).lower()
            identity_kind = "heading_token"
        else:
            normalized_path = [normalize_heading_identity(item) for item in heading_path]
            section_id = f"auto-{sha256_bytes(canonical_json(normalized_path))[:20]}"
            identity_kind = "heading_path"
        if section_id == PLAN_PREAMBLE_SECTION_ID:
            raise CheckpointError(
                f"Plan section ID {PLAN_PREAMBLE_SECTION_ID!r} is reserved for document preamble."
            )
        if not PLAN_SECTION_ID_RE.fullmatch(section_id):
            raise CheckpointError(f"Invalid plan section ID: {section_id!r}")
        if section_id in seen_ids:
            raise CheckpointError(
                f"Duplicate plan section ID {section_id!r}; use unique hdt-section markers."
            )
        seen_ids.add(section_id)
        heading["section_id"] = section_id
        heading["identity_kind"] = identity_kind
        heading["heading_path"] = heading_path
        heading["parent_id"] = parent["section_id"] if parent else None
        stack.append(heading)

    sections: dict[str, dict[str, Any]] = {}
    first_start = headings[0]["start_byte"]
    preamble = payload[:first_start]
    if preamble and not preamble.lstrip(b"\xef\xbb\xbf").strip():
        headings[0]["start_line_index"] = 0
        headings[0]["start_byte"] = 0
        first_start = 0
        preamble = b""
    order = 0
    if preamble:
        sections[PLAN_PREAMBLE_SECTION_ID] = {
            "section_id": PLAN_PREAMBLE_SECTION_ID,
            "identity_kind": "preamble",
            "title": None,
            "heading_path": [],
            "level": 0,
            "parent_id": None,
            "order": order,
            "start_line": 1,
            "heading_line": None,
            "direct_end_line": headings[0]["start_line_index"],
            "end_line": headings[0]["start_line_index"],
            "start_byte": 0,
            "direct_end_byte": first_start,
            "end_byte": first_start,
            "direct_sha256": sha256_bytes(preamble),
            "subtree_sha256": sha256_bytes(preamble),
        }
        order += 1

    for index, heading in enumerate(headings):
        end_index = len(lines)
        end_byte = len(payload)
        for following in headings[index + 1 :]:
            if following["level"] <= heading["level"]:
                end_index = following["start_line_index"]
                end_byte = following["start_byte"]
                break
        if index + 1 < len(headings):
            direct_end_index = headings[index + 1]["start_line_index"]
            direct_end_byte = headings[index + 1]["start_byte"]
        else:
            direct_end_index = end_index
            direct_end_byte = end_byte
        if direct_end_byte > end_byte:
            direct_end_index = end_index
            direct_end_byte = end_byte

        direct_payload = payload[heading["start_byte"] : direct_end_byte]
        subtree_payload = payload[heading["start_byte"] : end_byte]
        section_id = heading["section_id"]
        sections[section_id] = {
            "section_id": section_id,
            "identity_kind": heading["identity_kind"],
            "title": heading["title"],
            "heading_path": heading["heading_path"],
            "level": heading["level"],
            "parent_id": heading["parent_id"],
            "order": order,
            "start_line": heading["start_line_index"] + 1,
            "heading_line": heading["heading_line_index"] + 1,
            "direct_end_line": direct_end_index,
            "end_line": end_index,
            "start_byte": heading["start_byte"],
            "direct_end_byte": direct_end_byte,
            "end_byte": end_byte,
            "direct_sha256": sha256_bytes(direct_payload),
            "subtree_sha256": sha256_bytes(subtree_payload),
        }
        order += 1
    return sections


def plan_checkpoint_fingerprint(payload: dict[str, Any]) -> str:
    identity = {
        "schema_version": payload["schema_version"],
        "record_type": payload["record_type"],
        "repo_root": payload["repo_root"],
        "previous_checkpoint": payload["previous_checkpoint"],
        "plan": payload["plan"],
        "sections": payload["sections"],
    }
    return sha256_bytes(canonical_json(identity))


def validate_plan_manifest_structure(
    payload: Any,
    expected_workflow_id: str,
    expected_checkpoint_id: str,
) -> None:
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        raise CheckpointError("Unsupported or malformed plan checkpoint schema.")
    if payload.get("record_type") != PLAN_RECORD_TYPE:
        raise CheckpointError("Checkpoint is not a plan checkpoint.")
    if payload.get("workflow_id") != safe_id(expected_workflow_id, "workflow ID"):
        raise CheckpointError("Plan checkpoint workflow ID does not match its storage path.")
    if payload.get("checkpoint_id") != safe_id(expected_checkpoint_id, "checkpoint ID"):
        raise CheckpointError("Plan checkpoint ID does not match its storage path.")
    if not isinstance(payload.get("repo_root"), str) or not Path(payload["repo_root"]).is_absolute():
        raise CheckpointError("Plan checkpoint repository root must be an absolute path.")
    previous = payload.get("previous_checkpoint")
    if previous is not None:
        safe_id(previous, "previous checkpoint ID")
    plan = payload.get("plan")
    if not isinstance(plan, dict):
        raise CheckpointError("Plan checkpoint plan record is malformed.")
    if not isinstance(plan.get("path"), str) or not Path(plan["path"]).is_absolute():
        raise CheckpointError("Plan checkpoint path must be absolute.")
    validate_digest(plan.get("sha256"), "plan digest")
    if not isinstance(plan.get("size"), int) or not 0 < plan["size"] <= MAX_PLAN_BYTES:
        raise CheckpointError("Plan checkpoint size is malformed.")
    sections = payload.get("sections")
    if not isinstance(sections, dict) or not sections:
        raise CheckpointError("Plan checkpoint sections must be a non-empty object.")
    orders: set[int] = set()
    for section_id, section in sections.items():
        if (
            section_id != PLAN_PREAMBLE_SECTION_ID
            and not PLAN_SECTION_ID_RE.fullmatch(section_id)
        ):
            raise CheckpointError(f"Malformed plan section ID: {section_id!r}")
        if not isinstance(section, dict) or section.get("section_id") != section_id:
            raise CheckpointError(f"Malformed plan section record: {section_id!r}")
        order = section.get("order")
        if not isinstance(order, int) or order < 0 or order in orders:
            raise CheckpointError(f"Malformed plan section order: {section_id!r}")
        orders.add(order)
        parent_id = section.get("parent_id")
        if parent_id is not None and parent_id not in sections:
            raise CheckpointError(f"Unknown parent for plan section {section_id!r}")
        range_fields = (
            "start_line",
            "direct_end_line",
            "end_line",
            "start_byte",
            "direct_end_byte",
            "end_byte",
        )
        for field in range_fields:
            value = section.get(field)
            if not isinstance(value, int) or value < 0:
                raise CheckpointError(f"Malformed {field} for plan section {section_id!r}")
        if not (
            section["start_byte"] <= section["direct_end_byte"] <= section["end_byte"] <= plan["size"]
        ):
            raise CheckpointError(f"Invalid byte range for plan section {section_id!r}")
        validate_digest(section.get("direct_sha256"), f"direct digest for {section_id}")
        validate_digest(section.get("subtree_sha256"), f"subtree digest for {section_id}")
    if orders != set(range(len(sections))):
        raise CheckpointError("Plan section order must be contiguous.")
    validate_digest(payload.get("snapshot_sha256"), "plan snapshot fingerprint")
    if payload["snapshot_sha256"] != plan_checkpoint_fingerprint(payload):
        raise CheckpointError("Plan checkpoint snapshot fingerprint is invalid.")


def create_plan_manifest(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    checkpoint_id = safe_id(args.checkpoint_id, "checkpoint ID")
    output_path = plan_manifest_path(store, workflow_id, checkpoint_id)
    if store_path_exists(output_path, store):
        raise CheckpointError(f"Plan checkpoint is immutable and already exists: {output_path}")

    previous: dict[str, Any] | None = None
    if args.previous:
        previous = load_plan_manifest(store, workflow_id, args.previous)
        if previous["repo_root"] != str(repo):
            raise CheckpointError("Previous plan checkpoint belongs to a different repository.")
        if plan_manifest_content_errors(store, workflow_id, previous):
            raise CheckpointError("Previous plan checkpoint failed integrity verification.")

    plan_path = prepare_input_path(args.plan, repo, "Plan", base=repo)
    if plan_path.suffix.lower() not in {".md", ".markdown", ".mdx"}:
        raise CheckpointError("Plan checkpoints require a Markdown plan file.")
    if previous and str(plan_path) != previous["plan"]["path"]:
        raise CheckpointError(
            "The plan path changed inside an existing plan-review lineage. Start a new lineage."
        )

    plan_digest, plan_size = store_file_blob(store, workflow_id, plan_path)
    if plan_size > MAX_PLAN_BYTES:
        raise CheckpointError(f"Plan exceeds the {MAX_PLAN_BYTES}-byte checkpoint limit.")
    plan_payload = verified_blob_bytes(
        store,
        workflow_id,
        plan_digest,
        max_bytes=MAX_PLAN_BYTES,
        label="Plan",
    )
    sections = parse_plan_sections(plan_payload)
    current_digest, current_size = file_sha256(plan_path)
    if (current_digest, current_size) != (plan_digest, plan_size):
        raise CheckpointError("Plan changed while the checkpoint was being created.")

    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "record_type": PLAN_RECORD_TYPE,
        "workflow_id": workflow_id,
        "checkpoint_id": checkpoint_id,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "repo_root": str(repo),
        "previous_checkpoint": args.previous,
        "plan": {
            "path": str(plan_path),
            "sha256": plan_digest,
            "size": plan_size,
        },
        "sections": sections,
    }
    manifest["snapshot_sha256"] = plan_checkpoint_fingerprint(manifest)
    write_immutable_json(output_path, manifest, trusted_root=store)
    return manifest


def create_manifest(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    checkpoint_id = safe_id(args.checkpoint_id, "checkpoint ID")
    output_path = manifest_path(store, workflow_id, checkpoint_id)
    if store_path_exists(output_path, store):
        raise CheckpointError(f"Checkpoint is immutable and already exists: {output_path}")

    if args.all_changes and (args.path or args.paths_from):
        raise CheckpointError("Do not combine --all-changes with --path or --paths-from.")
    if args.isolated_worktree and not args.all_changes:
        raise CheckpointError("--isolated-worktree is meaningful only with --all-changes.")

    previous: dict[str, Any] | None = None
    if args.previous:
        previous = load_manifest(store, workflow_id, args.previous)
        if previous["repo_root"] != str(repo):
            raise CheckpointError("Previous checkpoint belongs to a different repository.")
        if manifest_content_errors(store, workflow_id, previous):
            raise CheckpointError("Previous checkpoint failed integrity verification.")

    base_reference = args.base or (previous["base_commit"] if previous else "HEAD")
    base_commit = run_git(
        repo,
        "rev-parse",
        "--verify",
        f"{base_reference}^{{commit}}",
    ).stdout.decode().strip()
    if previous and base_commit != previous["base_commit"]:
        raise CheckpointError(
            "A checkpoint lineage must keep the prior base commit. Omit --base to inherit it."
        )
    paths: set[str] = set()
    scope_mode = "all_changes" if args.all_changes else "explicit"

    if args.all_changes:
        if not args.isolated_worktree:
            raise CheckpointError(
                "--all-changes requires --isolated-worktree after verifying that every "
                "non-ignored change belongs to the task."
            )
        paths.update(tracked_paths(repo, base_commit))
        paths.update(untracked_paths(repo))
    else:
        scope_values = list(args.path or []) + read_paths_file(args.paths_from, repo)
        if not scope_values and not previous:
            raise CheckpointError("Pass --all-changes, --path, or --paths-from.")
        previous_paths = set(previous["files"]) if previous else set()
        for value in scope_values:
            normalized = normalize_repo_path(repo, value)
            previous_matches = {
                path
                for path in previous_paths
                if path == normalized or path.startswith(f"{normalized.rstrip('/')}/")
            }
            paths.update(
                expand_scope_path(
                    repo,
                    base_commit,
                    value,
                    allow_missing=bool(previous_matches),
                )
            )
            paths.update(previous_matches)

    if previous:
        paths.update(previous["files"].keys())

    if not paths:
        raise CheckpointError("Checkpoint scope is empty.")
    reject_sensitive_paths(paths)

    plan_path = prepare_input_path(args.plan, repo, "Approved plan", base=repo)
    if previous and str(plan_path) != previous["plan"]["path"]:
        raise CheckpointError(
            "The approved plan path changed inside an existing review lineage. Return "
            "to the upstream approval gate and start a new checkpoint lineage."
        )
    plan_digest, plan_size = file_sha256(plan_path)
    if previous and plan_digest != previous["plan"]["sha256"]:
        raise CheckpointError(
            "The approved plan changed inside an existing review lineage. Return to the "
            "upstream approval gate and start a new checkpoint lineage after approval."
        )
    stored_plan_digest, stored_plan_size = store_file_blob(store, workflow_id, plan_path)
    if (stored_plan_digest, stored_plan_size) != (plan_digest, plan_size):
        raise CheckpointError("Approved plan changed while the checkpoint was being created.")

    head_before = run_git(repo, "rev-parse", "HEAD").stdout.decode().strip()
    guard_before = worktree_guard_sha256(repo, base_commit)
    indexed_modes = index_modes(repo)
    files = {
        path: capture_entry(
            repo, base_commit, path, store, workflow_id, indexed_modes=indexed_modes
        )
        for path in sorted(paths)
    }
    head_after = run_git(repo, "rev-parse", "HEAD").stdout.decode().strip()
    guard_after = worktree_guard_sha256(repo, base_commit)
    if head_before != head_after or guard_before != guard_after:
        raise CheckpointError(
            "Repository state changed while the checkpoint was being created. Freeze writers and retry."
        )
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "workflow_id": workflow_id,
        "checkpoint_id": checkpoint_id,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "repo_root": str(repo),
        "base_commit": base_commit,
        "head_commit": head_after,
        "worktree_guard_sha256": guard_after,
        "scope": {
            "mode": scope_mode,
            "path_count": len(files),
            "previous_checkpoint": args.previous,
        },
        "plan": {
            "path": str(plan_path),
            "sha256": stored_plan_digest,
            "size": stored_plan_size,
        },
        "files": files,
    }
    manifest["snapshot_sha256"] = checkpoint_fingerprint(manifest)

    write_immutable_json(output_path, manifest, trusted_root=store)
    return manifest


def entry_present(entry: dict[str, Any] | None) -> bool:
    return bool(entry and entry.get("kind") in PRESENT_KINDS)


def entry_identity(entry: dict[str, Any] | None) -> tuple[Any, ...]:
    if not entry:
        return ("absent", None, None)
    return (entry.get("kind"), entry.get("mode"), entry.get("sha256"))


def text_patch(
    store: Path,
    workflow_id: str,
    path: str,
    old_entry: dict[str, Any] | None,
    new_entry: dict[str, Any] | None,
) -> str | None:
    def decode(entry: dict[str, Any] | None) -> list[str] | None:
        if not entry_present(entry):
            return []
        if entry.get("kind") == "gitlink":
            return None
        if entry.get("size", 0) > MAX_PATCH_BLOB_BYTES:
            return None
        try:
            payload = blob_bytes(store, workflow_id, entry["sha256"])
            if b"\0" in payload:
                return None
            return payload.decode("utf-8").splitlines(keepends=True)
        except UnicodeDecodeError:
            return None

    old_lines = decode(old_entry)
    new_lines = decode(new_entry)
    if old_lines is None or new_lines is None:
        return None
    return "".join(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )


def canonical_delta_sha256(delta: dict[str, Any]) -> str:
    """Hash semantic delta identity without optional presentation fields."""
    identity = {
        field: delta[field]
        for field in (
            "schema_version",
            "workflow_id",
            "from_checkpoint",
            "from_snapshot_sha256",
            "to_checkpoint",
            "to_snapshot_sha256",
            "base_commit_changed",
            "head_commit_changed",
            "worktree_guard_changed",
            "plan_changed",
            "change_count",
            "renames",
        )
    }
    identity["changes"] = [
        {
            field: change[field]
            for field in ("path", "status", "old", "new")
        }
        for change in delta["changes"]
    ]
    return sha256_bytes(canonical_json(identity))


def diff_manifests(
    store: Path,
    workflow_id: str,
    old: dict[str, Any],
    new: dict[str, Any],
    include_patches: bool,
) -> dict[str, Any]:
    changes: list[dict[str, Any]] = []
    all_paths = sorted(set(old["files"]) | set(new["files"]))
    for path in all_paths:
        old_entry = old["files"].get(path)
        new_entry = new["files"].get(path)
        if entry_identity(old_entry) == entry_identity(new_entry):
            continue

        old_present = entry_present(old_entry)
        new_present = entry_present(new_entry)
        if not old_present and new_present:
            status_name = "added"
        elif old_present and not new_present:
            status_name = "deleted"
        elif old_entry and new_entry and old_entry.get("sha256") == new_entry.get("sha256"):
            status_name = "mode_changed"
        else:
            status_name = "modified"

        change: dict[str, Any] = {
            "path": path,
            "status": status_name,
            "old": old_entry,
            "new": new_entry,
        }
        if include_patches:
            patch = text_patch(store, workflow_id, path, old_entry, new_entry)
            change["patch"] = patch
            change["binary_or_gitlink"] = patch is None
        changes.append(change)

    deleted_by_digest: dict[str, list[dict[str, Any]]] = {}
    added_by_digest: dict[str, list[dict[str, Any]]] = {}
    for change in changes:
        if change["status"] == "deleted" and change["old"].get("sha256"):
            deleted_by_digest.setdefault(change["old"]["sha256"], []).append(change)
        if change["status"] == "added" and change["new"].get("sha256"):
            added_by_digest.setdefault(change["new"]["sha256"], []).append(change)

    renames: list[dict[str, str]] = []
    for digest in sorted(set(deleted_by_digest) & set(added_by_digest)):
        deleted_items = deleted_by_digest[digest]
        added_items = added_by_digest[digest]
        while deleted_items and added_items:
            old_change = deleted_items.pop(0)
            new_change = added_items.pop(0)
            old_change["status"] = "renamed_from"
            new_change["status"] = "renamed_to"
            renames.append({"from": old_change["path"], "to": new_change["path"]})

    delta = {
        "schema_version": SCHEMA_VERSION,
        "workflow_id": workflow_id,
        "from_checkpoint": old["checkpoint_id"],
        "from_snapshot_sha256": old["snapshot_sha256"],
        "to_checkpoint": new["checkpoint_id"],
        "to_snapshot_sha256": new["snapshot_sha256"],
        "base_commit_changed": old["base_commit"] != new["base_commit"],
        "head_commit_changed": old["head_commit"] != new["head_commit"],
        "worktree_guard_changed": old["worktree_guard_sha256"] != new["worktree_guard_sha256"],
        "plan_changed": (
            old["plan"]["path"] != new["plan"]["path"]
            or old["plan"]["sha256"] != new["plan"]["sha256"]
        ),
        "change_count": len(changes),
        "changes": changes,
        "renames": renames,
    }
    delta["delta_sha256"] = canonical_delta_sha256(delta)
    return delta


def plan_payload_for_manifest(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> bytes:
    return verified_blob_bytes(
        store,
        workflow_id,
        manifest["plan"]["sha256"],
        max_bytes=MAX_PLAN_BYTES,
        label="Plan",
    )


def plan_section_payload(
    payload: bytes,
    section: dict[str, Any] | None,
    *,
    subtree: bool = False,
) -> bytes:
    if section is None:
        return b""
    end_field = "end_byte" if subtree else "direct_end_byte"
    return payload[section["start_byte"] : section[end_field]]


def plan_section_patch(
    section_id: str,
    old_payload: bytes,
    new_payload: bytes,
    old_section: dict[str, Any] | None,
    new_section: dict[str, Any] | None,
) -> str:
    old_lines = plan_section_payload(old_payload, old_section).decode("utf-8").splitlines(
        keepends=True
    )
    new_lines = plan_section_payload(new_payload, new_section).decode("utf-8").splitlines(
        keepends=True
    )
    return "".join(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=f"a/plan#{section_id}",
            tofile=f"b/plan#{section_id}",
        )
    )


def dependency_affected_sections(
    coverage_ledger: dict[str, Any],
    changed_or_deleted_ids: set[str],
) -> set[str]:
    records = coverage_ledger.get("sections", {})
    affected = set(changed_or_deleted_ids)
    changed = True
    while changed:
        changed = False
        for section_id, record in records.items():
            if section_id in affected or not isinstance(record, dict):
                continue
            dependencies = record.get("depends_on", [])
            if isinstance(dependencies, list) and any(item in affected for item in dependencies):
                affected.add(section_id)
                changed = True
    return affected - changed_or_deleted_ids


def diff_plan_manifests(
    store: Path,
    workflow_id: str,
    old: dict[str, Any],
    new: dict[str, Any],
    include_patches: bool,
    prior_coverage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    old_sections = old["sections"]
    new_sections = new["sections"]
    old_payload = plan_payload_for_manifest(store, workflow_id, old) if include_patches else b""
    new_payload = plan_payload_for_manifest(store, workflow_id, new) if include_patches else b""
    changes: list[dict[str, Any]] = []
    unchanged_ids: list[str] = []

    all_ids = set(old_sections) | set(new_sections)
    stable_parent_ids = {
        section_id
        for section_id in set(old_sections) & set(new_sections)
        if old_sections[section_id].get("parent_id")
        == new_sections[section_id].get("parent_id")
    }
    old_relative_order: dict[str, int] = {}
    new_relative_order: dict[str, int] = {}
    parents = {
        old_sections[section_id].get("parent_id")
        for section_id in stable_parent_ids
    }
    for parent_id in parents:
        sibling_ids = {
            section_id
            for section_id in stable_parent_ids
            if old_sections[section_id].get("parent_id") == parent_id
        }
        for rank, section_id in enumerate(
            sorted(sibling_ids, key=lambda item: old_sections[item]["order"])
        ):
            old_relative_order[section_id] = rank
        for rank, section_id in enumerate(
            sorted(sibling_ids, key=lambda item: new_sections[item]["order"])
        ):
            new_relative_order[section_id] = rank

    def location_changed(
        section_id: str,
        old_section: dict[str, Any],
        new_section: dict[str, Any],
    ) -> bool:
        return (
            any(
                old_section.get(field) != new_section.get(field)
                for field in ("title", "heading_path", "parent_id")
            )
            or old_relative_order.get(section_id) != new_relative_order.get(section_id)
        )

    ordered_ids = sorted(
        all_ids,
        key=lambda item: (
            0 if item in new_sections else 1,
            (new_sections.get(item) or old_sections[item])["order"],
            item,
        ),
    )
    changed_current_ids: set[str] = set()
    deleted_ids: set[str] = set()
    for section_id in ordered_ids:
        old_section = old_sections.get(section_id)
        new_section = new_sections.get(section_id)
        if old_section is None:
            status_name = "added"
        elif new_section is None:
            status_name = "deleted"
        else:
            section_location_changed = location_changed(
                section_id,
                old_section,
                new_section,
            )
            direct_changed = old_section["direct_sha256"] != new_section["direct_sha256"]
            subtree_changed = old_section["subtree_sha256"] != new_section["subtree_sha256"]
            if direct_changed:
                status_name = "modified"
            elif subtree_changed:
                status_name = "descendant_changed"
            elif section_location_changed:
                status_name = "moved_or_renamed"
            else:
                unchanged_ids.append(section_id)
                continue

        change: dict[str, Any] = {
            "section_id": section_id,
            "status": status_name,
            "old": old_section,
            "new": new_section,
        }
        if old_section is not None and new_section is not None:
            change["moved_or_renamed"] = location_changed(
                section_id,
                old_section,
                new_section,
            )
        if include_patches and status_name in {"added", "deleted", "modified"}:
            change["patch"] = plan_section_patch(
                section_id,
                old_payload,
                new_payload,
                old_section,
                new_section,
            )
        changes.append(change)
        if new_section is None:
            deleted_ids.add(section_id)
        else:
            changed_current_ids.add(section_id)

    current_ids = set(new_sections)
    dependency_affected: set[str] = set()
    required_review = set(changed_current_ids)
    carriable: set[str] = set()
    carry_forward_sections: dict[str, dict[str, Any]] = {}
    if prior_coverage is not None:
        prior_records = prior_coverage.get("sections", {})
        dependency_affected = dependency_affected_sections(
            prior_coverage,
            changed_current_ids | deleted_ids,
        ) & current_ids
        required_review.update(dependency_affected)
        for section_id in current_ids:
            prior_record = prior_records.get(section_id)
            if not isinstance(prior_record, dict) or prior_record.get("status") != "validated":
                required_review.add(section_id)
        carriable = set(unchanged_ids) - required_review
        for section_id in carriable:
            carried = dict(prior_records[section_id])
            carried["disposition"] = "carried_forward"
            carried["carry_forward_rationale"] = (
                "Unchanged prior validated section outside the helper-computed affected closure."
            )
            carry_forward_sections[section_id] = carried
    else:
        required_review = set(current_ids)

    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "plan_delta",
        "workflow_id": workflow_id,
        "from_checkpoint": old["checkpoint_id"],
        "from_snapshot_sha256": old["snapshot_sha256"],
        "to_checkpoint": new["checkpoint_id"],
        "to_snapshot_sha256": new["snapshot_sha256"],
        "direct_successor": new.get("previous_checkpoint") == old["checkpoint_id"],
        "plan_path_changed": old["plan"]["path"] != new["plan"]["path"],
        "plan_changed": old["plan"]["sha256"] != new["plan"]["sha256"],
        "change_count": len(changes),
        "changes": changes,
        "changed_section_ids": sorted(changed_current_ids),
        "deleted_section_ids": sorted(deleted_ids),
        "unchanged_section_ids": sorted(unchanged_ids),
        "dependency_affected_section_ids": sorted(dependency_affected),
        "required_review_section_ids": sorted(required_review),
        "carriable_section_ids": sorted(carriable),
        "carry_forward_sections": carry_forward_sections,
        "prior_coverage_available": prior_coverage is not None,
    }


def manifest_content_errors(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    expected = checkpoint_fingerprint(manifest)
    if manifest.get("snapshot_sha256") != expected:
        errors.append("snapshot fingerprint mismatch")

    digests = {manifest["plan"]["sha256"]}
    digests.update(
        entry["sha256"]
        for entry in manifest["files"].values()
        if entry.get("sha256")
    )
    for digest in sorted(digests):
        try:
            path = blob_path(store, workflow_id, digest)
            if file_sha256(path, trusted_root=store)[0] != digest:
                raise CheckpointError(
                    f"Checkpoint blob failed SHA-256 verification: {digest}"
                )
        except CheckpointError as exc:
            errors.append(str(exc))
    return errors


def verify_manifest(store: Path, workflow_id: str, manifest: dict[str, Any]) -> dict[str, Any]:
    errors = manifest_content_errors(store, workflow_id, manifest)

    review_states: dict[str, str] = {}
    for gate in ("planner", "expert"):
        path = review_path(store, workflow_id, gate, manifest["checkpoint_id"])
        if not store_path_exists(path, store):
            review_states[gate] = "missing"
            continue
        try:
            review_states[gate] = verify_review_record(
                path,
                store,
                workflow_id,
                gate,
                manifest,
            )
        except (CheckpointError, OSError, ValueError, json.JSONDecodeError) as exc:
            review_states[gate] = "invalid"
            errors.append(str(exc))

    return {
        "workflow_id": workflow_id,
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
        "valid": not errors,
        "errors": errors,
        "review_states": review_states,
        "planner_review_state": review_states["planner"],
        "expert_review_state": review_states["expert"],
    }


def plan_manifest_content_errors(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    expected = plan_checkpoint_fingerprint(manifest)
    if manifest.get("snapshot_sha256") != expected:
        errors.append("plan snapshot fingerprint mismatch")
    try:
        payload = plan_payload_for_manifest(store, workflow_id, manifest)
        if len(payload) != manifest["plan"]["size"]:
            raise CheckpointError("Plan checkpoint blob size mismatch.")
        parsed_sections = parse_plan_sections(payload)
        if parsed_sections != manifest["sections"]:
            raise CheckpointError("Plan section manifest does not match the stored plan blob.")
    except (CheckpointError, OSError, UnicodeDecodeError) as exc:
        errors.append(str(exc))
    return errors


def verify_plan_manifest(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    errors = plan_manifest_content_errors(store, workflow_id, manifest)

    review_state = "missing"
    path = plan_review_path(store, workflow_id, manifest["checkpoint_id"])
    if store_path_exists(path, store):
        try:
            envelope = read_plan_review_envelope(path, store, workflow_id, manifest)
            validate_plan_review_report(store, workflow_id, manifest, envelope["report"])
            review_state = f"strict-{envelope['report']['verdict'].replace('_', '-')}"
        except (CheckpointError, OSError, ValueError, json.JSONDecodeError) as exc:
            review_state = "invalid"
            errors.append(str(exc))

    return {
        "workflow_id": workflow_id,
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
        "valid": not errors,
        "errors": errors,
        "review_state": review_state,
    }


def working_manifest_for_match(
    stored: dict[str, Any],
    repo: Path,
    store: Path,
    workflow_id: str,
    *,
    persist_blobs: bool = False,
) -> dict[str, Any]:
    base_commit = stored["base_commit"]
    indexed_modes = index_modes(repo)
    files = {
        path: capture_entry(
            repo, base_commit, path, store, workflow_id,
            indexed_modes=indexed_modes, persist_blobs=persist_blobs,
        )
        for path in stored["files"]
    }
    if stored["scope"]["mode"] == "all_changes":
        current_paths = tracked_paths(repo, base_commit) | untracked_paths(repo)
        extra_paths = current_paths - set(files)
        reject_sensitive_paths(extra_paths)
        for path in extra_paths:
            files[path] = capture_entry(
                repo, base_commit, path, store, workflow_id,
                indexed_modes=indexed_modes, persist_blobs=persist_blobs,
            )

    plan_path = Path(stored["plan"]["path"])
    try:
        plan_path = prepare_input_path(plan_path, repo, "Approved plan")
    except CheckpointError:
        plan = {"path": str(plan_path), "sha256": None, "size": 0}
    else:
        digest, size = (
            store_file_blob(store, workflow_id, plan_path) if persist_blobs else file_sha256(plan_path)
        )
        plan = {
            "path": str(plan_path),
            "sha256": digest,
            "size": size,
        }
    current = {
        "schema_version": SCHEMA_VERSION,
        "repo_root": str(repo),
        "base_commit": base_commit,
        "head_commit": run_git(repo, "rev-parse", "HEAD").stdout.decode().strip(),
        "worktree_guard_sha256": worktree_guard_sha256(repo, base_commit),
        "files": files,
        "plan": plan,
    }
    current["snapshot_sha256"] = checkpoint_fingerprint(current)
    return current


def working_plan_manifest_for_match(
    stored: dict[str, Any],
    repo: Path,
    store: Path,
    workflow_id: str,
    *,
    persist_blobs: bool = False,
) -> dict[str, Any] | None:
    plan_path = Path(stored["plan"]["path"])
    try:
        plan_path = prepare_input_path(plan_path, repo, "Plan")
    except CheckpointError:
        return None
    payload = read_regular_bytes(plan_path, "Plan", MAX_PLAN_BYTES)
    digest = store_blob(store, workflow_id, payload) if persist_blobs else sha256_bytes(payload)
    size = len(payload)
    current: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "record_type": PLAN_RECORD_TYPE,
        "workflow_id": workflow_id,
        "checkpoint_id": "working-plan",
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "repo_root": str(repo),
        "previous_checkpoint": stored["checkpoint_id"],
        "plan": {
            "path": str(plan_path),
            "sha256": digest,
            "size": size,
        },
        "sections": parse_plan_sections(payload),
    }
    current["snapshot_sha256"] = plan_checkpoint_fingerprint(current)
    return current


def read_verified_review(
    path: Path,
    store: Path,
    workflow_id: str,
    gate: str,
    manifest: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    envelope = json.loads(
        read_regular_bytes(
            path,
            "Review record",
            MAX_REVIEW_REPORT_BYTES,
            trusted_root=store,
        ).decode("utf-8")
    )
    if not isinstance(envelope, dict) or envelope.get("schema_version") != SCHEMA_VERSION:
        raise CheckpointError(f"Malformed review record: {path}")
    expected = {
        "workflow_id": workflow_id,
        "gate": gate,
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
    }
    for field, value in expected.items():
        if envelope.get(field) != value:
            raise CheckpointError(f"Review record {field} does not match its checkpoint: {path}")
    report = envelope.get("report")
    if not isinstance(report, dict):
        raise CheckpointError(f"Review record payload is malformed: {path}")
    validate_digest(envelope.get("report_sha256"), "review report digest")
    if envelope["report_sha256"] != sha256_bytes(canonical_json(report)):
        raise CheckpointError(f"Review report fingerprint mismatch: {path}")
    if report.get("checkpoint_id") != manifest["checkpoint_id"]:
        raise CheckpointError(f"Review report checkpoint binding is invalid: {path}")
    if report.get("snapshot_sha256") != manifest["snapshot_sha256"]:
        raise CheckpointError(f"Review report snapshot binding is invalid: {path}")
    if report.get("verdict") not in {"approved", "rework_required", "blocked"}:
        raise CheckpointError(f"Review report verdict is invalid: {path}")
    if "coverage_ledger" not in report:
        raise CheckpointError(f"Review report coverage_ledger is missing: {path}")
    if "report_schema_version" not in report:
        return envelope, "legacy-unqualified"
    validate_review_report(store, workflow_id, gate, manifest, report)
    return envelope, f"strict-{report['verdict'].replace('_', '-')}"


def verify_review_record(
    path: Path,
    store: Path,
    workflow_id: str,
    gate: str,
    manifest: dict[str, Any],
) -> str:
    return read_verified_review(path, store, workflow_id, gate, manifest)[1]


def read_review_report(path_value: str, repo: Path) -> dict[str, Any]:
    if path_value == "-":
        payload = sys.stdin.buffer.read(MAX_REVIEW_REPORT_BYTES + 1)
        source = "standard input"
    else:
        path = prepare_input_path(path_value, repo, "Review report")
        payload = read_regular_bytes(path, "Review report", MAX_REVIEW_REPORT_BYTES)
        source = str(path)
    if len(payload) > MAX_REVIEW_REPORT_BYTES:
        raise CheckpointError(
            f"Review report from {source} exceeds {MAX_REVIEW_REPORT_BYTES} bytes."
        )
    report = json.loads(payload.decode("utf-8"))
    if not isinstance(report, dict):
        raise CheckpointError("Review report must be a JSON object.")
    return report


def normalized_check_cwd(repo: Path, value: Any) -> str:
    if not isinstance(value, str):
        raise CheckpointError("Mechanical check cwd must be a repository-relative string.")
    if value in {"", "."}:
        return "."
    relative = normalize_repo_path(repo, value)
    path = repo / relative
    reject_symlink_components(path, repo)
    if not path.is_dir() or path.is_symlink():
        raise CheckpointError(f"Mechanical check cwd is not a regular repository directory: {value}")
    return relative


def validate_invocation_descriptor(value: Any, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CheckpointError(f"{field_name} must be an object.")
    kind = value.get("kind")
    if kind == "argv":
        require_exact_keys(value, {"kind", "argv"}, field_name)
        validate_required_string_list(value.get("argv"), f"{field_name} argv")
    elif kind == "shell":
        require_exact_keys(value, {"kind", "command"}, field_name)
        validate_non_empty_string(value.get("command"), f"{field_name} command")
    else:
        raise CheckpointError(f"{field_name} kind must be 'argv' or 'shell'.")
    return value


def reject_sensitive_descriptor_keys(value: Any, field_name: str) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise CheckpointError(f"{field_name} keys must be strings.")
            normalized = key.lower().replace("-", "_")
            if normalized in SENSITIVE_DESCRIPTOR_KEYS:
                raise CheckpointError(f"{field_name} contains a sensitive key: {key!r}.")
            reject_sensitive_descriptor_keys(nested, field_name)
    elif isinstance(value, list):
        for nested in value:
            reject_sensitive_descriptor_keys(nested, field_name)


def validate_mechanical_check_descriptor(
    value: Any,
    repo: Path,
    field_name: str,
    *,
    result_fields: bool,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CheckpointError(f"{field_name} must be an object.")
    identity_fields = {
        "check_id",
        "invocation",
        "cwd",
        "configuration",
        "toolchain",
        "environment",
    }
    expected = set(identity_fields)
    if result_fields:
        expected.update({"volatile", "verdict", "exit_status", "evidence"})
    require_exact_keys(value, expected, field_name)
    check_id = safe_id(
        validate_non_empty_string(value.get("check_id"), f"{field_name} check_id"),
        "mechanical check ID",
    )
    invocation = validate_invocation_descriptor(value.get("invocation"), f"{field_name} invocation")
    cwd = normalized_check_cwd(repo, value.get("cwd"))
    descriptors: dict[str, dict[str, Any]] = {}
    for key in ("configuration", "toolchain", "environment"):
        descriptor = value.get(key)
        if not isinstance(descriptor, dict):
            raise CheckpointError(f"{field_name} {key} must be an object.")
        reject_sensitive_descriptor_keys(descriptor, f"{field_name} {key}")
        descriptors[key] = descriptor
    normalized: dict[str, Any] = {
        "check_id": check_id,
        "invocation": invocation,
        "cwd": cwd,
        **descriptors,
    }
    if result_fields:
        if not isinstance(value.get("volatile"), bool):
            raise CheckpointError(f"{field_name} volatile must be a boolean.")
        if value.get("verdict") not in {"passed", "failed", "blocked"}:
            raise CheckpointError(f"{field_name} verdict is invalid.")
        exit_status = value.get("exit_status")
        if exit_status is not None and (not isinstance(exit_status, int) or isinstance(exit_status, bool)):
            raise CheckpointError(f"{field_name} exit_status must be an integer or null.")
        evidence = validate_required_string_list(value.get("evidence"), f"{field_name} evidence")
        normalized.update(
            {
                "volatile": value["volatile"],
                "verdict": value["verdict"],
                "exit_status": exit_status,
                "evidence": evidence,
            }
        )
    normalized["identity_sha256"] = sha256_bytes(
        canonical_json({key: normalized[key] for key in identity_fields})
    )
    return normalized


def validate_mechanical_evidence_report(
    report: dict[str, Any],
    repo: Path,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    require_exact_keys(
        report,
        {
            "schema_version",
            "checkpoint_id",
            "task_result_snapshot_sha256",
            "producer",
            "checks",
        },
        "Mechanical evidence report",
    )
    if report.get("schema_version") != 1 or isinstance(report.get("schema_version"), bool):
        raise CheckpointError("Mechanical evidence schema_version must be integer 1.")
    if report.get("checkpoint_id") != manifest["checkpoint_id"]:
        raise CheckpointError("Mechanical evidence checkpoint_id does not match the checkpoint.")
    if report.get("task_result_snapshot_sha256") != manifest["snapshot_sha256"]:
        raise CheckpointError("Mechanical evidence task-result digest does not match the checkpoint.")
    if report.get("producer") not in {"implementation", "integration", "mechanical_validation"}:
        raise CheckpointError("Mechanical evidence producer is invalid.")
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        raise CheckpointError("Mechanical evidence checks must be a non-empty array.")
    normalized_checks = [
        validate_mechanical_check_descriptor(
            check,
            repo,
            f"Mechanical evidence check {index}",
            result_fields=True,
        )
        for index, check in enumerate(checks)
    ]
    check_ids = [check["check_id"] for check in normalized_checks]
    if len(check_ids) != len(set(check_ids)):
        raise CheckpointError("Mechanical evidence check IDs must be unique.")
    return {
        "schema_version": 1,
        "checkpoint_id": manifest["checkpoint_id"],
        "task_result_snapshot_sha256": manifest["snapshot_sha256"],
        "producer": report["producer"],
        "checks": normalized_checks,
    }


def redact_mechanical_evidence_report(report: dict[str, Any]) -> dict[str, Any]:
    """Reduce reusable evidence to non-secret identities before persistence."""

    return {
        "schema_version": report["schema_version"],
        "checkpoint_id": report["checkpoint_id"],
        "task_result_snapshot_sha256": report["task_result_snapshot_sha256"],
        "producer": report["producer"],
        "checks": [
            {
                "check_id": check["check_id"],
                "identity_sha256": check["identity_sha256"],
                "volatile": check["volatile"],
                "verdict": check["verdict"],
                "exit_status": check["exit_status"],
                "evidence_sha256": sha256_bytes(canonical_json(check["evidence"])),
            }
            for check in report["checks"]
        ],
    }


def validate_stored_mechanical_evidence_report(
    report: Any,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(report, dict):
        raise CheckpointError("Stored mechanical evidence report must be an object.")
    require_exact_keys(
        report,
        {
            "schema_version",
            "checkpoint_id",
            "task_result_snapshot_sha256",
            "producer",
            "checks",
        },
        "Stored mechanical evidence report",
    )
    if report.get("schema_version") != 1 or isinstance(report.get("schema_version"), bool):
        raise CheckpointError("Stored mechanical evidence schema_version must be integer 1.")
    if report.get("checkpoint_id") != manifest["checkpoint_id"]:
        raise CheckpointError("Stored mechanical evidence checkpoint_id is invalid.")
    if report.get("task_result_snapshot_sha256") != manifest["snapshot_sha256"]:
        raise CheckpointError("Stored mechanical evidence task-result digest is invalid.")
    if report.get("producer") not in {"implementation", "integration", "mechanical_validation"}:
        raise CheckpointError("Stored mechanical evidence producer is invalid.")
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        raise CheckpointError("Stored mechanical evidence checks must be a non-empty array.")

    normalized_checks: list[dict[str, Any]] = []
    for index, check in enumerate(checks):
        if not isinstance(check, dict):
            raise CheckpointError(f"Stored mechanical evidence check {index} must be an object.")
        require_exact_keys(
            check,
            {
                "check_id",
                "identity_sha256",
                "volatile",
                "verdict",
                "exit_status",
                "evidence_sha256",
            },
            f"Stored mechanical evidence check {index}",
        )
        check_id = safe_id(
            validate_non_empty_string(
                check.get("check_id"),
                f"Stored mechanical evidence check {index} ID",
            ),
            "mechanical check ID",
        )
        validate_digest(check.get("identity_sha256"), f"identity digest for {check_id}")
        validate_digest(check.get("evidence_sha256"), f"evidence digest for {check_id}")
        if not isinstance(check.get("volatile"), bool):
            raise CheckpointError(f"Stored mechanical evidence check {check_id} volatile is invalid.")
        if check.get("verdict") not in {"passed", "failed", "blocked"}:
            raise CheckpointError(f"Stored mechanical evidence check {check_id} verdict is invalid.")
        exit_status = check.get("exit_status")
        if exit_status is not None and (
            not isinstance(exit_status, int) or isinstance(exit_status, bool)
        ):
            raise CheckpointError(
                f"Stored mechanical evidence check {check_id} exit_status is invalid."
            )
        normalized_checks.append(
            {
                "check_id": check_id,
                "identity_sha256": check["identity_sha256"],
                "volatile": check["volatile"],
                "verdict": check["verdict"],
                "exit_status": exit_status,
                "evidence_sha256": check["evidence_sha256"],
            }
        )
    check_ids = [check["check_id"] for check in normalized_checks]
    if len(check_ids) != len(set(check_ids)):
        raise CheckpointError("Stored mechanical evidence check IDs must be unique.")
    return {
        "schema_version": 1,
        "checkpoint_id": manifest["checkpoint_id"],
        "task_result_snapshot_sha256": manifest["snapshot_sha256"],
        "producer": report["producer"],
        "checks": normalized_checks,
    }


def checkpoint_matches_current_worktree(
    store: Path,
    workflow_id: str,
    repo: Path,
    manifest: dict[str, Any],
) -> bool:
    current = working_manifest_for_match(manifest, repo, store, workflow_id)
    current["checkpoint_id"] = "working-tree"
    current["plan"].setdefault("path", manifest["plan"]["path"])
    delta = diff_manifests(store, workflow_id, manifest, current, include_patches=False)
    return not (
        delta["base_commit_changed"]
        or delta["head_commit_changed"]
        or delta["worktree_guard_changed"]
        or delta["plan_changed"]
        or delta["changes"]
    )


def record_mechanical_evidence(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    evidence_id = safe_id(args.evidence_id, "mechanical evidence ID")
    manifest = load_manifest(store, workflow_id, args.checkpoint_id)
    if manifest["repo_root"] != str(repo):
        raise CheckpointError("Checkpoint belongs to a different repository.")
    if manifest_content_errors(store, workflow_id, manifest):
        raise CheckpointError("Checkpoint failed integrity verification.")
    if not checkpoint_matches_current_worktree(store, workflow_id, repo, manifest):
        raise CheckpointError(
            "Mechanical evidence cannot be recorded after the checkpoint target drifted."
        )
    submitted_report = validate_mechanical_evidence_report(
        read_review_report(args.report, repo),
        repo,
        manifest,
    )
    report = redact_mechanical_evidence_report(submitted_report)
    report_sha256 = sha256_bytes(canonical_json(report))
    envelope = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "mechanical_evidence",
        "workflow_id": workflow_id,
        "evidence_id": evidence_id,
        "report_sha256": report_sha256,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "report": report,
    }
    path = mechanical_evidence_path(store, workflow_id, evidence_id)
    write_immutable_json(path, envelope, trusted_root=store)
    return {
        "workflow_id": workflow_id,
        "evidence_id": evidence_id,
        "checkpoint_id": manifest["checkpoint_id"],
        "task_result_snapshot_sha256": manifest["snapshot_sha256"],
        "report_sha256": report_sha256,
        "record_path": str(path),
    }


def load_mechanical_evidence(
    store: Path,
    workflow_id: str,
    evidence_id: str,
    repo: Path,
) -> dict[str, Any]:
    path = mechanical_evidence_path(store, workflow_id, evidence_id)
    envelope = json.loads(
        read_regular_bytes(
            path,
            "Mechanical evidence record",
            MAX_REVIEW_REPORT_BYTES,
            trusted_root=store,
        ).decode("utf-8")
    )
    require_exact_keys(
        envelope,
        {
            "schema_version",
            "record_type",
            "workflow_id",
            "evidence_id",
            "report_sha256",
            "recorded_at",
            "report",
        },
        "Mechanical evidence envelope",
    )
    if (
        envelope.get("schema_version") != SCHEMA_VERSION
        or envelope.get("record_type") != "mechanical_evidence"
        or envelope.get("workflow_id") != workflow_id
        or envelope.get("evidence_id") != evidence_id
    ):
        raise CheckpointError(f"Mechanical evidence identity is invalid: {path}")
    report = envelope.get("report")
    if not isinstance(report, dict):
        raise CheckpointError(f"Mechanical evidence report is invalid: {path}")
    if envelope.get("report_sha256") != sha256_bytes(canonical_json(report)):
        raise CheckpointError(f"Mechanical evidence digest is invalid: {path}")
    source_checkpoint_id = safe_id(
        validate_non_empty_string(
            report.get("checkpoint_id"),
            "Mechanical evidence checkpoint_id",
        ),
        "checkpoint ID",
    )
    manifest = load_manifest(store, workflow_id, source_checkpoint_id)
    if manifest["repo_root"] != str(repo) or manifest_content_errors(store, workflow_id, manifest):
        raise CheckpointError(f"Mechanical evidence checkpoint is invalid: {path}")
    normalized = validate_stored_mechanical_evidence_report(report, manifest)
    if normalized != report:
        raise CheckpointError(f"Mechanical evidence report is not canonical: {path}")
    return envelope


def resolve_mechanical_evidence(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    manifest = load_manifest(store, workflow_id, args.checkpoint_id)
    if manifest["repo_root"] != str(repo) or manifest_content_errors(store, workflow_id, manifest):
        raise CheckpointError("Current checkpoint is unavailable or invalid.")

    current_matches = checkpoint_matches_current_worktree(
        store,
        workflow_id,
        repo,
        manifest,
    )

    requirements = read_review_report(args.requirements, repo)
    require_exact_keys(requirements, {"checks"}, "Mechanical evidence requirements")
    requested = requirements.get("checks")
    if not isinstance(requested, list) or not requested:
        raise CheckpointError("Mechanical evidence requirements checks must be non-empty.")
    normalized_requirements = [
        validate_mechanical_check_descriptor(
            check,
            repo,
            f"Mechanical evidence requirement {index}",
            result_fields=False,
        )
        for index, check in enumerate(requested)
    ]
    requested_ids = [check["check_id"] for check in normalized_requirements]
    if len(requested_ids) != len(set(requested_ids)):
        raise CheckpointError("Mechanical evidence requirement check IDs must be unique.")

    candidates: list[tuple[str, dict[str, Any]]] = []
    invalid_candidates: dict[str, str] = {}
    for raw_id in args.evidence_id:
        evidence_id = safe_id(raw_id, "mechanical evidence ID")
        try:
            candidates.append(
                (evidence_id, load_mechanical_evidence(store, workflow_id, evidence_id, repo))
            )
        except (CheckpointError, OSError, ValueError, json.JSONDecodeError) as exc:
            invalid_candidates[evidence_id] = str(exc)

    resolutions: list[dict[str, Any]] = []
    for requirement in normalized_requirements:
        matches: list[dict[str, Any]] = []
        miss_reasons: set[str] = set()
        if not current_matches:
            miss_reasons.add("current_worktree_drift")
        for evidence_id, envelope in candidates:
            report = envelope["report"]
            if report["task_result_snapshot_sha256"] != manifest["snapshot_sha256"]:
                miss_reasons.add("task_result_mismatch")
                continue
            for check in report["checks"]:
                if check["check_id"] != requirement["check_id"]:
                    continue
                if check["identity_sha256"] != requirement["identity_sha256"]:
                    miss_reasons.add("invocation_context_mismatch")
                    continue
                if check["volatile"]:
                    miss_reasons.add("volatile_evidence")
                    continue
                if check["verdict"] != "passed" or check["exit_status"] != 0:
                    miss_reasons.add("not_green")
                    continue
                if current_matches:
                    matches.append(
                        {
                            "evidence_id": evidence_id,
                            "report_sha256": envelope["report_sha256"],
                            "identity_sha256": check["identity_sha256"],
                            "evidence_sha256": check["evidence_sha256"],
                        }
                    )
        if matches:
            resolutions.append(
                {
                    "check_id": requirement["check_id"],
                    "disposition": "reused",
                    "source": matches[0],
                    "miss_reasons": [],
                }
            )
        else:
            if invalid_candidates:
                miss_reasons.add("invalid_evidence_record")
            if not miss_reasons:
                miss_reasons.add("no_matching_evidence")
            resolutions.append(
                {
                    "check_id": requirement["check_id"],
                    "disposition": "execute",
                    "source": None,
                    "miss_reasons": sorted(miss_reasons),
                }
            )
    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "mechanical_evidence_resolution",
        "workflow_id": workflow_id,
        "checkpoint_id": manifest["checkpoint_id"],
        "task_result_snapshot_sha256": manifest["snapshot_sha256"],
        "current_worktree_matches": current_matches,
        "resolutions": resolutions,
        "invalid_candidates": invalid_candidates,
    }


def read_plan_review_envelope(
    path: Path,
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    envelope = json.loads(
        read_regular_bytes(
            path,
            "Plan review record",
            MAX_REVIEW_REPORT_BYTES,
            trusted_root=store,
        ).decode("utf-8")
    )
    if not isinstance(envelope, dict) or envelope.get("schema_version") != SCHEMA_VERSION:
        raise CheckpointError(f"Malformed plan review record: {path}")
    expected = {
        "record_type": "plan_review",
        "workflow_id": workflow_id,
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
    }
    for field, value in expected.items():
        if envelope.get(field) != value:
            raise CheckpointError(
                f"Plan review record {field} does not match its checkpoint: {path}"
            )
    report = envelope.get("report")
    if not isinstance(report, dict):
        raise CheckpointError(f"Plan review record payload is malformed: {path}")
    validate_digest(envelope.get("report_sha256"), "plan review report digest")
    if envelope["report_sha256"] != sha256_bytes(canonical_json(report)):
        raise CheckpointError(f"Plan review report fingerprint mismatch: {path}")
    if report.get("checkpoint_id") != manifest["checkpoint_id"]:
        raise CheckpointError(f"Plan review checkpoint binding is invalid: {path}")
    if report.get("snapshot_sha256") != manifest["snapshot_sha256"]:
        raise CheckpointError(f"Plan review snapshot binding is invalid: {path}")
    if report.get("verdict") not in {"approved", "rework_required", "blocked"}:
        raise CheckpointError(f"Plan review verdict is invalid: {path}")
    return envelope


def load_prior_plan_review(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    previous_id = manifest.get("previous_checkpoint")
    if previous_id is None:
        return None, None
    previous_manifest = load_plan_manifest(store, workflow_id, previous_id)
    previous_errors = plan_manifest_content_errors(store, workflow_id, previous_manifest)
    if previous_errors:
        raise CheckpointError(
            "Previous plan checkpoint failed integrity verification: "
            f"{previous_errors}"
        )
    path = plan_review_path(store, workflow_id, previous_id)
    if not store_path_exists(path, store):
        return previous_manifest, None
    try:
        envelope = read_plan_review_envelope(path, store, workflow_id, previous_manifest)
        validate_plan_review_report(store, workflow_id, previous_manifest, envelope["report"])
        return previous_manifest, envelope["report"]
    except (CheckpointError, OSError, ValueError, json.JSONDecodeError):
        return previous_manifest, None


def validate_string_list(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise CheckpointError(f"{field_name} must be a list of non-empty strings.")
    if len(value) != len(set(value)):
        raise CheckpointError(f"{field_name} must not contain duplicates.")
    return value


def require_exact_keys(value: dict[str, Any], expected: set[str], field_name: str) -> None:
    received = set(value)
    if received != expected:
        raise CheckpointError(
            f"{field_name} fields are invalid; "
            f"missing={sorted(expected - received)}, unknown={sorted(received - expected)}."
        )


def validate_non_empty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CheckpointError(f"{field_name} must be a non-empty string.")
    return value


def validate_required_string_list(value: Any, field_name: str) -> list[str]:
    values = validate_string_list(value, field_name)
    if not values:
        raise CheckpointError(f"{field_name} must not be empty.")
    return values


def load_prior_strict_review(
    store: Path,
    workflow_id: str,
    gate: str,
    manifest: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
    previous_id = manifest["scope"].get("previous_checkpoint")
    if previous_id is None:
        return None, None, None
    try:
        previous_manifest = load_manifest(store, workflow_id, previous_id)
    except (CheckpointError, OSError, ValueError, json.JSONDecodeError):
        return None, None, None
    if manifest_content_errors(store, workflow_id, previous_manifest):
        return previous_manifest, None, None
    path = review_path(store, workflow_id, gate, previous_id)
    if not store_path_exists(path, store):
        return previous_manifest, None, None
    try:
        state = verify_review_record(path, store, workflow_id, gate, previous_manifest)
        if not state.startswith("strict-"):
            return previous_manifest, None, None
        envelope = json.loads(
            read_regular_bytes(
                path,
                "Prior review record",
                MAX_REVIEW_REPORT_BYTES,
                trusted_root=store,
            ).decode("utf-8")
        )
        return previous_manifest, envelope["report"], envelope["report_sha256"]
    except (CheckpointError, OSError, ValueError, json.JSONDecodeError):
        return previous_manifest, None, None


def review_delta(
    store: Path,
    workflow_id: str,
    previous_manifest: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    return diff_manifests(
        store,
        workflow_id,
        previous_manifest,
        manifest,
        include_patches=False,
    )


def dependent_surface_closure(
    surfaces: dict[str, dict[str, Any]],
    starting_ids: set[str],
) -> set[str]:
    affected = set(starting_ids)
    changed = True
    while changed:
        changed = False
        for surface_id, record in surfaces.items():
            if surface_id in affected:
                continue
            if any(dependency in affected for dependency in record["depends_on"]):
                affected.add(surface_id)
                changed = True
    return affected


def implementation_review_scope(
    store: Path,
    workflow_id: str,
    gate: str,
    manifest: dict[str, Any],
    *,
    include_patches: bool,
    selected_surface_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Build the immutable minimum scope for a successor implementation review."""

    previous_manifest, previous_report, previous_review_sha256 = load_prior_strict_review(
        store,
        workflow_id,
        gate,
        manifest,
    )
    current_paths = set(manifest["files"])
    if previous_manifest is None or previous_report is None:
        if selected_surface_ids:
            raise CheckpointError(
                "A surface selector requires a qualifying prior strict review record."
            )
        return {
            "schema_version": SCHEMA_VERSION,
            "record_type": "implementation_review_scope",
            "workflow_id": workflow_id,
            "gate": gate,
            "mode": "full",
            "checkpoint_id": manifest["checkpoint_id"],
            "snapshot_sha256": manifest["snapshot_sha256"],
            "previous_checkpoint_id": manifest["scope"].get("previous_checkpoint"),
            "previous_review_sha256": None,
            "delta_sha256": None,
            "required_review_surface_ids": [],
            "prior_finding_surface_ids": [],
            "dependency_affected_surface_ids": [],
            "carriable_surface_ids": [],
            "unassigned_changed_paths": sorted(current_paths),
            "pending_paths": sorted(current_paths),
            "reopen_reasons": {},
            "carry_forward_surfaces": {},
            "changes": [],
            "selected_surfaces": {},
            "limitations": [
                "No qualifying prior strict review exists; the complete current target requires review."
            ],
        }

    prior_surfaces = previous_report["coverage_ledger"]["surfaces"]
    requested = selected_surface_ids or []
    unknown_requested = set(requested) - set(prior_surfaces)
    if unknown_requested:
        raise CheckpointError(
            f"Unknown prior review surfaces: {sorted(unknown_requested)}."
        )

    delta = review_delta(store, workflow_id, previous_manifest, manifest)
    presentation_delta = (
        diff_manifests(
            store,
            workflow_id,
            previous_manifest,
            manifest,
            include_patches=True,
        )
        if include_patches
        else delta
    )
    changed_paths = {change["path"] for change in delta["changes"]}
    path_owners: dict[str, set[str]] = {}
    for surface_id, record in prior_surfaces.items():
        for path in record["paths"]:
            path_owners.setdefault(path, set()).add(surface_id)

    directly_changed = {
        surface_id
        for path in changed_paths
        for surface_id in path_owners.get(path, set())
    }
    prior_finding_surfaces = {
        surface_id
        for finding in previous_report["blocking_findings"]
        for surface_id in finding["affected_surface_ids"]
        if surface_id in prior_surfaces
    }
    required = dependent_surface_closure(
        prior_surfaces,
        directly_changed | prior_finding_surfaces,
    )
    dependency_affected = required - directly_changed - prior_finding_surfaces

    reasons: dict[str, list[str]] = {}
    for surface_id in sorted(required):
        surface_paths = set(prior_surfaces[surface_id]["paths"])
        surface_reasons: list[str] = []
        if surface_paths & changed_paths:
            surface_reasons.append("owns_changed_path")
        if surface_id in prior_finding_surfaces:
            surface_reasons.append("has_prior_finding")
        if surface_id in dependency_affected:
            surface_reasons.append("transitively_depends_on_pending_surface")
        reasons[surface_id] = surface_reasons

    unassigned_changed_paths = {
        path for path in changed_paths if not path_owners.get(path)
    }
    carriable: set[str] = set()
    carry_forward: dict[str, dict[str, Any]] = {}
    for surface_id, record in prior_surfaces.items():
        if surface_id in required or record["status"] != "validated" or record["finding_ids"]:
            continue
        paths = set(record["paths"])
        if not paths <= current_paths or paths & changed_paths:
            continue
        carriable.add(surface_id)
        carried = dict(record)
        carried["disposition"] = "carried_forward"
        carried["carry_forward_rationale"] = (
            "Unchanged prior validated surface outside the helper-computed affected closure."
        )
        carry_forward[surface_id] = carried

    pending_paths = set(unassigned_changed_paths)
    for surface_id in required:
        pending_paths.update(prior_surfaces[surface_id]["paths"])

    selected_set = set(requested)
    visible_changes = presentation_delta["changes"]
    if selected_set:
        selected_paths = {
            path
            for surface_id in selected_set
            for path in prior_surfaces[surface_id]["paths"]
        }
        visible_changes = [
            change for change in visible_changes if change["path"] in selected_paths
        ]

    selected_surfaces = {
        surface_id: {
            "state": "required" if surface_id in required else "closed",
            "reopen_reasons": reasons.get(surface_id, []),
            "prior_coverage": prior_surfaces[surface_id],
            "current_paths": sorted(
                path for path in prior_surfaces[surface_id]["paths"] if path in current_paths
            ),
        }
        for surface_id in requested
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "implementation_review_scope",
        "workflow_id": workflow_id,
        "gate": gate,
        "mode": "incremental",
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
        "previous_checkpoint_id": previous_manifest["checkpoint_id"],
        "previous_review_sha256": previous_review_sha256,
        "delta_sha256": delta["delta_sha256"],
        "required_review_surface_ids": sorted(required),
        "prior_finding_surface_ids": sorted(prior_finding_surfaces),
        "dependency_affected_surface_ids": sorted(dependency_affected),
        "carriable_surface_ids": sorted(carriable),
        "unassigned_changed_paths": sorted(unassigned_changed_paths),
        "pending_paths": sorted(pending_paths),
        "reopen_reasons": reasons,
        "carry_forward_surfaces": carry_forward,
        "changes": visible_changes,
        "selected_surfaces": selected_surfaces,
        "limitations": [],
    }


def select_plan_review_sections(
    store: Path,
    workflow_id: str,
    old: dict[str, Any],
    new: dict[str, Any],
    delta: dict[str, Any],
    section_ids: list[str],
) -> dict[str, Any]:
    """Return exact immutable text and scope state for selected plan sections."""

    known = set(old["sections"]) | set(new["sections"])
    requested = [safe_id(value, "plan section ID") for value in section_ids]
    unknown = set(requested) - known
    if unknown:
        raise CheckpointError(f"Unknown plan sections: {sorted(unknown)}.")
    old_payload = plan_payload_for_manifest(store, workflow_id, old)
    new_payload = plan_payload_for_manifest(store, workflow_id, new)
    required = set(delta["required_review_section_ids"])
    carriable = set(delta["carriable_section_ids"])
    changes_by_id = {change["section_id"]: change for change in delta["changes"]}
    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "plan_review_scope_selection",
        "workflow_id": workflow_id,
        "from_checkpoint": old["checkpoint_id"],
        "to_checkpoint": new["checkpoint_id"],
        "selected_sections": {
            section_id: {
                "state": (
                    "required"
                    if section_id in required
                    else "closed"
                    if section_id in carriable
                    else "unclassified"
                ),
                "change": changes_by_id.get(section_id),
                "previous": old["sections"].get(section_id),
                "current": new["sections"].get(section_id),
                "previous_text": plan_section_payload(
                    old_payload,
                    old["sections"].get(section_id),
                    subtree=True,
                ).decode("utf-8"),
                "current_text": plan_section_payload(
                    new_payload,
                    new["sections"].get(section_id),
                    subtree=True,
                ).decode("utf-8"),
            }
            for section_id in requested
        },
    }


def create_plan_projection(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
    section_ids: list[str],
) -> dict[str, Any]:
    """Extract an exact implementation handoff from one approved plan checkpoint."""

    requested = [safe_id(value, "plan section ID") for value in section_ids]
    if len(requested) != len(set(requested)):
        raise CheckpointError("Plan projection section IDs must be unique.")
    unknown = set(requested) - set(manifest["sections"])
    if unknown:
        raise CheckpointError(f"Unknown plan sections: {sorted(unknown)}.")

    payload = plan_payload_for_manifest(store, workflow_id, manifest)
    sections = [
        {
            "section_id": section_id,
            "title": manifest["sections"][section_id]["title"],
            "heading_path": manifest["sections"][section_id]["heading_path"],
            "parent_id": manifest["sections"][section_id]["parent_id"],
            "subtree_sha256": manifest["sections"][section_id]["subtree_sha256"],
            "content": plan_section_payload(
                payload,
                manifest["sections"][section_id],
                subtree=True,
            ).decode("utf-8"),
        }
        for section_id in requested
    ]
    identity = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "approved_plan_projection",
        "workflow_id": workflow_id,
        "checkpoint_id": manifest["checkpoint_id"],
        "plan_snapshot_sha256": manifest["snapshot_sha256"],
        "plan_sha256": manifest["plan"]["sha256"],
        "sections": sections,
    }
    return {
        **identity,
        "projection_sha256": sha256_bytes(canonical_json(identity)),
    }


def validate_review_report(
    store: Path,
    workflow_id: str,
    gate: str,
    manifest: dict[str, Any],
    report: dict[str, Any],
) -> None:
    common_fields = {
        "report_schema_version",
        "verdict",
        "summary",
        "checkpoint_id",
        "snapshot_sha256",
        "task_result_snapshot_sha256",
        "previous_checkpoint_id",
        "previous_snapshot_sha256",
        "previous_review_sha256",
        "delta",
        "blocking_findings",
        "non_blocking_findings",
        "required_corrections",
        "prior_finding_results",
        "recommended_next_phase",
        "recommended_rollback_phase",
        "coverage_ledger",
        "impact_analysis",
    }
    gate_fields = {"mechanical_validation_report_sha256"} if gate == "planner" else {"safe_to_close"}
    require_exact_keys(report, common_fields | gate_fields, "Review report")

    if report.get("report_schema_version") != 1 or isinstance(
        report.get("report_schema_version"), bool
    ):
        raise CheckpointError("Review report_schema_version must be integer 1.")
    verdict = report.get("verdict")
    if verdict not in {"approved", "rework_required", "blocked"}:
        raise CheckpointError("Review report verdict is missing or invalid.")
    validate_non_empty_string(report.get("summary"), "Review summary")
    validate_non_empty_string(
        report.get("recommended_next_phase"),
        "Review recommended_next_phase",
    )
    approved_next_phase = "post_planner_choice" if gate == "planner" else "closure"
    if verdict == "approved" and report.get("recommended_next_phase") != approved_next_phase:
        raise CheckpointError(
            f"An approved {gate} review must recommend {approved_next_phase!r}."
        )
    rollback = report.get("recommended_rollback_phase")
    if rollback is not None:
        validate_non_empty_string(rollback, "Review recommended_rollback_phase")
    if verdict == "rework_required" and rollback is None:
        raise CheckpointError("A rework-required review requires a rollback phase.")
    if verdict != "rework_required" and rollback is not None:
        raise CheckpointError("Only a rework-required review may name a rollback phase.")

    checkpoint_id = validate_non_empty_string(report.get("checkpoint_id"), "Review checkpoint_id")
    safe_id(checkpoint_id, "review checkpoint ID")
    if checkpoint_id != manifest["checkpoint_id"]:
        raise CheckpointError("Review report checkpoint_id does not match the checkpoint.")
    snapshot = validate_digest(report.get("snapshot_sha256"), "review snapshot digest")
    task_result = validate_digest(
        report.get("task_result_snapshot_sha256"),
        "review task-result digest",
    )
    if snapshot != manifest["snapshot_sha256"] or task_result != snapshot:
        raise CheckpointError(
            "Review snapshot_sha256 and task_result_snapshot_sha256 must equal the checkpoint snapshot."
        )

    if gate == "planner":
        validate_digest(
            report.get("mechanical_validation_report_sha256"),
            "mechanical validation report digest",
        )
    else:
        if not isinstance(report.get("safe_to_close"), bool):
            raise CheckpointError("Expert safe_to_close must be a boolean.")

    previous_manifest, previous_report, previous_review_sha256 = load_prior_strict_review(
        store,
        workflow_id,
        gate,
        manifest,
    )
    lineage_previous_id = manifest["scope"].get("previous_checkpoint")
    if lineage_previous_id is None:
        if any(
            report.get(field) is not None
            for field in (
                "previous_checkpoint_id",
                "previous_snapshot_sha256",
                "previous_review_sha256",
                "delta",
            )
        ):
            raise CheckpointError("A first review must use null predecessor and delta fields.")
    else:
        if report.get("previous_checkpoint_id") != lineage_previous_id:
            raise CheckpointError("Review previous_checkpoint_id must bind the direct predecessor.")
        if previous_manifest is None:
            raise CheckpointError("The direct predecessor manifest is unavailable or invalid.")
        if report.get("previous_snapshot_sha256") != previous_manifest["snapshot_sha256"]:
            raise CheckpointError("Review previous_snapshot_sha256 does not match its predecessor.")
        supplied_prior_digest = report.get("previous_review_sha256")
        if previous_report is None:
            if supplied_prior_digest is not None:
                raise CheckpointError(
                    "A full recovery without qualifying prior evidence must use a null previous_review_sha256."
                )
        elif supplied_prior_digest != previous_review_sha256:
            raise CheckpointError("Review previous_review_sha256 does not match the prior strict record.")
        delta = report.get("delta")
        if not isinstance(delta, dict):
            raise CheckpointError("A successor review requires a delta object.")
        require_exact_keys(
            delta,
            {"from_checkpoint_id", "to_checkpoint_id", "sha256"},
            "Review delta",
        )
        if (
            delta.get("from_checkpoint_id") != lineage_previous_id
            or delta.get("to_checkpoint_id") != manifest["checkpoint_id"]
        ):
            raise CheckpointError("Review delta checkpoint IDs do not bind the direct lineage.")
        validate_digest(delta.get("sha256"), "review delta digest")
        expected_delta = review_delta(store, workflow_id, previous_manifest, manifest)
        if delta["sha256"] != expected_delta["delta_sha256"]:
            raise CheckpointError("Review delta digest does not match the canonical checkpoint delta.")

    blocking = report.get("blocking_findings")
    if not isinstance(blocking, list):
        raise CheckpointError("Review blocking_findings must be an array.")
    blocking_by_id: dict[str, dict[str, Any]] = {}
    for index, finding in enumerate(blocking):
        if not isinstance(finding, dict):
            raise CheckpointError(f"Blocking finding {index} must be an object.")
        expected = {
            "finding_id",
            "kind",
            "summary",
            "impact",
            "recommended_action",
            "evidence",
            "affected_surface_ids",
            "plan_clause_ids" if gate == "planner" else "severity",
        }
        require_exact_keys(finding, expected, f"Blocking finding {index}")
        finding_id = safe_id(
            validate_non_empty_string(finding.get("finding_id"), "Finding ID"),
            "finding ID",
        )
        if finding_id in blocking_by_id:
            raise CheckpointError(f"Duplicate blocking finding ID: {finding_id}")
        if finding.get("kind") not in {"finding", "blocker"}:
            raise CheckpointError(f"Blocking finding {finding_id} has an invalid kind.")
        for field in ("summary", "impact", "recommended_action"):
            validate_non_empty_string(finding.get(field), f"Finding {finding_id} {field}")
        validate_required_string_list(finding.get("evidence"), f"Finding {finding_id} evidence")
        validate_required_string_list(
            finding.get("affected_surface_ids"),
            f"Finding {finding_id} affected_surface_ids",
        )
        if gate == "planner":
            validate_required_string_list(
                finding.get("plan_clause_ids"),
                f"Finding {finding_id} plan_clause_ids",
            )
        elif finding.get("severity") not in {"critical", "high", "medium", "low"}:
            raise CheckpointError(f"Expert finding {finding_id} has an invalid severity.")
        blocking_by_id[finding_id] = finding

    observations = report.get("non_blocking_findings")
    if not isinstance(observations, list):
        raise CheckpointError("Review non_blocking_findings must be an array.")
    observation_ids: set[str] = set()
    for index, observation in enumerate(observations):
        if not isinstance(observation, dict):
            raise CheckpointError(f"Non-blocking finding {index} must be an object.")
        require_exact_keys(
            observation,
            {"observation_id", "summary", "evidence"},
            f"Non-blocking finding {index}",
        )
        observation_id = safe_id(
            validate_non_empty_string(observation.get("observation_id"), "Observation ID"),
            "observation ID",
        )
        if observation_id in observation_ids:
            raise CheckpointError(f"Duplicate observation ID: {observation_id}")
        observation_ids.add(observation_id)
        validate_non_empty_string(observation.get("summary"), f"Observation {observation_id} summary")
        validate_required_string_list(
            observation.get("evidence"),
            f"Observation {observation_id} evidence",
        )

    corrections = report.get("required_corrections")
    if not isinstance(corrections, list):
        raise CheckpointError("Review required_corrections must be an array.")
    correction_ids: set[str] = set()
    for index, correction in enumerate(corrections):
        if not isinstance(correction, dict):
            raise CheckpointError(f"Required correction {index} must be an object.")
        require_exact_keys(correction, {"finding_id", "action"}, f"Required correction {index}")
        finding_id = safe_id(
            validate_non_empty_string(correction.get("finding_id"), "Correction finding ID"),
            "correction finding ID",
        )
        if finding_id in correction_ids:
            raise CheckpointError(f"Duplicate correction finding ID: {finding_id}")
        correction_ids.add(finding_id)
        validate_non_empty_string(correction.get("action"), f"Correction {finding_id} action")
    expected_corrections = {
        finding_id
        for finding_id, finding in blocking_by_id.items()
        if finding["kind"] == "finding"
    }
    if correction_ids != expected_corrections:
        raise CheckpointError(
            "Required corrections must match actionable findings exactly; "
            f"expected={sorted(expected_corrections)}, received={sorted(correction_ids)}."
        )

    ledger = report.get("coverage_ledger")
    if not isinstance(ledger, dict):
        raise CheckpointError("Review coverage_ledger must be an object.")
    require_exact_keys(
        ledger,
        {"mode", "surfaces", "surface_transitions", "limitations"},
        "Review coverage_ledger",
    )
    mode = ledger.get("mode")
    if mode not in {"full", "incremental"}:
        raise CheckpointError("Review coverage mode must be 'full' or 'incremental'.")
    surfaces_value = ledger.get("surfaces")
    if not isinstance(surfaces_value, dict) or not surfaces_value:
        raise CheckpointError("Review coverage surfaces must be a non-empty object.")
    current_paths = set(manifest["files"])
    surfaces: dict[str, dict[str, Any]] = {}
    reviewed_ids: set[str] = set()
    carried_ids: set[str] = set()
    covered_paths: set[str] = set()
    for surface_id, record in surfaces_value.items():
        safe_id(surface_id, "surface ID")
        if not isinstance(record, dict):
            raise CheckpointError(f"Coverage surface {surface_id!r} must be an object.")
        disposition = record.get("disposition")
        expected = {"paths", "disposition", "status", "depends_on", "invariants", "finding_ids"}
        if disposition == "carried_forward":
            expected.add("carry_forward_rationale")
        require_exact_keys(record, expected, f"Coverage surface {surface_id!r}")
        paths = validate_required_string_list(record.get("paths"), f"Surface {surface_id} paths")
        unknown_paths = set(paths) - current_paths
        if unknown_paths:
            raise CheckpointError(
                f"Coverage surface {surface_id!r} contains unknown manifest paths: {sorted(unknown_paths)}."
            )
        covered_paths.update(paths)
        if disposition not in {"reviewed", "carried_forward"}:
            raise CheckpointError(f"Coverage surface {surface_id!r} has an invalid disposition.")
        if disposition == "reviewed":
            reviewed_ids.add(surface_id)
        else:
            carried_ids.add(surface_id)
            validate_non_empty_string(
                record.get("carry_forward_rationale"),
                f"Surface {surface_id} carry_forward_rationale",
            )
        if record.get("status") not in {"validated", "finding", "blocked"}:
            raise CheckpointError(f"Coverage surface {surface_id!r} has an invalid status.")
        validate_string_list(record.get("depends_on"), f"Surface {surface_id} depends_on")
        validate_required_string_list(record.get("invariants"), f"Surface {surface_id} invariants")
        validate_string_list(record.get("finding_ids"), f"Surface {surface_id} finding_ids")
        surfaces[surface_id] = record
    if covered_paths != current_paths:
        raise CheckpointError(
            "Coverage surfaces must cover every manifest path exactly as a union; "
            f"missing={sorted(current_paths - covered_paths)}."
        )
    surface_ids = set(surfaces)
    for surface_id, record in surfaces.items():
        dependencies = set(record["depends_on"])
        unknown_dependencies = dependencies - surface_ids
        if unknown_dependencies or surface_id in dependencies:
            raise CheckpointError(
                f"Surface {surface_id!r} dependencies are invalid: "
                f"{sorted(unknown_dependencies | ({surface_id} & dependencies))}."
            )
        finding_ids = set(record["finding_ids"])
        unknown_findings = finding_ids - set(blocking_by_id)
        if unknown_findings:
            raise CheckpointError(
                f"Surface {surface_id!r} references unknown findings: {sorted(unknown_findings)}."
            )
        kinds = {blocking_by_id[item]["kind"] for item in finding_ids}
        if record["status"] == "validated" and finding_ids:
            raise CheckpointError(f"Validated surface {surface_id!r} cannot reference findings.")
        if record["status"] == "finding" and "finding" not in kinds:
            raise CheckpointError(f"Finding surface {surface_id!r} must reference an actionable finding.")
        if record["status"] == "blocked" and "blocker" not in kinds:
            raise CheckpointError(f"Blocked surface {surface_id!r} must reference a blocker.")
    for finding_id, finding in blocking_by_id.items():
        affected = set(finding["affected_surface_ids"])
        if not affected <= surface_ids:
            raise CheckpointError(
                f"Finding {finding_id} references unknown affected surfaces: {sorted(affected - surface_ids)}."
            )
        referencing_reviewed = {
            surface_id
            for surface_id, record in surfaces.items()
            if finding_id in record["finding_ids"] and surface_id in reviewed_ids
        }
        if not referencing_reviewed or not affected <= referencing_reviewed:
            raise CheckpointError(
                f"Finding {finding_id} must be referenced by every affected directly reviewed surface."
            )

    transitions = ledger.get("surface_transitions")
    if not isinstance(transitions, list):
        raise CheckpointError("Review surface_transitions must be an array.")
    transition_from: set[str] = set()
    transition_to: set[str] = set()
    for index, transition in enumerate(transitions):
        if not isinstance(transition, dict):
            raise CheckpointError(f"Surface transition {index} must be an object.")
        require_exact_keys(
            transition,
            {"kind", "from_surface_ids", "to_surface_ids", "rationale"},
            f"Surface transition {index}",
        )
        kind = transition.get("kind")
        if kind not in {"added", "removed", "renamed", "split", "merged"}:
            raise CheckpointError(f"Surface transition {index} has an invalid kind.")
        from_ids = validate_string_list(
            transition.get("from_surface_ids"),
            f"Surface transition {index} from_surface_ids",
        )
        to_ids = validate_string_list(
            transition.get("to_surface_ids"),
            f"Surface transition {index} to_surface_ids",
        )
        validate_non_empty_string(transition.get("rationale"), f"Surface transition {index} rationale")
        cardinalities = {
            "added": (0, 1),
            "removed": (1, 0),
            "renamed": (1, 1),
        }
        if kind in cardinalities and (len(from_ids), len(to_ids)) != cardinalities[kind]:
            raise CheckpointError(f"Surface transition {index} has invalid {kind} cardinality.")
        if kind == "split" and not (len(from_ids) == 1 and len(to_ids) > 1):
            raise CheckpointError(f"Surface transition {index} has invalid split cardinality.")
        if kind == "merged" and not (len(from_ids) > 1 and len(to_ids) == 1):
            raise CheckpointError(f"Surface transition {index} has invalid merged cardinality.")
        if transition_from & set(from_ids) or transition_to & set(to_ids):
            raise CheckpointError("Each non-stable surface may appear in only one transition.")
        transition_from.update(from_ids)
        transition_to.update(to_ids)
    validate_string_list(ledger.get("limitations"), "Review coverage limitations")

    prior_surfaces: dict[str, dict[str, Any]] = {}
    if previous_report is not None:
        prior_surfaces = previous_report["coverage_ledger"]["surfaces"]
        prior_ids = set(prior_surfaces)
        if transition_from != prior_ids - surface_ids or transition_to != surface_ids - prior_ids:
            raise CheckpointError(
                "Surface transitions must completely map every changed surface ID; "
                f"expected_from={sorted(prior_ids - surface_ids)}, "
                f"expected_to={sorted(surface_ids - prior_ids)}."
            )
        for transition in transitions:
            if not set(transition["from_surface_ids"]) <= prior_ids:
                raise CheckpointError("Surface transition sources must exist in the prior ledger.")
            if not set(transition["to_surface_ids"]) <= surface_ids:
                raise CheckpointError("Surface transition destinations must exist in the current ledger.")
    elif transitions:
        raise CheckpointError("A review without qualifying strict prior evidence cannot map transitions.")

    prior_results = report.get("prior_finding_results")
    if not isinstance(prior_results, list):
        raise CheckpointError("Review prior_finding_results must be an array.")
    prior_result_ids: set[str] = set()
    prior_blocking = {
        finding["finding_id"]: finding
        for finding in (previous_report or {}).get("blocking_findings", [])
    }
    valid_result_surfaces = reviewed_ids | transition_from
    for index, result in enumerate(prior_results):
        if not isinstance(result, dict):
            raise CheckpointError(f"Prior finding result {index} must be an object.")
        require_exact_keys(
            result,
            {"finding_id", "result", "evidence", "reviewed_surface_ids"},
            f"Prior finding result {index}",
        )
        finding_id = safe_id(
            validate_non_empty_string(result.get("finding_id"), "Prior finding ID"),
            "prior finding ID",
        )
        if finding_id in prior_result_ids:
            raise CheckpointError(f"Duplicate prior finding result: {finding_id}")
        prior_result_ids.add(finding_id)
        if result.get("result") not in {"resolved", "still_open", "blocked"}:
            raise CheckpointError(f"Prior finding result {finding_id} has an invalid result.")
        validate_required_string_list(result.get("evidence"), f"Prior result {finding_id} evidence")
        reviewed_surface_results = set(
            validate_required_string_list(
                result.get("reviewed_surface_ids"),
                f"Prior result {finding_id} reviewed_surface_ids",
            )
        )
        if not reviewed_surface_results <= valid_result_surfaces:
            raise CheckpointError(f"Prior result {finding_id} references an unknown surface.")
        remains = finding_id in blocking_by_id
        if result["result"] == "resolved" and remains:
            raise CheckpointError(f"Resolved prior finding {finding_id} remains in the blocking set.")
        if result["result"] != "resolved" and not remains:
            raise CheckpointError(f"Open prior finding {finding_id} is missing from the blocking set.")
    if prior_result_ids != set(prior_blocking):
        raise CheckpointError(
            "Prior finding results must account for every prior blocking finding exactly once."
        )

    if lineage_previous_id is None and mode != "full":
        raise CheckpointError("A first review must use full coverage mode.")
    if lineage_previous_id is None or mode == "full":
        if carried_ids or reviewed_ids != surface_ids:
            raise CheckpointError("A first or full review must directly review every current surface.")
        if report.get("impact_analysis") is not None:
            raise CheckpointError("A first or full review must use a null impact_analysis.")
    else:
        if previous_report is None:
            raise CheckpointError(
                "Incremental review requires a structurally valid qualifying strict prior record."
            )
        changed_paths = {
            change["path"]
            for change in review_delta(store, workflow_id, previous_manifest, manifest)["changes"]
        }
        current_changed_owners = {
            surface_id
            for surface_id, record in surfaces.items()
            if changed_paths & set(record["paths"])
        }
        prior_changed_owners = {
            surface_id
            for surface_id, record in prior_surfaces.items()
            if changed_paths & set(record["paths"])
        }
        prior_owned_paths = {
            path
            for record in prior_surfaces.values()
            for path in record["paths"]
        }
        newly_assigned_owners = {
            surface_id
            for surface_id, record in surfaces.items()
            if (changed_paths - prior_owned_paths) & set(record["paths"])
        }
        prior_finding_surfaces = {
            surface_id
            for finding in prior_blocking.values()
            for surface_id in finding["affected_surface_ids"]
        }
        if gate == "expert":
            required_review = dependent_surface_closure(surfaces, current_changed_owners)
            required_review.update(transition_to)
            stable_prior_finding_surfaces = prior_finding_surfaces & surface_ids
            required_review.update(stable_prior_finding_surfaces)
            for transition in transitions:
                if set(transition["from_surface_ids"]) & prior_finding_surfaces:
                    required_review.update(transition["to_surface_ids"])
        else:
            required_prior = dependent_surface_closure(
                prior_surfaces,
                prior_changed_owners | prior_finding_surfaces,
            )
            required_prior.update(
                dependent_surface_closure(
                    prior_surfaces,
                    newly_assigned_owners & set(prior_surfaces),
                )
            )
            arbitrary_transition_sources = transition_from - required_prior
            if arbitrary_transition_sources:
                raise CheckpointError(
                    "Incremental review cannot transition closed surfaces; use full mode or "
                    f"supply a changed or affected predecessor: {sorted(arbitrary_transition_sources)}."
                )
            required_review = (required_prior & surface_ids) | current_changed_owners
            for transition in transitions:
                if set(transition["from_surface_ids"]) & required_prior:
                    required_review.update(transition["to_surface_ids"])
        if not required_review <= reviewed_ids:
            raise CheckpointError(
                f"Incremental review omitted required surfaces: {sorted(required_review - reviewed_ids)}."
            )
        if not transition_to <= reviewed_ids:
            raise CheckpointError("Every transitioned current surface must be directly reviewed.")
        impact = report.get("impact_analysis")
        if not isinstance(impact, dict):
            raise CheckpointError("Incremental review requires an impact_analysis object.")
        require_exact_keys(
            impact,
            {"summary", "additionally_affected_surface_ids"},
            "Review impact_analysis",
        )
        validate_non_empty_string(impact.get("summary"), "Review impact_analysis summary")
        additional = set(
            validate_string_list(
                impact.get("additionally_affected_surface_ids"),
                "Review impact_analysis additionally_affected_surface_ids",
            )
        )
        expected_additional = reviewed_ids - required_review
        if additional != expected_additional:
            raise CheckpointError(
                "impact_analysis must identify every additionally reopened surface; "
                f"expected={sorted(expected_additional)}, received={sorted(additional)}."
            )

        if gate == "planner":
            for surface_id in set(prior_surfaces) & surface_ids:
                prior_dependencies = set(prior_surfaces[surface_id]["depends_on"])
                current_dependencies = set(surfaces[surface_id]["depends_on"])
                if not prior_dependencies <= current_dependencies:
                    raise CheckpointError(
                        f"Incremental review cannot remove dependencies from surface {surface_id!r}; "
                        "use full mode for semantic remapping."
                    )

            justified = set(required_review)
            remaining = set(additional)
            while remaining:
                newly_justified = {
                    surface_id
                    for surface_id in remaining
                    if (
                        set(surfaces[surface_id]["depends_on"])
                        - set(prior_surfaces.get(surface_id, {}).get("depends_on", []))
                    )
                    & justified
                }
                if not newly_justified:
                    raise CheckpointError(
                        "Additionally reopened surfaces require a newly recorded dependency "
                        "leading to helper-required scope; use full mode when impact cannot be bounded: "
                        f"{sorted(remaining)}."
                    )
                justified.update(newly_justified)
                remaining -= newly_justified
            changed_or_affected = set(required_review) | set(additional)
        else:
            changed_or_affected = dependent_surface_closure(surfaces, current_changed_owners)
            changed_or_affected.update(transition_to)
            changed_or_affected.update(stable_prior_finding_surfaces)
        for surface_id in carried_ids:
            prior = prior_surfaces.get(surface_id)
            current = surfaces[surface_id]
            if not isinstance(prior, dict) or prior.get("status") != "validated":
                raise CheckpointError(
                    f"Surface {surface_id!r} lacks prior validated coverage to carry forward."
                )
            for field in ("paths", "depends_on", "invariants", "status", "finding_ids"):
                if current.get(field) != prior.get(field):
                    raise CheckpointError(f"Carried surface {surface_id!r} changed its {field}.")
            if surface_id in changed_or_affected:
                raise CheckpointError(f"Changed or affected surface {surface_id!r} cannot be carried.")
            if any(
                entry_identity(previous_manifest["files"].get(path))
                != entry_identity(manifest["files"].get(path))
                for path in current["paths"]
            ):
                raise CheckpointError(f"Carried surface {surface_id!r} owns changed manifest content.")

    statuses = {record["status"] for record in surfaces.values()}
    actionable = expected_corrections
    blockers = {
        finding_id for finding_id, finding in blocking_by_id.items() if finding["kind"] == "blocker"
    }
    if verdict == "approved":
        if blocking_by_id or corrections or any(status != "validated" for status in statuses):
            raise CheckpointError(
                "An approved review requires validated surfaces and no blocking findings or corrections."
            )
        if gate == "expert" and report["safe_to_close"] is not True:
            raise CheckpointError("An approved expert review requires safe_to_close true.")
    elif verdict == "rework_required":
        if not actionable or "finding" not in statuses:
            raise CheckpointError(
                "A rework-required review requires an actionable finding and finding surface."
            )
        if gate == "expert" and report["safe_to_close"] is not False:
            raise CheckpointError("A non-approved expert review requires safe_to_close false.")
    else:
        if not blockers or "blocked" not in statuses:
            raise CheckpointError("A blocked review requires a blocker and blocked surface.")
        if gate == "expert" and report["safe_to_close"] is not False:
            raise CheckpointError("A non-approved expert review requires safe_to_close false.")


def validate_plan_review_report(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
    report: dict[str, Any],
) -> None:
    if report.get("checkpoint_id") != manifest["checkpoint_id"]:
        raise CheckpointError("Plan review checkpoint_id does not match the checkpoint.")
    if report.get("snapshot_sha256") != manifest["snapshot_sha256"]:
        raise CheckpointError("Plan review snapshot_sha256 does not match the checkpoint.")
    verdict = report.get("verdict")
    if verdict not in {"approved", "rework_required", "blocked"}:
        raise CheckpointError("Plan review verdict is missing or invalid.")

    previous_manifest, previous_report = load_prior_plan_review(store, workflow_id, manifest)
    expected_previous = manifest.get("previous_checkpoint")
    if report.get("previous_checkpoint") != expected_previous:
        raise CheckpointError("Plan review previous_checkpoint does not match its lineage.")

    ledger = report.get("coverage_ledger")
    if not isinstance(ledger, dict):
        raise CheckpointError("Plan review coverage_ledger must be an object.")
    mode = ledger.get("mode")
    if mode not in {"full", "incremental"}:
        raise CheckpointError("Plan review coverage mode must be 'full' or 'incremental'.")
    records = ledger.get("sections")
    if not isinstance(records, dict):
        raise CheckpointError("Plan review coverage sections must be an object.")
    current_ids = set(manifest["sections"])
    record_ids = set(records)
    if record_ids != current_ids:
        missing = sorted(current_ids - record_ids)
        unknown = sorted(record_ids - current_ids)
        raise CheckpointError(
            "Plan review coverage must account for every current section; "
            f"missing={missing}, unknown={unknown}."
        )

    reviewed_ids: set[str] = set()
    carried_ids: set[str] = set()
    statuses: list[str] = []
    for section_id, record in records.items():
        if not isinstance(record, dict):
            raise CheckpointError(f"Coverage record for {section_id!r} must be an object.")
        disposition = record.get("disposition")
        if disposition not in {"reviewed", "carried_forward"}:
            raise CheckpointError(
                f"Coverage disposition for {section_id!r} must be reviewed or carried_forward."
            )
        status_name = record.get("status")
        if status_name not in {"validated", "finding", "blocked"}:
            raise CheckpointError(f"Coverage status for {section_id!r} is invalid.")
        dependencies = validate_string_list(
            record.get("depends_on"),
            f"Coverage dependencies for {section_id!r}",
        )
        unknown_dependencies = set(dependencies) - current_ids
        if unknown_dependencies or section_id in dependencies:
            raise CheckpointError(
                f"Coverage dependencies for {section_id!r} are invalid: "
                f"{sorted(unknown_dependencies | ({section_id} & set(dependencies)))}."
            )
        validate_required_string_list(
            record.get("invariants"),
            f"Coverage invariants for {section_id!r}",
        )
        if disposition == "reviewed":
            reviewed_ids.add(section_id)
        else:
            rationale = record.get("carry_forward_rationale")
            if not isinstance(rationale, str) or not rationale.strip():
                raise CheckpointError(
                    f"Carried-forward section {section_id!r} requires a rationale."
                )
            carried_ids.add(section_id)
        statuses.append(status_name)

    deleted_reviewed = set(
        validate_string_list(
            ledger.get("deleted_section_ids_reviewed"),
            "coverage deleted_section_ids_reviewed",
        )
    )
    validate_string_list(ledger.get("limitations"), "coverage limitations")

    if previous_manifest is None:
        if mode != "full" or carried_ids or reviewed_ids != current_ids:
            raise CheckpointError(
                "The first plan review must be full and directly review every section."
            )
        if deleted_reviewed:
            raise CheckpointError("The first plan review cannot contain deleted sections.")
    else:
        prior_coverage = previous_report.get("coverage_ledger") if previous_report else None
        delta = diff_plan_manifests(
            store,
            workflow_id,
            previous_manifest,
            manifest,
            include_patches=False,
            prior_coverage=prior_coverage,
        )
        if deleted_reviewed != set(delta["deleted_section_ids"]):
            raise CheckpointError(
                "Plan review must explicitly account for every deleted section in the delta."
            )
        if mode == "full":
            if carried_ids or reviewed_ids != current_ids:
                raise CheckpointError("A full plan re-review must directly review every section.")
        else:
            if previous_report is None:
                raise CheckpointError(
                    "Incremental plan review requires the prior immutable review record."
                )
            required = set(delta["required_review_section_ids"])
            carriable = set(delta["carriable_section_ids"])
            if not required <= reviewed_ids:
                raise CheckpointError(
                    f"Incremental plan review omitted required sections: {sorted(required - reviewed_ids)}."
                )
            if not carried_ids <= carriable:
                raise CheckpointError(
                    "Incremental plan review carried non-carriable sections: "
                    f"{sorted(carried_ids - carriable)}."
                )
            impact_analysis = report.get("impact_analysis")
            if not isinstance(impact_analysis, dict):
                raise CheckpointError("Incremental plan review requires an impact_analysis object.")
            impact_summary = impact_analysis.get("summary")
            if not isinstance(impact_summary, str) or not impact_summary.strip():
                raise CheckpointError(
                    "Incremental plan review impact_analysis requires a non-empty summary."
                )
            additionally_affected = set(
                validate_string_list(
                    impact_analysis.get("additionally_affected_section_ids"),
                    "impact_analysis additionally_affected_section_ids",
                )
            )
            expected_additional = reviewed_ids - required
            if additionally_affected != expected_additional:
                raise CheckpointError(
                    "impact_analysis must identify every additionally affected section; "
                    f"expected={sorted(expected_additional)}, "
                    f"received={sorted(additionally_affected)}."
                )
            prior_records = previous_report["coverage_ledger"]["sections"]
            for section_id in set(prior_records) & current_ids:
                prior_dependencies = set(prior_records[section_id]["depends_on"])
                current_dependencies = set(records[section_id]["depends_on"])
                if not prior_dependencies <= current_dependencies:
                    raise CheckpointError(
                        f"Incremental plan review cannot remove dependencies from section "
                        f"{section_id!r}; use full mode for semantic remapping."
                    )

            justified = set(required)
            remaining = set(additionally_affected)
            while remaining:
                newly_justified = {
                    section_id
                    for section_id in remaining
                    if (
                        set(records[section_id]["depends_on"])
                        - set(prior_records.get(section_id, {}).get("depends_on", []))
                    )
                    & justified
                }
                if not newly_justified:
                    raise CheckpointError(
                        "Additionally reopened plan sections require a newly recorded "
                        "dependency leading to helper-required scope; use full mode when "
                        f"impact cannot be bounded: {sorted(remaining)}."
                    )
                justified.update(newly_justified)
                remaining -= newly_justified

            for section_id in carried_ids:
                prior = prior_records.get(section_id)
                current = records[section_id]
                if not isinstance(prior, dict) or prior.get("status") != "validated":
                    raise CheckpointError(
                        f"Section {section_id!r} lacks prior validated coverage to carry forward."
                    )
                for field in ("status", "depends_on", "invariants"):
                    if current.get(field) != prior.get(field):
                        raise CheckpointError(
                            f"Carried-forward section {section_id!r} changed its {field}."
                        )

    if verdict == "approved" and any(status != "validated" for status in statuses):
        raise CheckpointError("An approved plan review requires every section to be validated.")
    if verdict == "rework_required" and "finding" not in statuses:
        raise CheckpointError("A rework-required plan review must bind a finding to a section.")
    if verdict == "blocked" and "blocked" not in statuses:
        raise CheckpointError("A blocked plan review must bind the blocker to a section.")


def verify_plan_review_record(
    path: Path,
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
) -> None:
    envelope = read_plan_review_envelope(path, store, workflow_id, manifest)
    validate_plan_review_report(store, workflow_id, manifest, envelope["report"])


def bind_composed_identity(report: dict[str, Any], identity: dict[str, Any]) -> None:
    for field, expected in identity.items():
        if field in report and canonical_json(report[field]) != canonical_json(expected):
            raise CheckpointError(f"Composed review {field} contradicts the immutable checkpoint identity.")
        report[field] = expected


def direct_review_draft(report: dict[str, Any], record_key: str) -> dict[str, Any]:
    ledger = report.get("coverage_ledger")
    if not isinstance(ledger, dict) or ledger.get("mode") not in ("full", "incremental"):
        raise CheckpointError("Composed review requires an explicit full or incremental coverage ledger.")
    records = ledger.get(record_key)
    if not isinstance(records, dict):
        raise CheckpointError(f"Composed review coverage {record_key} must be an object.")
    for record_id, record in records.items():
        if (
            not isinstance(record, dict)
            or record.get("disposition") != "reviewed"
            or "carry_forward_rationale" in record
        ):
            raise CheckpointError(f"Composed review draft {record_id!r} must contain only direct review.")
    return records


def compose_review_report(
    store: Path,
    workflow_id: str,
    gate: str,
    manifest: dict[str, Any],
    report: dict[str, Any],
) -> dict[str, Any]:
    records = direct_review_draft(report, "surfaces")
    previous, prior, prior_digest = load_prior_strict_review(store, workflow_id, gate, manifest)
    previous_id = manifest["scope"].get("previous_checkpoint")
    if previous_id is not None and (
        previous is None or manifest_content_errors(store, workflow_id, previous)
    ):
        raise CheckpointError("Composed review requires a valid direct predecessor manifest.")
    delta = review_delta(store, workflow_id, previous, manifest) if previous is not None else None
    bind_composed_identity(report, {
        "report_schema_version": 1,
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
        "task_result_snapshot_sha256": manifest["snapshot_sha256"],
        "previous_checkpoint_id": previous_id,
        "previous_snapshot_sha256": previous["snapshot_sha256"] if previous is not None else None,
        "previous_review_sha256": prior_digest,
        "delta": {
            "from_checkpoint_id": previous_id,
            "to_checkpoint_id": manifest["checkpoint_id"],
            "sha256": delta["delta_sha256"],
        } if delta is not None else None,
    })
    if report["coverage_ledger"]["mode"] == "incremental":
        if previous is None or prior is None:
            raise CheckpointError("Incremental composition requires qualifying immutable prior review evidence.")
        transitions = report["coverage_ledger"].get("surface_transitions")
        if not isinstance(transitions, list) or any(not isinstance(item, dict) for item in transitions):
            raise CheckpointError("Composed review surface_transitions must be an array of objects.")
        transition_sources = {
            surface_id for transition in transitions
            for surface_id in validate_string_list(transition.get("from_surface_ids"), "Transition sources")
        }
        if gate == "planner":
            candidates = implementation_review_scope(
                store, workflow_id, gate, manifest, include_patches=False
            )["carry_forward_surfaces"]
        else:
            # Expert impact uses the proposed current graph. Reusing the planner's
            # prior graph here would silently make expert re-review more restrictive.
            candidates = {}
            finding_surfaces = {
                surface_id for finding in prior["blocking_findings"]
                for surface_id in finding["affected_surface_ids"]
            }
            for surface_id, record in prior["coverage_ledger"]["surfaces"].items():
                if (
                    record["status"] == "validated" and not record["finding_ids"]
                    and surface_id not in finding_surfaces | transition_sources | set(records)
                    and set(record["paths"]) <= set(manifest["files"])
                    and all(
                        entry_identity(previous["files"].get(path)) == entry_identity(manifest["files"].get(path))
                        for path in record["paths"]
                    )
                ):
                    candidates[surface_id] = {
                        **record, "disposition": "carried_forward",
                        "carry_forward_rationale": "Unchanged prior validated surface outside the current affected closure.",
                    }
            proposed = {**candidates, **records}
            for surface_id, record in proposed.items():
                validate_required_string_list(record.get("paths"), f"Surface {surface_id} paths")
                validate_string_list(record.get("depends_on"), f"Surface {surface_id} dependencies")
            changed_paths = {change["path"] for change in delta["changes"]}
            affected = dependent_surface_closure(proposed, {
                surface_id for surface_id, record in proposed.items()
                if changed_paths & set(record["paths"])
            })
            candidates = {key: value for key, value in candidates.items() if key not in affected}
        report["coverage_ledger"]["surfaces"] = {
            **{key: value for key, value in candidates.items() if key not in transition_sources},
            **records,
        }
    return report


def compose_plan_review_report(
    store: Path,
    workflow_id: str,
    manifest: dict[str, Any],
    report: dict[str, Any],
) -> dict[str, Any]:
    records = direct_review_draft(report, "sections")
    bind_composed_identity(report, {
        "checkpoint_id": manifest["checkpoint_id"],
        "snapshot_sha256": manifest["snapshot_sha256"],
        "previous_checkpoint": manifest.get("previous_checkpoint"),
    })
    if report["coverage_ledger"]["mode"] == "incremental":
        previous, prior = load_prior_plan_review(store, workflow_id, manifest)
        if previous is None or prior is None:
            raise CheckpointError("Incremental composition requires qualifying immutable prior plan review evidence.")
        delta = diff_plan_manifests(
            store, workflow_id, previous, manifest, include_patches=False,
            prior_coverage=prior["coverage_ledger"],
        )
        report["coverage_ledger"]["sections"] = {**delta["carry_forward_sections"], **records}
    return report


def composed_review_receipt(envelope: dict[str, Any], record_key: str) -> dict[str, Any]:
    report = envelope["report"]
    records = report["coverage_ledger"][record_key]
    return {
        **{field: envelope[field] for field in (
            "workflow_id", "checkpoint_id", "snapshot_sha256", "report_sha256", "record_path",
        )},
        "composed": True,
        "verdict": report["verdict"],
        "reviewed_ids": sorted(key for key, value in records.items() if value["disposition"] == "reviewed"),
        "carried_forward_ids": sorted(key for key, value in records.items() if value["disposition"] == "carried_forward"),
    }


def ensure_review_record_size(envelope: dict[str, Any]) -> None:
    serialized = json.dumps(envelope, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if len(serialized.encode("utf-8")) > MAX_REVIEW_REPORT_BYTES:
        raise CheckpointError(f"Composed evidence record exceeds the {MAX_REVIEW_REPORT_BYTES}-byte read limit.")


def record_plan_review(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    checkpoint_id = safe_id(args.checkpoint_id, "checkpoint ID")
    manifest = load_plan_manifest(store, workflow_id, checkpoint_id)
    if manifest["repo_root"] != str(repo):
        raise CheckpointError("Plan checkpoint belongs to a different repository.")
    if not verify_plan_manifest(store, workflow_id, manifest)["valid"]:
        raise CheckpointError("Plan checkpoint failed integrity verification.")

    report = read_review_report(args.report, repo)
    if args.compose:
        report = compose_plan_review_report(store, workflow_id, manifest, report)
    validate_plan_review_report(store, workflow_id, manifest, report)
    output_path = plan_review_path(store, workflow_id, checkpoint_id)
    if store_path_exists(output_path, store):
        raise CheckpointError(f"Plan review record is immutable and already exists: {output_path}")
    report_payload = canonical_json(report)
    envelope = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "plan_review",
        "workflow_id": workflow_id,
        "checkpoint_id": checkpoint_id,
        "snapshot_sha256": manifest["snapshot_sha256"],
        "recorded_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "report_sha256": sha256_bytes(report_payload),
        "report": report,
    }
    if args.compose:
        ensure_review_record_size(envelope)
    write_immutable_json(output_path, envelope, trusted_root=store)
    envelope["record_path"] = str(output_path)
    return composed_review_receipt(envelope, "sections") if args.compose else envelope


def record_review(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    checkpoint_id = safe_id(args.checkpoint_id, "checkpoint ID")
    manifest = load_manifest(store, workflow_id, checkpoint_id)
    if manifest["repo_root"] != str(repo):
        raise CheckpointError("Checkpoint belongs to a different repository.")
    if not verify_manifest(store, workflow_id, manifest)["valid"]:
        raise CheckpointError("Checkpoint failed integrity verification.")

    report = read_review_report(args.report, repo)
    if args.compose:
        report = compose_review_report(store, workflow_id, args.gate, manifest, report)
    validate_review_report(store, workflow_id, args.gate, manifest, report)

    output_path = review_path(store, workflow_id, args.gate, checkpoint_id)
    if store_path_exists(output_path, store):
        raise CheckpointError(f"Review record is immutable and already exists: {output_path}")
    report_payload = canonical_json(report)
    envelope = {
        "schema_version": SCHEMA_VERSION,
        "workflow_id": workflow_id,
        "gate": args.gate,
        "checkpoint_id": checkpoint_id,
        "snapshot_sha256": manifest["snapshot_sha256"],
        "recorded_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "report_sha256": sha256_bytes(report_payload),
        "report": report,
    }
    if args.compose:
        ensure_review_record_size(envelope)
    write_immutable_json(output_path, envelope, trusted_root=store)
    envelope["record_path"] = str(output_path)
    return composed_review_receipt(envelope, "surfaces") if args.compose else envelope


def validate_closure_mechanical_report(
    report: dict[str, Any],
    repo: Path,
    manifest: dict[str, Any],
) -> None:
    require_exact_keys(report, {
        "report_schema_version", "checkpoint_id", "task_result_snapshot_sha256",
        "validation_mode", "verdict", "summary", "path_packages", "surfaces",
        "checks", "required_corrections",
    }, "Closure mechanical report")
    if (
        not isinstance(report["report_schema_version"], int)
        or isinstance(report["report_schema_version"], bool)
        or report["report_schema_version"] != 1
    ):
        raise CheckpointError("Closure mechanical report_schema_version must be integer 1.")
    if (
        report["checkpoint_id"] != manifest["checkpoint_id"]
        or report["task_result_snapshot_sha256"] != manifest["snapshot_sha256"]
    ):
        raise CheckpointError("Closure mechanical report does not bind its checkpoint snapshot.")
    if report["validation_mode"] != "complete_gate" or report["verdict"] != "passed":
        raise CheckpointError("Closure requires a passed complete_gate mechanical report.")
    validate_non_empty_string(report["summary"], "Mechanical summary")
    if validate_string_list(report["required_corrections"], "Mechanical required_corrections"):
        raise CheckpointError("Closure mechanical report must have no required corrections.")
    path_packages = report["path_packages"]
    if not isinstance(path_packages, dict) or set(path_packages) != set(manifest["files"]):
        raise CheckpointError("Closure path_packages must map every current manifest path exactly once.")
    for surface_id in path_packages.values():
        safe_id(validate_non_empty_string(surface_id, "Path package surface"), "surface ID")

    checks_value = report["checks"]
    if not isinstance(checks_value, list):
        raise CheckpointError("Closure mechanical checks must be an array.")
    check_ids: set[str] = set()
    for check in checks_value:
        if not isinstance(check, dict):
            raise CheckpointError("Closure mechanical check must be an object.")
        require_exact_keys(check, {
            "check_id", "command", "cwd", "disposition", "verdict", "exit_status",
            "evidence", "skip_reason", "source_identity",
        }, "Closure mechanical check")
        check_id = safe_id(validate_non_empty_string(check["check_id"], "Check ID"), "check ID")
        if check_id in check_ids:
            raise CheckpointError("Closure mechanical check IDs must be unique.")
        check_ids.add(check_id)
        validate_non_empty_string(check["command"], f"Check {check_id} command")
        normalized_check_cwd(repo, check["cwd"])
        validate_required_string_list(check["evidence"], f"Check {check_id} evidence")
        if (
            check["disposition"] not in ("executed", "reused")
            or check["verdict"] != "passed"
            or not isinstance(check["exit_status"], int)
            or isinstance(check["exit_status"], bool)
            or check["exit_status"] != 0
            or check["skip_reason"] is not None
        ):
            raise CheckpointError(f"Closure check {check_id} must be executed or reused GREEN evidence, without skips.")
        source = check["source_identity"]
        if check["disposition"] == "executed":
            if source is not None:
                raise CheckpointError(f"Executed check {check_id} must have null source_identity.")
        else:
            if not isinstance(source, dict):
                raise CheckpointError(f"Reused check {check_id} requires source_identity.")
            require_exact_keys(source, {
                "report_reference", "check_id", "task_result_snapshot_sha256", "invocation_context",
            }, f"Reused check {check_id} source_identity")
            validate_non_empty_string(source["report_reference"], "Reused report reference")
            safe_id(validate_non_empty_string(source["check_id"], "Reused check ID"), "check ID")
            validate_non_empty_string(source["invocation_context"], "Reused invocation context")
            if source["task_result_snapshot_sha256"] != manifest["snapshot_sha256"]:
                raise CheckpointError(f"Reused check {check_id} belongs to a different task result.")

    surfaces_value = report["surfaces"]
    if not isinstance(surfaces_value, list) or not surfaces_value:
        raise CheckpointError("Closure mechanical surfaces must be a non-empty array.")
    surface_ids: set[str] = set()
    package_ids: set[str] = set()
    referenced_checks: set[str] = set()
    for surface in surfaces_value:
        if not isinstance(surface, dict):
            raise CheckpointError("Closure mechanical surface must be an object.")
        require_exact_keys(surface, {
            "surface_id", "kind", "check_ids", "no_applicable_checks_reason",
        }, "Closure mechanical surface")
        surface_id = safe_id(validate_non_empty_string(surface["surface_id"], "Surface ID"), "surface ID")
        if surface_id in surface_ids:
            raise CheckpointError("Closure mechanical surface IDs must be unique.")
        surface_ids.add(surface_id)
        if surface["kind"] not in ("package", "consumer", "mandatory", "material_risk"):
            raise CheckpointError(f"Closure surface {surface_id} kind is invalid.")
        if surface["kind"] == "package":
            package_ids.add(surface_id)
        references = set(validate_string_list(surface["check_ids"], f"Surface {surface_id} check_ids"))
        if not references <= check_ids:
            raise CheckpointError(f"Closure surface {surface_id} references unknown checks.")
        referenced_checks.update(references)
        reason = surface["no_applicable_checks_reason"]
        if references:
            if reason is not None:
                raise CheckpointError(f"Closure surface {surface_id} with checks requires a null no-applicable reason.")
        else:
            validate_non_empty_string(reason, f"Surface {surface_id} no_applicable_checks_reason")
            if surface["kind"] in {"mandatory", "material_risk"}:
                raise CheckpointError(f"Closure {surface['kind']} surface {surface_id} requires checks.")
    if not set(path_packages.values()) <= package_ids:
        raise CheckpointError("Every closure path must map to a declared package surface.")
    if referenced_checks != check_ids:
        raise CheckpointError("Every closure mechanical check must belong to a declared surface.")
    if not check_ids and package_ids != set(path_packages.values()):
        raise CheckpointError("A closure without checks requires concrete path-mapped package surfaces.")


def verify_closure(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    store = resolve_store(args.store, repo)
    workflow_id = safe_id(args.workflow_id, "workflow ID")
    expert_id = safe_id(args.expert_checkpoint_id, "expert checkpoint ID")
    expert_manifest = load_manifest(store, workflow_id, expert_id)
    if expert_manifest["repo_root"] != str(repo) or manifest_content_errors(store, workflow_id, expert_manifest):
        raise CheckpointError("Closure expert checkpoint is unavailable or invalid.")
    expert, state = read_verified_review(
        review_path(store, workflow_id, "expert", expert_id), store, workflow_id, "expert", expert_manifest
    )
    if state != "strict-approved":
        raise CheckpointError("Closure requires a stored strict-approved expert review.")
    mechanical = read_review_report(args.mechanical_report, repo)
    mechanical_id = safe_id(
        validate_non_empty_string(mechanical.get("checkpoint_id"), "Mechanical checkpoint ID"), "checkpoint ID"
    )
    mechanical_manifest = load_manifest(store, workflow_id, mechanical_id)
    if (
        mechanical_manifest["repo_root"] != str(repo)
        or manifest_content_errors(store, workflow_id, mechanical_manifest)
    ):
        raise CheckpointError("Closure mechanical checkpoint is unavailable or invalid.")
    validate_closure_mechanical_report(mechanical, repo, mechanical_manifest)
    if mechanical_manifest["snapshot_sha256"] != expert_manifest["snapshot_sha256"]:
        raise CheckpointError("Closure expert and mechanical evidence must bind the same canonical task result.")
    if not checkpoint_matches_current_worktree(store, workflow_id, repo, expert_manifest):
        raise CheckpointError("Closure refused because the expert-approved result has current worktree drift.")

    mechanical_digest = sha256_bytes(canonical_json(mechanical))
    identity = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "final_closure",
        "workflow_id": workflow_id,
        "repo_root": str(repo),
        "expert_checkpoint_id": expert_id,
        "mechanical_checkpoint_id": mechanical_id,
        "task_result_snapshot_sha256": expert_manifest["snapshot_sha256"],
        "expert_report_sha256": expert["report_sha256"],
        "mechanical_report_sha256": mechanical_digest,
        "mechanical_report": mechanical,
        "current_matches": True,
    }
    path = workflow_dir(store, workflow_id) / "closures" / f"{expert_id}-{mechanical_digest}.json"
    if store_path_exists(path, store):
        envelope = json.loads(read_regular_bytes(
            path, "Final closure record", MAX_REVIEW_REPORT_BYTES, trusted_root=store
        ).decode("utf-8"))
        if not isinstance(envelope, dict):
            raise CheckpointError("Final closure record is malformed.")
        require_exact_keys(envelope, set(identity) | {"verified_at", "closure_sha256"}, "Final closure record")
        if any(canonical_json(envelope[field]) != canonical_json(value) for field, value in identity.items()):
            raise CheckpointError("Final closure record no longer matches its verified evidence.")
        validate_non_empty_string(envelope["verified_at"], "Closure verified_at")
        datetime.fromisoformat(envelope["verified_at"].replace("Z", "+00:00"))
        expected_digest = sha256_bytes(canonical_json({
            key: value for key, value in envelope.items() if key != "closure_sha256"
        }))
        if envelope["closure_sha256"] != expected_digest:
            raise CheckpointError("Final closure record fingerprint is invalid.")
    else:
        envelope = {
            **identity,
            "verified_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }
        envelope["closure_sha256"] = sha256_bytes(canonical_json(envelope))
        ensure_review_record_size(envelope)
        write_immutable_json(path, envelope, trusted_root=store)
    return {
        **{field: envelope[field] for field in (
            "workflow_id", "expert_checkpoint_id", "mechanical_checkpoint_id",
            "task_result_snapshot_sha256", "expert_report_sha256", "mechanical_report_sha256",
            "closure_sha256", "current_matches", "verified_at",
        )},
        "closure_verified": True,
        "record_path": str(path),
    }


def write_output(payload: dict[str, Any], output_value: str | None, repo: Path) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if not output_value or output_value == "-":
        sys.stdout.write(serialized)
        return
    output = lexical_absolute_path(output_value)
    repository_local = path_is_within(output, repo)
    if repository_local:
        reject_symlink_components(output, repo)
        ensure_private_directory_components(
            output.parent,
            repo,
            chmod_existing_final=False,
        )
    else:
        output.parent.mkdir(parents=True, exist_ok=True)

    try:
        metadata = output.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is not None and (
        stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode)
    ):
        raise CheckpointError(f"Output must be a regular non-symlink file: {output}")

    parent_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    parent_descriptor = os.open(output.parent, parent_flags)
    staging_name: str | None = None
    staging_descriptor: int | None = None
    source_name = "payload.json"
    try:
        for _attempt in range(128):
            candidate = f".hdt-output-{secrets.token_hex(16)}"
            try:
                os.mkdir(candidate, mode=0o700, dir_fd=parent_descriptor)
            except FileExistsError:
                continue
            staging_name = candidate
            break
        if staging_name is None:
            raise CheckpointError(f"Cannot allocate a private output staging directory: {output}")

        staging_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is not None:
            staging_flags |= nofollow
        staging_descriptor = os.open(
            staging_name,
            staging_flags,
            dir_fd=parent_descriptor,
        )
        os.fchmod(staging_descriptor, 0o700)
        staging_metadata = os.fstat(staging_descriptor)
        if (
            not stat.S_ISDIR(staging_metadata.st_mode)
            or stat.S_IMODE(staging_metadata.st_mode) != 0o700
        ):
            raise CheckpointError(f"Output staging path is not a private directory: {output}")

        source_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if nofollow is not None:
            source_flags |= nofollow
        source_descriptor = os.open(
            source_name,
            source_flags,
            0o600,
            dir_fd=staging_descriptor,
        )
        with os.fdopen(source_descriptor, mode="w", encoding="utf-8") as temporary:
            os.fchmod(temporary.fileno(), 0o600)
            temporary.write(serialized)
            temporary.flush()
            os.fsync(temporary.fileno())
            opened_source = os.fstat(temporary.fileno())
            named_source = os.stat(
                source_name,
                dir_fd=staging_descriptor,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISREG(opened_source.st_mode)
                or regular_file_identity(opened_source) != regular_file_identity(named_source)
                or stat.S_IMODE(opened_source.st_mode) != 0o600
            ):
                raise CheckpointError(f"Output staging file changed identity: {output}")

            try:
                current = os.stat(
                    output.name,
                    dir_fd=parent_descriptor,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                current = None
            if current is not None and (
                stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode)
            ):
                raise CheckpointError(f"Output must be a regular non-symlink file: {output}")
            os.replace(
                source_name,
                output.name,
                src_dir_fd=staging_descriptor,
                dst_dir_fd=parent_descriptor,
            )
    finally:
        if staging_descriptor is not None:
            try:
                os.unlink(source_name, dir_fd=staging_descriptor)
            except FileNotFoundError:
                pass
            finally:
                os.close(staging_descriptor)
        if staging_name is not None:
            try:
                os.rmdir(staging_name, dir_fd=parent_descriptor)
            except FileNotFoundError:
                pass
        os.close(parent_descriptor)


def add_store_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--store",
        help=(
            "Checkpoint store. Defaults to <repo>/.tmp/hdt-review-checkpoints "
            "after verifying .tmp is ignored."
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="Create one immutable checkpoint.")
    add_store_argument(create)
    create.add_argument("--workflow-id", required=True)
    create.add_argument("--checkpoint-id", required=True)
    create.add_argument("--repo", required=True)
    create.add_argument("--base")
    create.add_argument("--plan", required=True)
    create.add_argument("--all-changes", action="store_true")
    create.add_argument("--isolated-worktree", action="store_true")
    create.add_argument("--path", action="append")
    create.add_argument("--paths-from")
    create.add_argument("--previous")
    create.add_argument("--output", default="-")

    create_plan = subparsers.add_parser(
        "create-plan",
        help="Create one immutable section-aware plan checkpoint.",
    )
    add_store_argument(create_plan)
    create_plan.add_argument("--workflow-id", required=True)
    create_plan.add_argument("--checkpoint-id", required=True)
    create_plan.add_argument("--repo", required=True)
    create_plan.add_argument("--plan", required=True)
    create_plan.add_argument("--previous")
    create_plan.add_argument("--output", default="-")

    plan_projection = subparsers.add_parser(
        "plan-projection",
        help="Extract exact work-package content from an approved plan checkpoint.",
    )
    add_store_argument(plan_projection)
    plan_projection.add_argument("--workflow-id", required=True)
    plan_projection.add_argument("--checkpoint-id", required=True)
    plan_projection.add_argument("--repo", required=True)
    plan_projection.add_argument(
        "--section",
        action="append",
        required=True,
        help="Approved work-package or applicable constraint section; repeatable.",
    )
    plan_projection.add_argument("--output", default="-")

    diff_parser = subparsers.add_parser("diff", help="Compare two immutable checkpoints.")
    add_store_argument(diff_parser)
    diff_parser.add_argument("--workflow-id", required=True)
    diff_parser.add_argument("--repo", required=True)
    diff_parser.add_argument("--from-checkpoint", required=True)
    diff_parser.add_argument("--to-checkpoint", required=True)
    diff_parser.add_argument("--include-patches", action="store_true")
    diff_parser.add_argument("--output", default="-")

    review_scope = subparsers.add_parser(
        "review-scope",
        help="List the helper-computed pending scope for an implementation review.",
    )
    add_store_argument(review_scope)
    review_scope.add_argument("--workflow-id", required=True)
    review_scope.add_argument("--repo", required=True)
    review_scope.add_argument("--checkpoint-id", required=True)
    review_scope.add_argument("--gate", choices=("planner",), required=True)
    review_scope.add_argument(
        "--surface",
        action="append",
        help="Return the exact prior coverage and changed paths for one surface; repeatable.",
    )
    review_scope.add_argument("--include-patches", action="store_true")
    review_scope.add_argument("--output", default="-")

    diff_plan = subparsers.add_parser(
        "diff-plan",
        help="Compare two immutable section-aware plan checkpoints.",
    )
    add_store_argument(diff_plan)
    diff_plan.add_argument("--workflow-id", required=True)
    diff_plan.add_argument("--repo", required=True)
    diff_plan.add_argument("--from-checkpoint", required=True)
    diff_plan.add_argument("--to-checkpoint", required=True)
    diff_plan.add_argument("--include-patches", action="store_true")
    diff_plan.add_argument(
        "--section",
        action="append",
        help="Return exact immutable text and scope state for one section; repeatable.",
    )
    diff_plan.add_argument("--output", default="-")

    verify = subparsers.add_parser("verify", help="Verify manifest and blob integrity.")
    add_store_argument(verify)
    verify.add_argument("--workflow-id", required=True)
    verify.add_argument("--repo", required=True)
    verify.add_argument("--checkpoint-id", required=True)
    verify.add_argument(
        "--require-review",
        action="append",
        choices=("planner", "expert"),
        default=[],
        help="Require a current strict approved review for the selected gate; repeatable.",
    )
    verify.add_argument("--output", default="-")

    verify_plan = subparsers.add_parser(
        "verify-plan",
        help="Verify a plan checkpoint, section manifest, and review record.",
    )
    add_store_argument(verify_plan)
    verify_plan.add_argument("--workflow-id", required=True)
    verify_plan.add_argument("--repo", required=True)
    verify_plan.add_argument("--checkpoint-id", required=True)
    verify_plan.add_argument(
        "--require-review",
        action="store_true",
        help="Require the current strict plan-review record to be approved.",
    )
    verify_plan.add_argument("--output", default="-")

    matches = subparsers.add_parser(
        "matches",
        help="Check whether the current frozen worktree still matches a checkpoint.",
    )
    add_store_argument(matches)
    matches.add_argument("--workflow-id", required=True)
    matches.add_argument("--checkpoint-id", required=True)
    matches.add_argument("--repo", required=True)
    matches.add_argument("--include-patches", action="store_true")
    matches.add_argument("--output", default="-")

    matches_plan = subparsers.add_parser(
        "matches-plan",
        help="Check whether the current plan still matches a plan checkpoint.",
    )
    add_store_argument(matches_plan)
    matches_plan.add_argument("--workflow-id", required=True)
    matches_plan.add_argument("--checkpoint-id", required=True)
    matches_plan.add_argument("--repo", required=True)
    matches_plan.add_argument("--include-patches", action="store_true")
    matches_plan.add_argument("--output", default="-")

    record = subparsers.add_parser(
        "record-review",
        help="Persist one immutable checkpoint-bound semantic review report.",
    )
    add_store_argument(record)
    record.add_argument("--workflow-id", required=True)
    record.add_argument("--checkpoint-id", required=True)
    record.add_argument("--repo", required=True)
    record.add_argument("--gate", choices=("planner", "expert"), required=True)
    record.add_argument(
        "--report",
        default="-",
        help="JSON report path, or '-' for standard input.",
    )
    record.add_argument("--output", default="-")
    record.add_argument("--compose", action="store_true", help="Compose immutable identity and closed coverage from a semantic review draft.")

    record_plan = subparsers.add_parser(
        "record-plan-review",
        help="Persist one immutable section-complete plan review report.",
    )
    add_store_argument(record_plan)
    record_plan.add_argument("--workflow-id", required=True)
    record_plan.add_argument("--checkpoint-id", required=True)
    record_plan.add_argument("--repo", required=True)
    record_plan.add_argument(
        "--report",
        default="-",
        help="JSON report path, or '-' for standard input.",
    )
    record_plan.add_argument("--output", default="-")
    record_plan.add_argument("--compose", action="store_true", help="Compose plan identity and closed sections from a semantic review draft.")

    closure = subparsers.add_parser("verify-closure", help="Verify and persist final closure evidence without rerunning checks.")
    add_store_argument(closure)
    closure.add_argument("--workflow-id", required=True)
    closure.add_argument("--repo", required=True)
    closure.add_argument("--expert-checkpoint-id", required=True)
    closure.add_argument("--mechanical-report", required=True)
    closure.add_argument("--output", default="-")

    record_mechanical = subparsers.add_parser(
        "record-mechanical-evidence",
        help="Persist one immutable batch of command evidence.",
    )
    add_store_argument(record_mechanical)
    record_mechanical.add_argument("--workflow-id", required=True)
    record_mechanical.add_argument("--evidence-id", required=True)
    record_mechanical.add_argument("--checkpoint-id", required=True)
    record_mechanical.add_argument("--repo", required=True)
    record_mechanical.add_argument(
        "--report",
        default="-",
        help="Mechanical evidence JSON path, or '-' for standard input.",
    )
    record_mechanical.add_argument("--output", default="-")

    resolve_mechanical = subparsers.add_parser(
        "resolve-mechanical-evidence",
        help="Resolve an exact batch of reusable command evidence for one checkpoint.",
    )
    add_store_argument(resolve_mechanical)
    resolve_mechanical.add_argument("--workflow-id", required=True)
    resolve_mechanical.add_argument("--checkpoint-id", required=True)
    resolve_mechanical.add_argument("--repo", required=True)
    resolve_mechanical.add_argument(
        "--evidence-id",
        action="append",
        required=True,
        help="Candidate immutable evidence ID; repeatable.",
    )
    resolve_mechanical.add_argument(
        "--requirements",
        default="-",
        help="Required check descriptor JSON path, or '-' for standard input.",
    )
    resolve_mechanical.add_argument("--output", default="-")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        workflow_id = safe_id(args.workflow_id, "workflow ID")
        output_repo = resolve_repo(args.repo)
        if args.command == "create":
            payload = create_manifest(args)
        elif args.command == "create-plan":
            payload = create_plan_manifest(args)
        elif args.command == "plan-projection":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            manifest = load_plan_manifest(store, workflow_id, args.checkpoint_id)
            if manifest["repo_root"] != str(repo):
                raise CheckpointError("Plan checkpoint belongs to a different repository.")
            verification = verify_plan_manifest(store, workflow_id, manifest)
            if not verification["valid"]:
                raise CheckpointError("Approved plan checkpoint failed integrity verification.")
            if verification["review_state"] != "strict-approved":
                raise CheckpointError("Plan projection requires a strict approved review record.")
            payload = create_plan_projection(
                store,
                workflow_id,
                manifest,
                args.section,
            )
        elif args.command == "diff":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            old = load_manifest(store, workflow_id, args.from_checkpoint)
            new = load_manifest(store, workflow_id, args.to_checkpoint)
            if old["repo_root"] != str(repo) or new["repo_root"] != str(repo):
                raise CheckpointError("Checkpoint belongs to a different repository.")
            for manifest in (old, new):
                if manifest_content_errors(store, workflow_id, manifest):
                    raise CheckpointError(
                        f"Checkpoint failed integrity verification: {manifest['checkpoint_id']}"
                    )
            payload = diff_manifests(store, workflow_id, old, new, args.include_patches)
        elif args.command == "review-scope":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            manifest = load_manifest(store, workflow_id, args.checkpoint_id)
            if manifest["repo_root"] != str(repo):
                raise CheckpointError("Checkpoint belongs to a different repository.")
            if manifest_content_errors(store, workflow_id, manifest):
                raise CheckpointError("Checkpoint failed integrity verification.")
            payload = implementation_review_scope(
                store,
                workflow_id,
                args.gate,
                manifest,
                include_patches=args.include_patches,
                selected_surface_ids=args.surface,
            )
        elif args.command == "diff-plan":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            old = load_plan_manifest(store, workflow_id, args.from_checkpoint)
            new = load_plan_manifest(store, workflow_id, args.to_checkpoint)
            if old["repo_root"] != str(repo) or new["repo_root"] != str(repo):
                raise CheckpointError("Plan checkpoint belongs to a different repository.")
            for manifest in (old, new):
                if plan_manifest_content_errors(store, workflow_id, manifest):
                    raise CheckpointError(
                        f"Plan checkpoint failed integrity verification: {manifest['checkpoint_id']}"
                    )
            prior_coverage = None
            old_review_path = plan_review_path(store, workflow_id, old["checkpoint_id"])
            if store_path_exists(old_review_path, store):
                try:
                    envelope = read_plan_review_envelope(
                        old_review_path,
                        store,
                        workflow_id,
                        old,
                    )
                    validate_plan_review_report(store, workflow_id, old, envelope["report"])
                    prior_coverage = envelope["report"].get("coverage_ledger")
                except (CheckpointError, OSError, ValueError, json.JSONDecodeError):
                    prior_coverage = None
            payload = diff_plan_manifests(
                store,
                workflow_id,
                old,
                new,
                args.include_patches,
                prior_coverage,
            )
            if args.section:
                payload = select_plan_review_sections(
                    store,
                    workflow_id,
                    old,
                    new,
                    payload,
                    args.section,
                )
        elif args.command == "verify":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            manifest = load_manifest(store, workflow_id, args.checkpoint_id)
            if manifest["repo_root"] != str(repo):
                raise CheckpointError("Checkpoint belongs to a different repository.")
            payload = verify_manifest(store, workflow_id, manifest)
            if not payload["valid"]:
                write_output(payload, args.output, output_repo)
                return 1
            required_states = {
                gate: payload["review_states"][gate] for gate in args.require_review
            }
            payload["required_reviews"] = required_states
            payload["required_reviews_satisfied"] = all(
                state == "strict-approved" for state in required_states.values()
            )
            if not payload["required_reviews_satisfied"]:
                write_output(payload, args.output, output_repo)
                return 1
        elif args.command == "verify-plan":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            manifest = load_plan_manifest(store, workflow_id, args.checkpoint_id)
            if manifest["repo_root"] != str(repo):
                raise CheckpointError("Plan checkpoint belongs to a different repository.")
            payload = verify_plan_manifest(store, workflow_id, manifest)
            if not payload["valid"]:
                write_output(payload, args.output, output_repo)
                return 1
            payload["required_review_satisfied"] = (
                not args.require_review or payload["review_state"] == "strict-approved"
            )
            if not payload["required_review_satisfied"]:
                write_output(payload, args.output, output_repo)
                return 1
        elif args.command == "matches":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            stored = load_manifest(store, workflow_id, args.checkpoint_id)
            if stored["repo_root"] != str(repo):
                raise CheckpointError("Checkpoint belongs to a different repository.")
            if manifest_content_errors(store, workflow_id, stored):
                raise CheckpointError("Checkpoint failed integrity verification.")
            current = working_manifest_for_match(
                stored, repo, store, workflow_id, persist_blobs=args.include_patches
            )
            current["checkpoint_id"] = "working-tree"
            current["plan"].setdefault("path", stored["plan"]["path"])
            delta = diff_manifests(store, workflow_id, stored, current, args.include_patches)
            payload = {
                "workflow_id": workflow_id,
                "checkpoint_id": args.checkpoint_id,
                "matches": (
                    not delta["base_commit_changed"]
                    and not delta["head_commit_changed"]
                    and not delta["worktree_guard_changed"]
                    and not delta["plan_changed"]
                    and not delta["changes"]
                ),
                "delta": delta,
            }
            if not payload["matches"]:
                write_output(payload, args.output, output_repo)
                return 1
        elif args.command == "matches-plan":
            repo = resolve_repo(args.repo)
            store = resolve_store(args.store, repo)
            stored = load_plan_manifest(store, workflow_id, args.checkpoint_id)
            if stored["repo_root"] != str(repo):
                raise CheckpointError("Plan checkpoint belongs to a different repository.")
            if plan_manifest_content_errors(store, workflow_id, stored):
                raise CheckpointError("Plan checkpoint failed integrity verification.")
            current = working_plan_manifest_for_match(
                stored,
                repo,
                store,
                workflow_id,
                persist_blobs=args.include_patches,
            )
            if current is None:
                payload = {
                    "workflow_id": workflow_id,
                    "checkpoint_id": args.checkpoint_id,
                    "matches": False,
                    "reason": "plan_missing",
                }
            else:
                prior_coverage = None
                stored_review_path = plan_review_path(
                    store,
                    workflow_id,
                    stored["checkpoint_id"],
                )
                if store_path_exists(stored_review_path, store):
                    try:
                        envelope = read_plan_review_envelope(
                            stored_review_path,
                            store,
                            workflow_id,
                            stored,
                        )
                        validate_plan_review_report(
                            store,
                            workflow_id,
                            stored,
                            envelope["report"],
                        )
                        prior_coverage = envelope["report"].get("coverage_ledger")
                    except (CheckpointError, OSError, ValueError, json.JSONDecodeError):
                        prior_coverage = None
                delta = diff_plan_manifests(
                    store,
                    workflow_id,
                    stored,
                    current,
                    args.include_patches,
                    prior_coverage,
                )
                payload = {
                    "workflow_id": workflow_id,
                    "checkpoint_id": args.checkpoint_id,
                    "matches": not delta["plan_path_changed"] and not delta["plan_changed"],
                    "delta": delta,
                }
            if not payload["matches"]:
                write_output(payload, args.output, output_repo)
                return 1
        elif args.command == "record-review":
            payload = record_review(args)
        elif args.command == "record-plan-review":
            payload = record_plan_review(args)
        elif args.command == "verify-closure":
            payload = verify_closure(args)
        elif args.command == "record-mechanical-evidence":
            payload = record_mechanical_evidence(args)
        elif args.command == "resolve-mechanical-evidence":
            payload = resolve_mechanical_evidence(args)
        else:
            parser.error(f"Unsupported command: {args.command}")
            return 2
        write_output(payload, args.output, output_repo)
        return 0
    except (CheckpointError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
