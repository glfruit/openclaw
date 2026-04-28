# Owned fork governance

This document is canonical for work on the owned OpenClaw fork. It does not change upstream OpenClaw policy.

## Branch model

- `main` is the upstream mirror. Keep it suitable for comparing with upstream OpenClaw.
- `owned/main` is the owned development trunk. Owned features, docs, packaging changes, and local operations work start here unless the release operator says otherwise.
- `owned/<version>` branches are owned release branches cut from `owned/main` for validation, packaging, and controlled promotion.
- Do not delete, force-push, rewrite, rebase, or rename protected owned or upstream-tracking branches until repository health is verified and the release/operator role approves the action.

## Roles and compliance

- `dev-tl` owns scope, sequencing, and cross-role handoff quality.
- `shuri` owns requirements, API/product fit, and acceptance criteria.
- `friday`, `wong`, `wanda`, and `loki` own implementation within their specialties and must not bypass review gates.
- `vision` owns QA evidence, regression risk, and release-readiness validation.
- Release/operator owns package promotion, install, restart, rollback, branch hygiene, and artifact records.
- Every role must read this file and the scoped owned doc for the task before changing the repo.

## Feature flow

1. Define scope, files, expected behavior, non-goals, and owner.
2. Start from `owned/main` unless the task is a release fix on `owned/<version>`.
3. Keep changes small and evidence-backed. Do not change runtime behavior from docs-only tasks.
4. Update owned docs when branch, packaging, release, handoff, or local operations policy changes.
5. Handoff with evidence using [`HANDOFF.md`](HANDOFF.md).

## Review, QA, and ship gates

- No work is done without evidence: changed files, commands, results, open risks, and next owner.
- Review must confirm scope control, upstream identity preservation, and no accidental package/runtime changes.
- QA must use the smallest meaningful gate for the touched surface, plus release-specific gates when packaging or promotion is involved.
- Shipping requires recorded branch, commit, package/tarball, checksum, install target, restart action, smoke result, and rollback path.

## Documentation ownership

- `docs/owned/*` documents owned-fork operations only.
- README files may summarize and link to owned docs, but must not duplicate full runbooks.
- Upstream-oriented docs must keep their upstream identity and only point to owned runbooks where the workflows differ.
