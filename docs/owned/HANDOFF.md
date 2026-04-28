# Owned fork handoff protocol

A handoff is not complete until the next owner can continue without guessing.

## Required fields

Every owned-fork handoff must include:

- Scope: what was requested and what was explicitly out of scope.
- Files changed or inspected.
- Evidence: command outputs, test results, screenshots, artifact metadata, or review notes.
- Commands run, with pass/fail status.
- Commit references, branch name, and worktree status when git state matters.
- Open questions.
- Risks and rollback notes.
- Next owner and requested next action.

## Role expectations

- `dev-tl`: state priority, acceptance criteria, owner, dependencies, and escalation path.
- `shuri`: state requirements, API/product contract, non-goals, and acceptance criteria changes.
- `friday`, `wanda`, `loki`, `wong`: state implementation choices, changed files, verification, and review needs. Stay within specialty.
- `vision`: state QA plan, gates run, pass/fail evidence, unresolved risk, and release confidence.
- Release/operator: state branch, commit, package/tarball, checksum, install target, restart action, smoke result, promotion decision, and rollback path.

## Evidence rule

Do not say "done" without evidence. If a gate was not run, say why, identify the residual risk, and name the smallest next verification step.
