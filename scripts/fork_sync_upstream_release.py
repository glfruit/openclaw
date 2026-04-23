#!/usr/bin/env python3
"""Sync an upstream release tag into a local fork work branch.

Phase 1 scaffolding only:
- fetch upstream tags
- select or accept a target tag
- compare against fork main
- create/update a local work branch from fork main
- merge the selected upstream tag into that branch
- emit stable JSON for automation

Examples:
  python3 scripts/fork_sync_upstream_release.py --dry-run
  python3 scripts/fork_sync_upstream_release.py --target-tag v2026.4.22
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


class GitCommandError(RuntimeError):
    def __init__(self, command: Sequence[str], returncode: int, stdout: str, stderr: str):
        self.command = list(command)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(stderr.strip() or stdout.strip() or f"command failed: {' '.join(command)}")


@dataclass
class SyncResult:
    ok: bool
    upstream_tag: str | None
    fork_branch: str
    work_branch: str | None
    merge_status: str
    upstream_commit: str | None
    fork_head_before: str | None
    fork_head_after: str | None
    dry_run: bool
    guidance: str | None = None
    conflict_files: list[str] | None = None
    planned_actions: list[str] | None = None

    def to_json(self) -> str:
        return json.dumps(self.__dict__, indent=2, sort_keys=True)


class GitRepo:
    def __init__(self, repo: Path):
        self.repo = repo

    def run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        command = ["git", *args]
        proc = subprocess.run(
            command,
            cwd=self.repo,
            text=True,
            capture_output=True,
            check=False,
        )
        if check and proc.returncode != 0:
            raise GitCommandError(command, proc.returncode, proc.stdout, proc.stderr)
        return proc

    def output(self, *args: str) -> str:
        return self.run(*args).stdout.strip()


HELP_EPILOG = """example:
  python3 scripts/fork_sync_upstream_release.py --dry-run
  python3 scripts/fork_sync_upstream_release.py --target-tag v2026.4.22
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create/update a local release-sync branch by merging an upstream release tag.",
        epilog=HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--repo", default=".", help="Git repository to operate in (default: current directory)")
    parser.add_argument("--upstream-remote", default="upstream", help="Upstream git remote name")
    parser.add_argument("--fork-branch", default="main", help="Fork base branch to compare and branch from")
    parser.add_argument("--target-tag", help="Exact upstream tag to sync")
    parser.add_argument(
        "--work-branch-prefix",
        default="release-sync/",
        help="Prefix used for the local work branch (default: release-sync/)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Plan only; do not change branches or merge")
    return parser


def ensure_git_repo(repo: Path) -> None:
    if not (repo / ".git").exists():
        raise SystemExit(f"not a git repository: {repo}")


def sanitize_tag_for_branch(tag: str) -> str:
    return tag.replace("refs/tags/", "").replace(" ", "-")


def parse_ls_remote_tags(output: str) -> dict[str, str]:
    tags: dict[str, str] = {}
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        sha, ref = line.split("\t", 1)
        if ref.startswith("refs/tags/"):
            tags[ref.removeprefix("refs/tags/")] = sha
    return tags


def version_sort_key(tag: str) -> tuple[object, ...]:
    parts = re.split(r"(\d+)", tag)
    key: list[object] = []
    for part in parts:
        if not part:
            continue
        key.append(int(part) if part.isdigit() else part)
    return tuple(key)


def get_upstream_tags(git: GitRepo, remote: str) -> dict[str, str]:
    return parse_ls_remote_tags(git.output("ls-remote", "--tags", "--refs", remote))


def get_latest_upstream_tag(upstream_tags: dict[str, str]) -> str | None:
    if not upstream_tags:
        return None
    return sorted(upstream_tags, key=version_sort_key, reverse=True)[0]


def resolve_commit(git: GitRepo, ref: str) -> str:
    return git.output("rev-parse", f"{ref}^{{commit}}")


