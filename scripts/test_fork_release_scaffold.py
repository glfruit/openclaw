#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SYNC_SCRIPT = REPO_ROOT / "scripts" / "fork_sync_upstream_release.py"
BUILD_SCRIPT = REPO_ROOT / "scripts" / "fork_build_release.py"


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=check, env=env)


def git(cwd: Path, *args: str) -> str:
    return run(["git", *args], cwd=cwd).stdout.strip()


def write_fake_package_manager(bin_dir: Path) -> Path:
    script_path = bin_dir / "fakepm"
    script_path.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import json
            import os
            import sys
            from pathlib import Path

            def main() -> int:
                args = sys.argv[1:]
                if not args:
                    return 1
                if args[0] == 'build':
                    Path('build-ran.txt').write_text('ok\\n')
                    return 0
                if args[0] != 'pack':
                    print(f'unsupported args: {args}', file=sys.stderr)
                    return 2
                dest = None
                for index, arg in enumerate(args):
                    if arg == '--pack-destination' and index + 1 < len(args):
                        dest = Path(args[index + 1])
                        break
                if dest is None:
                    print('missing --pack-destination', file=sys.stderr)
                    return 2
                dest.mkdir(parents=True, exist_ok=True)
                tarball = dest / 'openclaw-1.2.3.tgz'
                tarball.write_bytes(b'fork-release-tarball\\n')
                filename_mode = os.environ.get('FAKEPM_FILENAME_MODE', 'basename')
                if filename_mode == 'absolute':
                    filename = str(tarball.resolve())
                elif filename_mode == 'repo-relative':
                    filename = str(tarball.relative_to(Path.cwd()))
                else:
                    filename = tarball.name
                payload = {'filename': filename}
                if os.environ.get('FAKEPM_PACK_JSON_MODE', 'array') == 'object':
                    print(json.dumps(payload))
                else:
                    print(json.dumps([payload]))
                return 0

            raise SystemExit(main())
            """
        )
    )
    script_path.chmod(0o755)
    return script_path


class ForkReleaseScaffoldTests(unittest.TestCase):
    def test_sync_help(self) -> None:
        proc = subprocess.run(["python3", str(SYNC_SCRIPT), "--help"], text=True, capture_output=True, check=True)
        self.assertIn("--dry-run", proc.stdout)
        self.assertIn("example:", proc.stdout)

    def test_build_help(self) -> None:
        proc = subprocess.run(["python3", str(BUILD_SCRIPT), "--help"], text=True, capture_output=True, check=True)
        self.assertIn("--dry-run", proc.stdout)
        self.assertIn("examples:", proc.stdout)

    def test_build_dry_run_emits_stable_json_with_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                ["python3", str(BUILD_SCRIPT), "--repo", str(repo), "--dry-run"],
                text=True,
                capture_output=True,
                check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["dry_run"])
            self.assertEqual(payload["package_name"], "openclaw")
            self.assertEqual(payload["release_tag"], "v1.2.3")
            self.assertEqual(payload["tarball_path"], None)
            expected_tarball_path = repo / "artifacts" / "fork-release" / "openclaw-1.2.3.tgz"
            self.assertIn("gh release create", payload["github_release_command"])
            self.assertIn(str(expected_tarball_path.resolve()), payload["github_release_command"])
            self.assertIn("version_contract", payload)
            self.assertEqual(payload["version_contract"]["release_tag"], "v1.2.3")
            self.assertEqual(payload["version_contract"]["package_version"], "1.2.3")
            self.assertEqual(payload["version_contract"]["tarball_filename"], "openclaw-1.2.3.tgz")
            self.assertEqual(payload["version_contract"]["github_asset_name"], "openclaw-1.2.3.tgz")

    def test_build_non_dry_run_accepts_array_output_with_relative_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            bin_dir = root / "bin"
            repo.mkdir()
            bin_dir.mkdir()
            write_fake_package_manager(bin_dir)
            (repo / "package.json").write_text(
                json.dumps({"name": "openclaw", "version": "1.2.3", "packageManager": "fakepm@1.0.0"})
            )
            env = os.environ.copy()
            env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
            env["FAKEPM_PACK_JSON_MODE"] = "array"
            env["FAKEPM_FILENAME_MODE"] = "basename"

            proc = run(["python3", str(BUILD_SCRIPT), "--repo", str(repo)], cwd=repo, env=env)
            payload = json.loads(proc.stdout)
            tarball_path = repo / "artifacts" / "fork-release" / "openclaw-1.2.3.tgz"

            self.assertTrue(payload["ok"])
            self.assertFalse(payload["dry_run"])
            self.assertEqual(payload["tarball_path"], str(tarball_path.resolve()))
            self.assertEqual(payload["tarball_sha256"], hashlib.sha256(b"fork-release-tarball\n").hexdigest())
            self.assertIn(str(tarball_path.resolve()), payload["github_release_command"])
            self.assertTrue((repo / "build-ran.txt").exists())
            self.assertTrue((repo / "artifacts" / "fork-release" / "release-notes.md").exists())

    def test_build_non_dry_run_accepts_object_output_with_absolute_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            bin_dir = root / "bin"
            repo.mkdir()
            bin_dir.mkdir()
            write_fake_package_manager(bin_dir)
            (repo / "package.json").write_text(
                json.dumps({"name": "openclaw", "version": "1.2.3", "packageManager": "fakepm@1.0.0"})
            )
            env = os.environ.copy()
            env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
            env["FAKEPM_PACK_JSON_MODE"] = "object"
            env["FAKEPM_FILENAME_MODE"] = "absolute"

            proc = run(["python3", str(BUILD_SCRIPT), "--repo", str(repo), "--skip-build"], cwd=repo, env=env)
            payload = json.loads(proc.stdout)
            tarball_path = repo / "artifacts" / "fork-release" / "openclaw-1.2.3.tgz"

            self.assertTrue(payload["ok"])
            self.assertFalse(payload["dry_run"])
            self.assertEqual(payload["tarball_path"], str(tarball_path.resolve()))
            self.assertEqual(payload["tarball_sha256"], hashlib.sha256(b"fork-release-tarball\n").hexdigest())
            self.assertIn(str(tarball_path.resolve()), payload["github_release_command"])
            self.assertFalse((repo / "build-ran.txt").exists())

    def test_build_version_override_dry_run_emits_contract_with_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                ["python3", str(BUILD_SCRIPT), "--repo", str(repo), "--dry-run", "--version-override", "2.0.0"],
                text=True,
                capture_output=True,
                check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["package_version"], "2.0.0")
            self.assertEqual(payload["release_tag"], "v2.0.0")
            self.assertEqual(payload["version_contract"]["version_override"], "2.0.0")
            self.assertEqual(payload["version_contract"]["original_package_version"], "1.2.3")
            self.assertEqual(payload["version_contract"]["tarball_filename"], "openclaw-2.0.0.tgz")
            self.assertIn("openclaw-2.0.0.tgz", payload["github_release_command"])

    def test_build_rejects_tag_version_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                ["python3", str(BUILD_SCRIPT), "--repo", str(repo), "--dry-run", "--release-tag", "v9.9.9"],
                text=True,
                capture_output=True,
                check=False,
            )
            payload = json.loads(proc.stdout)
            self.assertFalse(payload["ok"])
            self.assertIn("version contract mismatch", payload["guidance"])
            self.assertIn("error", payload["version_contract"])

    def test_build_normalizes_bare_release_tag_to_canonical_v_tag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                [
                    "python3",
                    str(BUILD_SCRIPT),
                    "--repo",
                    str(repo),
                    "--dry-run",
                    "--release-tag",
                    "1.2.3",
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["release_tag"], "v1.2.3")
            self.assertIn("gh release create v1.2.3", payload["github_release_command"])
            self.assertEqual(payload["version_contract"]["release_tag"], "v1.2.3")

    def test_build_rejects_invalid_explicit_release_tag_without_override_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                [
                    "python3",
                    str(BUILD_SCRIPT),
                    "--repo",
                    str(repo),
                    "--dry-run",
                    "--release-tag",
                    "not-a-tag",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            payload = json.loads(proc.stdout)
            self.assertEqual(proc.returncode, 1)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["release_tag"], "not-a-tag")
            self.assertIn("release tag is not a valid semver tag: not-a-tag", payload["guidance"])
            self.assertIn("error", payload["version_contract"])

    def test_build_rejects_invalid_explicit_release_tag_with_override_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                [
                    "python3",
                    str(BUILD_SCRIPT),
                    "--repo",
                    str(repo),
                    "--dry-run",
                    "--release-tag",
                    "not-a-tag",
                    "--version-override",
                    "2026.4.21",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            payload = json.loads(proc.stdout)
            self.assertEqual(proc.returncode, 1)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["release_tag"], "not-a-tag")
            self.assertIn("release tag is not a valid semver tag: not-a-tag", payload["guidance"])
            self.assertIn("error", payload["version_contract"])

    def test_build_version_override_allows_tag_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps(
                    {
                        "name": "openclaw",
                        "version": "1.2.3",
                        "packageManager": "pnpm@10.0.0",
                    }
                )
            )
            proc = subprocess.run(
                ["python3", str(BUILD_SCRIPT), "--repo", str(repo), "--dry-run", "--release-tag", "v9.9.9", "--version-override", "9.9.9"],
                text=True,
                capture_output=True,
                check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["package_version"], "9.9.9")
            self.assertEqual(payload["version_contract"]["tarball_filename"], "openclaw-9.9.9.tgz")

    def test_sync_dry_run_plans_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            upstream_bare = root / "upstream.git"
            origin_bare = root / "origin.git"
            upstream_work = root / "upstream-work"
            fork_seed = root / "fork-seed"
            fork_local = root / "fork-local"

            run(["git", "init", "--bare", str(upstream_bare)], cwd=root)
            run(["git", "init", "--bare", str(origin_bare)], cwd=root)

            run(["git", "clone", str(upstream_bare), str(upstream_work)], cwd=root)
            git(upstream_work, "config", "user.name", "Test User")
            git(upstream_work, "config", "user.email", "test@example.com")
            (upstream_work / "README.md").write_text("base\n")
            git(upstream_work, "add", "README.md")
            git(upstream_work, "commit", "-m", "base")
            git(upstream_work, "branch", "-M", "main")
            git(upstream_work, "push", "origin", "main")
            git(upstream_work, "tag", "v1.0.0")
            git(upstream_work, "push", "origin", "v1.0.0")

            run(["git", "clone", str(upstream_bare), str(fork_seed)], cwd=root)
            git(fork_seed, "config", "user.name", "Test User")
            git(fork_seed, "config", "user.email", "test@example.com")
            git(fork_seed, "remote", "remove", "origin")
            git(fork_seed, "remote", "add", "origin", str(origin_bare))
            git(fork_seed, "push", "origin", "main")

            (upstream_work / "README.md").write_text("base\nnext\n")
            git(upstream_work, "add", "README.md")
            git(upstream_work, "commit", "-m", "next")
            git(upstream_work, "tag", "v1.1.0")
            git(upstream_work, "push", "origin", "main")
            git(upstream_work, "push", "origin", "v1.1.0")

            run(["git", "clone", str(origin_bare), str(fork_local)], cwd=root)
            git(fork_local, "config", "user.name", "Test User")
            git(fork_local, "config", "user.email", "test@example.com")
            git(fork_local, "remote", "add", "upstream", str(upstream_bare))
            git(fork_local, "fetch", "origin")
            git(fork_local, "fetch", "upstream", "--tags")
            git(fork_local, "checkout", "-B", "main", "origin/main")

            proc = subprocess.run(
                [
                    "python3",
                    str(SYNC_SCRIPT),
                    "--repo",
                    str(fork_local),
                    "--fork-branch",
                    "main",
                    "--target-tag",
                    "v1.1.0",
                    "--dry-run",
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["dry_run"])
            self.assertEqual(payload["upstream_tag"], "v1.1.0")
            self.assertEqual(payload["work_branch"], "release-sync/v1.1.0")
            self.assertEqual(payload["merge_status"], "planned")
            self.assertEqual(payload["fork_head_before"], payload["fork_head_after"])
            self.assertEqual(git(fork_local, "rev-parse", "--abbrev-ref", "HEAD"), "main")
            self.assertEqual(git(fork_local, "rev-parse", "HEAD"), payload["fork_head_before"])

    def test_sync_rejects_local_only_target_tag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            upstream_bare = root / "upstream.git"
            origin_bare = root / "origin.git"
            upstream_work = root / "upstream-work"
            fork_seed = root / "fork-seed"
            fork_local = root / "fork-local"

            run(["git", "init", "--bare", str(upstream_bare)], cwd=root)
            run(["git", "init", "--bare", str(origin_bare)], cwd=root)

            run(["git", "clone", str(upstream_bare), str(upstream_work)], cwd=root)
            git(upstream_work, "config", "user.name", "Test User")
            git(upstream_work, "config", "user.email", "test@example.com")
            (upstream_work / "README.md").write_text("base\n")
            git(upstream_work, "add", "README.md")
            git(upstream_work, "commit", "-m", "base")
            git(upstream_work, "branch", "-M", "main")
            git(upstream_work, "push", "origin", "main")
            git(upstream_work, "tag", "v1.0.0")
            git(upstream_work, "push", "origin", "v1.0.0")

            run(["git", "clone", str(upstream_bare), str(fork_seed)], cwd=root)
            git(fork_seed, "config", "user.name", "Test User")
            git(fork_seed, "config", "user.email", "test@example.com")
            git(fork_seed, "remote", "remove", "origin")
            git(fork_seed, "remote", "add", "origin", str(origin_bare))
            git(fork_seed, "push", "origin", "main")

            run(["git", "clone", str(origin_bare), str(fork_local)], cwd=root)
            git(fork_local, "config", "user.name", "Test User")
            git(fork_local, "config", "user.email", "test@example.com")
            git(fork_local, "remote", "add", "upstream", str(upstream_bare))
            git(fork_local, "fetch", "origin")
            git(fork_local, "fetch", "upstream", "--tags")
            git(fork_local, "checkout", "-B", "main", "origin/main")
            git(fork_local, "tag", "local-only-tag")

            proc = run(
                [
                    "python3",
                    str(SYNC_SCRIPT),
                    "--repo",
                    str(fork_local),
                    "--fork-branch",
                    "main",
                    "--target-tag",
                    "local-only-tag",
                    "--dry-run",
                ],
                cwd=fork_local,
                check=False,
            )
            payload = json.loads(proc.stdout)

            self.assertEqual(proc.returncode, 1)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["merge_status"], "invalid-tag")
            self.assertEqual(payload["upstream_tag"], "local-only-tag")
            self.assertIn("Local-only tags are not valid release sources", payload["guidance"])
            self.assertEqual(git(fork_local, "rev-parse", "--abbrev-ref", "HEAD"), "main")

    def test_sync_non_dry_run_leaves_conflicted_merge_for_manual_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            upstream_bare = root / "upstream.git"
            origin_bare = root / "origin.git"
            upstream_work = root / "upstream-work"
            fork_seed = root / "fork-seed"
            fork_local = root / "fork-local"

            run(["git", "init", "--bare", str(upstream_bare)], cwd=root)
            run(["git", "init", "--bare", str(origin_bare)], cwd=root)

            run(["git", "clone", str(upstream_bare), str(upstream_work)], cwd=root)
            git(upstream_work, "config", "user.name", "Test User")
            git(upstream_work, "config", "user.email", "test@example.com")
            (upstream_work / "README.md").write_text("shared\n")
            git(upstream_work, "add", "README.md")
            git(upstream_work, "commit", "-m", "base")
            git(upstream_work, "branch", "-M", "main")
            git(upstream_work, "push", "origin", "main")
            git(upstream_work, "tag", "v1.0.0")
            git(upstream_work, "push", "origin", "v1.0.0")

            run(["git", "clone", str(upstream_bare), str(fork_seed)], cwd=root)
            git(fork_seed, "config", "user.name", "Test User")
            git(fork_seed, "config", "user.email", "test@example.com")
            git(fork_seed, "remote", "remove", "origin")
            git(fork_seed, "remote", "add", "origin", str(origin_bare))
            git(fork_seed, "push", "origin", "main")

            (upstream_work / "README.md").write_text("upstream change\n")
            git(upstream_work, "add", "README.md")
            git(upstream_work, "commit", "-m", "upstream change")
            git(upstream_work, "tag", "v1.1.0")
            git(upstream_work, "push", "origin", "main")
            git(upstream_work, "push", "origin", "v1.1.0")

            run(["git", "clone", str(origin_bare), str(fork_local)], cwd=root)
            git(fork_local, "config", "user.name", "Test User")
            git(fork_local, "config", "user.email", "test@example.com")
            git(fork_local, "remote", "add", "upstream", str(upstream_bare))
            git(fork_local, "fetch", "origin")
            git(fork_local, "fetch", "upstream", "--tags")
            git(fork_local, "checkout", "-B", "main", "origin/main")
            (fork_local / "README.md").write_text("fork change\n")
            git(fork_local, "add", "README.md")
            git(fork_local, "commit", "-m", "fork change")

            proc = run(
                [
                    "python3",
                    str(SYNC_SCRIPT),
                    "--repo",
                    str(fork_local),
                    "--fork-branch",
                    "main",
                    "--target-tag",
                    "v1.1.0",
                ],
                cwd=fork_local,
                check=False,
            )
            payload = json.loads(proc.stdout)

            self.assertEqual(proc.returncode, 1)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["merge_status"], "conflict")
            self.assertEqual(payload["work_branch"], "release-sync/v1.1.0")
            self.assertIn("left in progress", payload["guidance"])
            self.assertIn("README.md", payload["conflict_files"])
            self.assertEqual(git(fork_local, "rev-parse", "--abbrev-ref", "HEAD"), "release-sync/v1.1.0")
            self.assertIn("UU README.md", git(fork_local, "status", "--porcelain"))


if __name__ == "__main__":
    unittest.main()
