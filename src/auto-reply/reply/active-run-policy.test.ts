import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_RUN_STALE_MS,
  isAutonomousLane,
  resolveActiveRunStaleness,
  shouldSurfaceLiveQueuedBehindBackgroundedRun,
  shouldSurfaceLiveQueuedBehindStaleRun,
} from "./active-run-policy.js";

describe("active run stale policy", () => {
  it("marks active runs stale only after the last activity threshold", () => {
    const now = 1_000_000;

    expect(
      resolveActiveRunStaleness({
        now,
        staleMs: 60_000,
        state: {
          isActive: true,
          startedAt: now - 600_000,
          lastActivityAt: now - 59_000,
        },
      }).stale,
    ).toBe(false);

    const stale = resolveActiveRunStaleness({
      now,
      staleMs: 60_000,
      state: {
        isActive: true,
        startedAt: now - 600_000,
        lastActivityAt: now - 60_000,
      },
    });
    expect(stale.stale).toBe(true);
    expect(stale.lastActivityAgeMs).toBe(60_000);
  });

  it("uses a conservative default threshold", () => {
    expect(DEFAULT_ACTIVE_RUN_STALE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it("surfaces only recoverable live lanes behind stale runs", () => {
    expect(shouldSurfaceLiveQueuedBehindStaleRun({ lane: "live_user", activeRunStale: true })).toBe(
      true,
    );
    expect(
      shouldSurfaceLiveQueuedBehindStaleRun({ lane: "operator_recovery", activeRunStale: true }),
    ).toBe(true);
    expect(shouldSurfaceLiveQueuedBehindStaleRun({ lane: "cron", activeRunStale: true })).toBe(
      false,
    );
    expect(
      shouldSurfaceLiveQueuedBehindStaleRun({ lane: "live_user", activeRunStale: false }),
    ).toBe(false);
  });

  it("surfaces only recoverable live lanes behind visible backgrounded work", () => {
    expect(
      shouldSurfaceLiveQueuedBehindBackgroundedRun({
        lane: "live_user",
        visiblePendingBackgroundedWork: true,
      }),
    ).toBe(true);
    expect(
      shouldSurfaceLiveQueuedBehindBackgroundedRun({
        lane: "inter_session",
        visiblePendingBackgroundedWork: true,
      }),
    ).toBe(true);
    expect(
      shouldSurfaceLiveQueuedBehindBackgroundedRun({
        lane: "cron",
        visiblePendingBackgroundedWork: true,
      }),
    ).toBe(false);
    expect(
      shouldSurfaceLiveQueuedBehindBackgroundedRun({
        lane: "live_user",
        visiblePendingBackgroundedWork: false,
      }),
    ).toBe(false);
  });

  it("keeps heartbeat, cron, and maintenance autonomous", () => {
    expect(isAutonomousLane("heartbeat")).toBe(true);
    expect(isAutonomousLane("cron")).toBe(true);
    expect(isAutonomousLane("maintenance")).toBe(true);
    expect(isAutonomousLane("live_user")).toBe(false);
  });
});
