#!/usr/bin/env python3
"""Build and package a fork release tarball with stable metadata output.

Version contract (single source of truth for fork releases):
  release_tag      = "v<version>"  (e.g. v2026.4.21)
  package.json     = "<version>"    (e.g. 2026.4.21)
  tarball filename = "<name>-<version>.tgz"  (e.g. openclaw-2026.4.21.tgz)
  GH asset name    = tarball filename

When --release-tag is given, the script validates that package.json version
matches the tag (after stripping "v").  When --version-override is given,
package.json is temporarily patched to that version before packing and restored
afterwards (pack-time override — the on-disk file is left unchanged).

Examples:
  python3 scripts/fork_build_release.py --dry-run
  python3 scripts/fork_build_release.py --release-tag v2026.4.21
  python3 scripts/fork_build_release.py --version-override 2026.4.21
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence


# ── Version contract ─────────────────────────────────────────────────────────

SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)


def is_valid_semver(value: str) -> bool:
    return bool(SEMVER_RE.match(value))


def strip_v_prefix(value: str) -> str:
    return value[1:] if value.startswith("v") else value


def normalize_release_tag(tag: str) -> str | None:
    version = strip_v_prefix(tag)
    return derive_tag_from_version(version) if is_valid_semver(version) else None


def derive_version_from_tag(tag: str) -> str | None:
    normalized_tag = normalize_release_tag(tag)
    if normalized_tag is None:
        return None
    version = strip_v_prefix(normalized_tag)
    return version if is_valid_semver(version) else None


def derive_tag_from_version(version: str) -> str:
    return f"v{version}"


def derive_tarball_name(name: str, version: str) -> str:
    return f"{name}-{version}.tgz"


def validate_version_contract(
    *,
    release_tag: str | None,
    package_version: str | None,
    version_override: str | None,
) -> list[str]:
    """Return a list of contract violation messages (empty = ok)."""
    errors: list[str] = []

    effective_tag = normalize_release_tag(release_tag) if release_tag else None
    effective_version = version_override or package_version

    # Reject explicit release tags that don't normalize (e.g. "not-a-tag")
    if release_tag and effective_tag is None:
        errors.append(f"release tag is not a valid semver tag: {release_tag}")

    if effective_tag and effective_version:
        tag_version = derive_version_from_tag(effective_tag)
        if tag_version is None:
            errors.append(f"release tag is not a valid semver tag: {release_tag}")
        elif tag_version != effective_version:
            errors.append(
                f"version contract mismatch: release tag v{tag_version} != "
                f"effective version {effective_version}"
            )

    if effective_version and not is_valid_semver(effective_version):
        errors.append(f"effective version is not valid semver: {effective_version}")

    if not effective_tag and effective_version:
        effective_tag = derive_tag_from_version(effective_version)
    if not effective_version and effective_tag:
        effective_version = derive_version_from_tag(effective_tag)

    if not effective_version:
        errors.append("cannot determine release version: supply --release-tag, --version-override, or update package.json")

    return errors


def resolve_contract(
    *,
    release_tag: str | None,
    package_version: str | None,
    version_override: str | None,
    package_name: str | None,
) -> tuple[str, str, str, str | None]:
    """Return (version, tag, tarball_name, error_or_None)."""
    errors = validate_version_contract(
        release_tag=release_tag,
        package_version=package_version,
        version_override=version_override,
    )
    if errors:
        return ("", "", "", "\n".join(errors))

    version = version_override or package_version or ""
    tag = normalize_release_tag(release_tag) if release_tag else derive_tag_from_version(version)
    tarball = derive_tarball_name(package_name or "openclaw", version) if package_name else ""
    return (version, tag, tarball, None)


# ── Command helpers ──────────────────────────────────────────────────────────


class CommandError(RuntimeError):
    def __init__(self, command: Sequence[str], returncode: int, stdout: str, stderr: str):
        self.command = list(command)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(stderr.strip() or stdout.strip() or f"command failed: {' '.join(command)}")


@dataclass
class BuildResult:
    ok: bool
    dry_run: bool
    package_manager: str | None
    package_name: str | None
    package_version: str | None
    release_tag: str | None
    tarball_path: str | None
    tarball_sha256: str | None
    release_title: str | None
    release_body_markdown: str
    github_release_command: str
    build_command: list[str]
    pack_command: list[str]
    version_contract: dict[str, str] = field(default_factory=dict)
    version_patched: bool = False
    guidance: str | None = None

    def to_json(self) -> str:
        return json.dumps(self.__dict__, indent=2, sort_keys=True)


HELP_EPILOG = """examples:
  python3 scripts/fork_build_release.py --dry-run
  python3 scripts/fork_build_release.py --release-tag v2026.4.21
  python3 scripts/fork_build_release.py --version-override 2026.4.21

