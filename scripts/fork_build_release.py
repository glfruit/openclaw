#!/usr/bin/env python3
"""Build and package a fork release tarball with stable metadata output.

Phase 1 scaffolding only:
- optional repo build step
- npm/pnpm pack into a destination directory
- compute sha256
- emit release metadata JSON and markdown body
- dry-run emits a stable plan without publishing

Examples:
  python3 scripts/fork_build_release.py --dry-run
  python3 scripts/fork_build_release.py --release-tag v2026.4.22-fork.1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


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
    guidance: str | None = None

    def to_json(self) -> str:
        return json.dumps(self.__dict__, indent=2, sort_keys=True)


HELP_EPILOG = """example:
  python3 scripts/fork_build_release.py --dry-run
  python3 scripts/fork_build_release.py --release-tag v2026.4.22-fork.1
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build and pack the fork source tree into a release tarball.",
        epilog=HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--repo", default=".", help="Repository path (default: current directory)")
    parser.add_argument("--output-dir", default="artifacts/fork-release", help="Directory for generated tarballs")
    parser.add_argument("--release-tag", help="Release tag to describe; defaults to v<package-version>")
    parser.add_argument("--build-script", default="build", help="Package script used for the build step")
    parser.add_argument("--skip-build", action="store_true", help="Skip the build step and only pack")
    parser.add_argument("--dry-run", action="store_true", help="Plan only; do not build or pack")
    return parser


def run(command: Sequence[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    if check and proc.returncode != 0:
        raise CommandError(command, proc.returncode, proc.stdout, proc.stderr)
    return proc


def package_json(repo: Path) -> dict:
    return json.loads((repo / "package.json").read_text())


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


def markdown_body(package_name: str | None, package_version: str | None, sha256: str | None, tarball_name: str | None) -> str:
    lines = [
        "## Fork release artifacts",
        "",
        f"- Package: `{package_name or 'unknown'}`",
        f"- Version: `{package_version or 'unknown'}`",
        f"- Tarball: `{tarball_name or 'not-built'}`",
        f"- SHA256: `{sha256 or 'not-built'}`",
        "",
        "Review the tarball locally, then publish the GitHub release manually if it looks correct.",
    ]
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
    pkg = package_json(repo)
    package_name = pkg.get("name")
    package_version = pkg.get("version")
    package_manager = detect_package_manager(pkg)
    output_dir = (repo / args.output_dir).resolve()
    release_tag = args.release_tag or (f"v{package_version}" if package_version else None)

    if shutil.which(package_manager) is None and not args.dry_run:
        raise RuntimeError(f"package manager not found on PATH: {package_manager}")

    build_command = [package_manager, args.build_script]
    pack_command = [package_manager, "pack", "--pack-destination", str(output_dir), "--json"]

    release_title = f"{package_name} {release_tag}" if package_name and release_tag else release_tag
    github_release_command = " ".join(
        [
            "gh",
            "release",
            "create",
            quote_arg(release_tag or "<release-tag>"),
            "--title",
            quote_arg(release_title or "<release-title>"),
            "--notes-file",
            quote_arg(str(output_dir / "release-notes.md")),
            quote_arg("<tarball-path>"),
        ]
    )

    if args.dry_run:
        body = markdown_body(package_name, package_version, None, None)
        return BuildResult(
            ok=True,
            dry_run=True,
            package_manager=package_manager,
            package_name=package_name,
            package_version=package_version,
            release_tag=release_tag,
            tarball_path=None,
            tarball_sha256=None,
            release_title=release_title,
            release_body_markdown=body,
            github_release_command=github_release_command,
            build_command=build_command,
            pack_command=pack_command,
            guidance="Dry run only: build and pack were skipped.",
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    if not args.skip_build:
        run(build_command, cwd=repo)

    pack_proc = run(pack_command, cwd=repo)
    tarball_path = resolve_tarball_path(extract_pack_filename(pack_proc.stdout), repo, output_dir)
    if not tarball_path.exists():
        raise RuntimeError(f"pack reported tarball that does not exist: {tarball_path}")

    sha256 = compute_sha256(tarball_path)
    body = markdown_body(package_name, package_version, sha256, tarball_path.name)
    notes_path = output_dir / "release-notes.md"
    notes_path.write_text(body + "\n")

    return BuildResult(
        ok=True,
        dry_run=False,
        package_manager=package_manager,
        package_name=package_name,
        package_version=package_version,
        release_tag=release_tag,
        tarball_path=str(tarball_path),
        tarball_sha256=sha256,
        release_title=release_title,
        release_body_markdown=body,
        github_release_command=github_release_command.replace("<tarball-path>", quote_arg(str(tarball_path))),
        build_command=build_command,
        pack_command=pack_command,
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
            guidance=str(exc),
        )
        print(failure.to_json())
        return 1

    print(result.to_json())
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
