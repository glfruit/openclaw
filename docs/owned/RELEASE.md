# Owned release runbook

This runbook governs owned local releases. It does not publish upstream OpenClaw releases.

## Branch and scope

- Cut `owned/<version>` from a healthy `owned/main`.
- Record source branch, source commit, release branch, package version, and intended install target.
- Do not change package version, branch topology, remotes, or runtime behavior during release validation unless the release scope explicitly requires it.

## Tarball-first validation

1. Verify repository health and clean/expected worktree state.
2. Run the scoped source gates for the release contents.
3. Build the package artifacts.
4. Create the npm tarball into an explicit artifact directory.
5. Record tarball filename, path, checksum, package version, file count, and size.
6. Inspect package contents, including absence of `dist/extensions/**/node_modules`.
7. Install the tarball into a fresh temporary prefix and run packaged CLI smoke checks.

## Separate promotion steps

Keep these actions separate and record evidence for each:

- Build/package: create and validate the tarball.
- Install: install only the validated tarball into the intended local target.
- Restart: restart Gateway or related services only after install evidence is accepted.
- Promote: route production traffic or declare the package active only after local smoke evidence is recorded.

## Local promotion evidence

Promotion evidence must include:

- Branch and commit.
- Package version.
- Tarball path and checksum.
- Install command and target.
- `openclaw --version` from the installed package.
- Gateway restart command and status result, when a restart is performed.
- Smoke test command and result.
- Owner who approved promotion.

## Rollback

Before promotion, record the previous installed package/version and service state. Rollback means reinstalling the previous known-good package or restoring the previous install target, then restarting only the affected service and rerunning the smoke check.

## Records

Release records must be durable enough for another operator to audit: branch, commit, package, checksum, commands, results, risks, and rollback path.