def ref_exists(git: GitRepo, ref: str) -> bool:
    proc = git.run("rev-parse", "--verify", f"{ref}^{{commit}}", check=False)
    return proc.returncode == 0


def has_uncommitted_changes(git: GitRepo) -> bool:
    return bool(git.run("status", "--porcelain", check=False).stdout.strip())


def is_ancestor(git: GitRepo, ancestor: str, descendant: str) -> bool:
    proc = git.run("merge-base", "--is-ancestor", ancestor, descendant, check=False)
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    raise GitCommandError(["git", "merge-base", "--is-ancestor", ancestor, descendant], proc.returncode, proc.stdout, proc.stderr)


def current_ref(git: GitRepo) -> str:
    proc = git.run("symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    branch = proc.stdout.strip()
    if branch:
        return branch
    return git.output("rev-parse", "HEAD")


def restore_ref(git: GitRepo, ref: str) -> None:
    git.run("checkout", "--quiet", ref)


def plan_sync(args: argparse.Namespace) -> SyncResult:
    repo = Path(args.repo).resolve()
    ensure_git_repo(repo)
    git = GitRepo(repo)

    original_ref = current_ref(git)
    restore_original_ref = True
    work_branch: str | None = None

    try:
        git.run("fetch", args.upstream_remote, "--tags", "--force")
        upstream_tags = get_upstream_tags(git, args.upstream_remote)
        target_tag = args.target_tag or get_latest_upstream_tag(upstream_tags)
        if not target_tag:
            fork_head = resolve_commit(git, args.fork_branch)
            if args.target_tag:
                return SyncResult(
                    ok=False,
                    upstream_tag=args.target_tag,
                    fork_branch=args.fork_branch,
                    work_branch=f"{args.work_branch_prefix}{sanitize_tag_for_branch(args.target_tag)}",
                    merge_status="invalid-tag",
                    upstream_commit=None,
                    fork_head_before=fork_head,
                    fork_head_after=fork_head,
                    dry_run=args.dry_run,
                    guidance=f"Upstream tag not found on remote {args.upstream_remote}: {args.target_tag}",
                    planned_actions=[],
                )
            return SyncResult(
                ok=True,
                upstream_tag=None,
                fork_branch=args.fork_branch,
                work_branch=None,
                merge_status="no-new-tag",
                upstream_commit=None,
                fork_head_before=fork_head,
                fork_head_after=fork_head,
                dry_run=args.dry_run,
                guidance="No upstream tags were found.",
                planned_actions=[],
            )
        if target_tag not in upstream_tags:
            fork_head = resolve_commit(git, args.fork_branch)
            return SyncResult(
                ok=False,
                upstream_tag=target_tag,
                fork_branch=args.fork_branch,
                work_branch=f"{args.work_branch_prefix}{sanitize_tag_for_branch(target_tag)}",
                merge_status="invalid-tag",
                upstream_commit=None,
                fork_head_before=fork_head,
                fork_head_after=fork_head,
                dry_run=args.dry_run,
                guidance=(
                    f"Requested upstream tag was not found on remote {args.upstream_remote}: {target_tag}. "
                    "Local-only tags are not valid release sources."
                ),
                planned_actions=[],
            )

        work_branch = f"{args.work_branch_prefix}{sanitize_tag_for_branch(target_tag)}"
        upstream_commit = upstream_tags[target_tag]
        fork_head_before = resolve_commit(git, args.fork_branch)

        if is_ancestor(git, upstream_commit, fork_head_before):
            return SyncResult(
                ok=True,
                upstream_tag=target_tag,
                fork_branch=args.fork_branch,
                work_branch=work_branch,
                merge_status="already-contained",
                upstream_commit=upstream_commit,
                fork_head_before=fork_head_before,
                fork_head_after=fork_head_before,
                dry_run=args.dry_run,
                guidance="Fork main already contains the selected upstream tag.",
                planned_actions=[],
            )

        planned_actions = [
            f"fetch {args.upstream_remote} tags",
            f"create/update {work_branch} from {args.fork_branch}",
            f"merge upstream tag {target_tag} into {work_branch}",
        ]

        if args.dry_run:
            return SyncResult(
                ok=True,
                upstream_tag=target_tag,
                fork_branch=args.fork_branch,
                work_branch=work_branch,
                merge_status="planned",
                upstream_commit=upstream_commit,
                fork_head_before=fork_head_before,
                fork_head_after=fork_head_before,
                dry_run=True,
                guidance="Dry run only: no branch updates or merge were performed.",
                planned_actions=planned_actions,
            )

        if has_uncommitted_changes(git):
            return SyncResult(
                ok=False,
                upstream_tag=target_tag,
                fork_branch=args.fork_branch,
                work_branch=work_branch,
                merge_status="blocked-dirty-worktree",
                upstream_commit=upstream_commit,
                fork_head_before=fork_head_before,
                fork_head_after=fork_head_before,
                dry_run=False,
                guidance="Working tree is not clean. Commit or stash changes before resetting the work branch.",
                planned_actions=planned_actions,
            )

        git.run("checkout", "--quiet", "-B", work_branch, args.fork_branch)
        merge_proc = git.run("merge", "--no-ff", "--no-edit", upstream_commit, check=False)
        if merge_proc.returncode != 0:
            conflict_files = [
                line.strip()
                for line in git.output("diff", "--name-only", "--diff-filter=U").splitlines()
                if line.strip()
            ]
            restore_original_ref = False
            return SyncResult(
                ok=False,
                upstream_tag=target_tag,
                fork_branch=args.fork_branch,
                work_branch=work_branch,
                merge_status="conflict",
                upstream_commit=upstream_commit,
                fork_head_before=fork_head_before,
                fork_head_after=fork_head_before,
                dry_run=False,
                guidance=(
                    "Merge conflict detected. The merge has been left in progress on the work branch for manual resolution. "
                    f"Resolve conflicts on {work_branch} and commit the merge, or abort it manually with: git merge --abort"
                ),
                conflict_files=conflict_files,
                planned_actions=planned_actions,
            )

        fork_head_after = resolve_commit(git, "HEAD")
        return SyncResult(
            ok=True,
            upstream_tag=target_tag,
            fork_branch=args.fork_branch,
            work_branch=work_branch,
            merge_status="merged",
            upstream_commit=upstream_commit,
            fork_head_before=fork_head_before,
            fork_head_after=fork_head_after,
            dry_run=False,
            guidance="Local work branch updated successfully. Review and push manually if desired.",
            planned_actions=planned_actions,
        )
    finally:
        if restore_original_ref:
            try:
                restore_ref(git, original_ref)
            except Exception:
                pass


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = plan_sync(args)
    except GitCommandError as exc:
        failure = SyncResult(
            ok=False,
            upstream_tag=args.target_tag,
            fork_branch=args.fork_branch,
            work_branch=(f"{args.work_branch_prefix}{sanitize_tag_for_branch(args.target_tag)}" if args.target_tag else None),
            merge_status="conflict" if "CONFLICT" in exc.stderr else "git-error",
            upstream_commit=None,
            fork_head_before=None,
            fork_head_after=None,
            dry_run=args.dry_run,
            guidance=exc.stderr.strip() or exc.stdout.strip() or str(exc),
        )
        print(failure.to_json())
        return 1
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover - defensive CLI guard
        failure = SyncResult(
            ok=False,
            upstream_tag=args.target_tag,
            fork_branch=args.fork_branch,
            work_branch=(f"{args.work_branch_prefix}{sanitize_tag_for_branch(args.target_tag)}" if args.target_tag else None),
            merge_status="git-error",
            upstream_commit=None,
            fork_head_before=None,
            fork_head_after=None,
            dry_run=args.dry_run,
            guidance=str(exc),
        )
        print(failure.to_json())
        return 1

    print(result.to_json())
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
