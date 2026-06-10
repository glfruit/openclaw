import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function makePersistedJob(payload: Record<string, unknown>) {
  return {
    id: "legacy-command-job",
    name: "Legacy command job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

describe("getInvalidPersistedCronJobReason", () => {
  it("accepts legacy command payloads so they can be normalized after load", () => {
    expect(
      getInvalidPersistedCronJobReason(
        makePersistedJob({
          kind: "command",
          command: "/usr/bin/env",
          args: ["printf", "ok\\n"],
          successRegex: "ok",
        }),
      ),
    ).toBeNull();
  });

  it("still rejects command payloads without an executable", () => {
    expect(
      getInvalidPersistedCronJobReason(
        makePersistedJob({
          kind: "command",
          args: ["printf", "ok\\n"],
        }),
      ),
    ).toBe("invalid-payload");
  });
});
