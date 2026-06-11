// Codex app-server side-effect classifier tests.
import { describe, expect, it } from "vitest";
import { isLikelyMutatingShellCommand } from "./side-effect-classifier.js";

describe("isLikelyMutatingShellCommand", () => {
  it("treats Edu state and audit wrapper commands as read-only", () => {
    expect(
      isLikelyMutatingShellCommand("scripts/edu-python.sh scripts/edu_task_state.py --format text"),
    ).toBe(false);
    expect(
      isLikelyMutatingShellCommand(
        "gtimeout 45 scripts/edu-python.sh scripts/edu_task_system_audit.py --format text --fail-on error",
      ),
    ).toBe(false);
  });

  it("keeps Edu repair apply commands side-effectful", () => {
    expect(
      isLikelyMutatingShellCommand(
        "scripts/edu-python.sh scripts/edu_task_system_repair.py --apply --format text",
      ),
    ).toBe(true);
  });
});