version contract:
  release_tag  = "v<version>"           →  v2026.4.21
  package.json = "<version>"             →  2026.4.21
  tarball      = "<name>-<version>.tgz"  →  openclaw-2026.4.21.tgz
  GH asset     = tarball filename
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build and pack the fork source tree into a release tarball.",
        epilog=HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--repo", default=".", help="Repository path (default: current directory)")
    parser.add_argument("--output-dir", default="artifacts/fork-release", help="Directory for generated tarballs")
    parser.add_argument("--release-tag", help="Release tag (must match v<version>). Defaults to v<package-version>")
    parser.add_argument("--version-override", help="Temporarily patch package.json to this version before packing (restored after)")
    parser.add_argument("--build-script", default="build", help="Package script used for the build step")
    parser.add_argument("--skip-build", action="store_true", help="Skip the build step and only pack")
    parser.add_argument("--dry-run", action="store_true", help="Plan only; do not build or pack")
    return parser


def run(command: Sequence[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    if check and proc.returncode != 0:
        raise CommandError(command, proc.returncode, proc.stdout, proc.stderr)
    return proc


def read_package_json(repo: Path) -> dict:
    return json.loads((repo / "package.json").read_text())


def write_package_json(repo: Path, pkg: dict) -> None:
    (repo / "package.json").write_text(json.dumps(pkg, indent=2) + "\n")


def detect_package_manager(pkg: dict) -> str:
    raw = pkg.get("packageManager") or "pnpm"
    return str(raw).split("@", 1)[0]


def compute_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def quote_arg(arg: str) -> str:
    if not arg or any(ch.isspace() for ch in arg) or any(ch in arg for ch in '"\''):
        return json.dumps(arg)
    return arg


def build_github_release_command(
    release_tag: str,
    release_title: str | None,
    notes_path: Path,
    tarball_path: Path,
) -> str:
    return " ".join(
        [
            "gh",
            "release",
            "create",
            quote_arg(release_tag),
            "--title",
            quote_arg(release_title or "<release-title>"),
            "--notes-file",
            quote_arg(str(notes_path)),
            quote_arg(str(tarball_path)),
        ]
    )


def markdown_body(
    package_name: str | None,
    package_version: str | None,
    sha256: str | None,
    tarball_name: str | None,
    contract: dict[str, str] | None = None,
) -> str:
    lines = [
        "## Fork release artifacts",
        "",
        f"- Package: `{package_name or 'unknown'}`",
        f"- Version: `{package_version or 'unknown'}`",
        f"- Tarball: `{tarball_name or 'not-built'}`",
        f"- SHA256: `{sha256 or 'not-built'}`",
    ]
    if contract:
        lines.append("")
        lines.append("### Version contract")
        for key, value in contract.items():
            lines.append(f"- `{key}`: `{value}`")
    lines.extend(["", "Review the tarball locally, then publish the GitHub release manually if it looks correct."])
    return "\n".join(lines)


def extract_pack_filename(stdout: str) -> str:
    pack_json: Any = json.loads(stdout)
    if isinstance(pack_json, dict):
        entries = [pack_json]
    elif isinstance(pack_json, list):
        entries = [entry for entry in pack_json if isinstance(entry, dict)]
    else:
        raise RuntimeError("pack command did not return JSON object/array output")

    if not entries:
        raise RuntimeError("pack command JSON output was empty")

    tarball_name = entries[0].get("filename")
    if not tarball_name:
        raise RuntimeError("pack command JSON did not include filename")
    return str(tarball_name)


def resolve_tarball_path(filename: str, repo: Path, output_dir: Path) -> Path:
    raw_path = Path(filename)
    if raw_path.is_absolute():
        return raw_path.resolve()

    repo_relative = (repo / raw_path).resolve()
    output_relative = (output_dir / raw_path).resolve()

    if repo_relative.exists():
        return repo_relative
    if output_relative.exists():
        return output_relative
    if raw_path.parent == Path('.'):
        return output_relative
    return repo_relative


def build_release(args: argparse.Namespace) -> BuildResult:
    repo = Path(args.repo).resolve()
    pkg = read_package_json(repo)
    package_name = pkg.get("name")
    package_version = pkg.get("version")
    package_manager = detect_package_manager(pkg)
    output_dir = (repo / args.output_dir).resolve()

    # ── Resolve version contract ──────────────────────────────────────────
    version_override = args.version_override
    release_tag = args.release_tag

    # If no explicit tag, derive from override > package.json
    if not release_tag:
        if version_override:
            release_tag = derive_tag_from_version(version_override)
        elif package_version and is_valid_semver(str(package_version)):
            release_tag = derive_tag_from_version(str(package_version))

    contract_version, contract_tag, contract_tarball, contract_error = resolve_contract(
        release_tag=release_tag,
        package_version=package_version,
        version_override=version_override,
        package_name=package_name,
    )

    if contract_error:
        return BuildResult(
            ok=False,
            dry_run=args.dry_run,
            package_manager=package_manager,
            package_name=package_name,
            package_version=package_version,
            release_tag=release_tag,
            tarball_path=None,
            tarball_sha256=None,
            release_title=None,
            release_body_markdown="",
            github_release_command="",
            build_command=[],
            pack_command=[],
            version_contract={
                "error": contract_error,
            },
            guidance=contract_error,
        )

    version_contract = {
        "release_tag": contract_tag,
        "package_version": contract_version,
        "tarball_filename": contract_tarball,
        "github_asset_name": contract_tarball,
    }
    if version_override and version_override != str(package_version):
        version_contract["version_override"] = version_override
        version_contract["original_package_version"] = str(package_version or "")

    # ── Build commands ────────────────────────────────────────────────────
    if shutil.which(package_manager) is None and not args.dry_run:
        raise RuntimeError(f"package manager not found on PATH: {package_manager}")

    build_command = [package_manager, args.build_script]
    pack_command = [package_manager, "pack", "--pack-destination", str(output_dir), "--json"]

    release_title = f"{package_name} {contract_tag}" if package_name and contract_tag else contract_tag
    notes_path = output_dir / "release-notes.md"
    expected_tarball_path = output_dir / contract_tarball
    github_release_command = build_github_release_command(
        contract_tag,
        release_title,
        notes_path,
        expected_tarball_path,
    )

    if args.dry_run:
        body = markdown_body(package_name, contract_version, None, contract_tarball, version_contract)
        return BuildResult(
            ok=True,
            dry_run=True,
            package_manager=package_manager,
            package_name=package_name,
            package_version=contract_version,
            release_tag=contract_tag,
            tarball_path=None,
            tarball_sha256=None,
            release_title=release_title,
            release_body_markdown=body,
            github_release_command=github_release_command,
            build_command=build_command,
            pack_command=pack_command,
            version_contract=version_contract,
            guidance="Dry run only: build and pack were skipped.",
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Pack-time version override ────────────────────────────────────────
    needs_patch = version_override and version_override != str(package_version)
    original_pkg_text: str | None = None

    if needs_patch:
        original_pkg_text = (repo / "package.json").read_text()
        pkg["version"] = version_override
        write_package_json(repo, pkg)

    try:
        if not args.skip_build:
            run(build_command, cwd=repo)

        pack_proc = run(pack_command, cwd=repo)
        actual_filename = extract_pack_filename(pack_proc.stdout)
        actual_tarball_name = Path(actual_filename).name

        # Verify the actual tarball name matches the contract. Some package
        # managers report an absolute path while others report only the
        # basename; both are valid if they identify the contract tarball.
        if actual_tarball_name != contract_tarball:
            raise RuntimeError(
                f"tarball filename contract violation: "
                f"pack produced `{actual_filename}` but contract expects `{contract_tarball}`"
            )

        tarball_path = resolve_tarball_path(actual_filename, repo, output_dir)
        if not tarball_path.exists():
            raise RuntimeError(f"pack reported tarball that does not exist: {tarball_path}")

        sha256 = compute_sha256(tarball_path)
        body = markdown_body(package_name, contract_version, sha256, contract_tarball, version_contract)
        notes_path.write_text(body + "\n")
        github_release_command = build_github_release_command(
            contract_tag,
            release_title,
            notes_path,
            tarball_path,
        )
    finally:
        if needs_patch and original_pkg_text is not None:
            (repo / "package.json").write_text(original_pkg_text)

    return BuildResult(
        ok=True,
        dry_run=False,
        package_manager=package_manager,
        package_name=package_name,
        package_version=contract_version,
        release_tag=contract_tag,
        tarball_path=str(tarball_path),
        tarball_sha256=sha256,
        release_title=release_title,
        release_body_markdown=body,
        github_release_command=github_release_command,
        build_command=build_command,
        pack_command=pack_command,
        version_contract=version_contract,
        version_patched=needs_patch,
        guidance="Tarball built locally. Review the artifact and publish manually if desired.",
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = build_release(args)
    except CommandError as exc:
        failure = BuildResult(
            ok=False,
            dry_run=args.dry_run,
            package_manager=None,
            package_name=None,
            package_version=None,
            release_tag=args.release_tag,
            tarball_path=None,
            tarball_sha256=None,
            release_title=None,
            release_body_markdown="",
            github_release_command="",
            build_command=[],
            pack_command=[],
            version_contract={},
            guidance=exc.stderr.strip() or exc.stdout.strip() or str(exc),
        )
        print(failure.to_json())
        return 1
    except Exception as exc:  # pragma: no cover - defensive CLI guard
        failure = BuildResult(
            ok=False,
            dry_run=args.dry_run,
            package_manager=None,
            package_name=None,
            package_version=None,
            release_tag=args.release_tag,
            tarball_path=None,
            tarball_sha256=None,
            release_title=None,
            release_body_markdown="",
            github_release_command="",
            build_command=[],
            pack_command=[],
            version_contract={},
            guidance=str(exc),
        )
        print(failure.to_json())
        return 1

    print(result.to_json())
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
