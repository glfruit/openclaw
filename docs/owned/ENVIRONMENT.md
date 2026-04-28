# Owned fork environment

Use this checklist for local development and maintenance of the owned OpenClaw fork.

## Runtime and package manager

- Node requirement follows the repo README/package metadata: Node 24 is recommended; Node 22.14+ is the minimum supported runtime.
- Use `pnpm` for source workflows.
- Run `pnpm install` after cloning or when dependencies change.
- Use `pnpm openclaw ...` for source CLI commands and `pnpm gateway:watch` for the local development loop.
- Use `pnpm build` and `pnpm ui:build` when a built `dist/` or package validation is required.

## Installed CLI verification

Before testing an installed CLI, record what is being tested:

```bash
which openclaw
openclaw --version
openclaw gateway status
```

Do not treat a globally installed CLI as proof that the current checkout or a new tarball works. For package validation, install the prepared tarball into a fresh temporary prefix and run the packaged binary there.

## Repository health checks

Before branch sync, release work, or destructive git operations:

```bash
git status --short
git branch --show-current
git rev-parse --verify HEAD
git fsck --full
```

If repository health is uncertain, stop branch operations and repair or reclone before syncing owned branches.

## Tarballs and artifacts

- Build artifacts must be explicit, local, and traceable to a branch and commit.
- Record tarball path, package version, file count, unpacked size, checksum, and validation commands.
- Package validation should be tarball-first: build, inspect, install into a temporary prefix, run `openclaw --version`, then perform the scoped smoke test.
- Packaging must not include `dist/extensions/**/node_modules` entries.

## Known local maintenance warning

This fork previously encountered unresolved git pack/delta health concerns. Before any branch sync, force update, release branch cut, or destructive git operation, verify repo health with `git fsck --full`. If pack/delta errors remain, use a fresh clone or repair the object database before continuing.
